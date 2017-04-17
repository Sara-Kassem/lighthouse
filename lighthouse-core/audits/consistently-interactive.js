/**
 * @license
 * Copyright 2017 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const Audit = require('./audit');
const TracingProcessor = require('../lib/traces/tracing-processor');
const Formatter = require('../report/formatter');

// Parameters (in ms) for log-normal CDF scoring. To see the curve:
//   https://www.desmos.com/calculator/uti67afozh
const SCORING_POINT_OF_DIMINISHING_RETURNS = 1700;
const SCORING_MEDIAN = 10000;
const SCORING_TARGET = 5000;

const REQUIRED_QUIET_WINDOW = 5000;
const ALLOWED_CONCURRENT_REQUESTS = 2;

const distribution = TracingProcessor.getLogNormalDistribution(
  SCORING_MEDIAN,
  SCORING_POINT_OF_DIMINISHING_RETURNS
);

class ConsistentlyInteractiveMetric extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'Performance',
      name: 'consistently-interactive',
      description: 'Consistently Interactive (beta)',
      helpText: 'The point at which most network resources have finished loading and the ' +
          'CPU is idle for a prolonged period.',
      optimalValue: SCORING_TARGET.toLocaleString() + 'ms',
      scoringMode: Audit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['traces', 'networkRecords']
    };
  }

  static _findNetworkQuietPeriods(networkRecords, traceOfTab) {
    const traceEnd = traceOfTab.timestamps.traceEnd;
    const timeBoundaries = networkRecords.reduce((boundaries, record) => {
      const scheme = record.parsedURL && record.parsedURL.scheme;
      if (scheme === 'data' || scheme === 'ws') {
        return boundaries;
      }

      // convert the network record timestamp to ms to line-up with traceOfTab
      boundaries.push({time: record.startTime * 1000, isStart: true});
      boundaries.push({time: record.endTime * 1000, isStart: false});
      return boundaries;
    }, []).sort((a, b) => a.time - b.time);

    let inflight = 0;
    let quietPeriodStart = 0;
    const quietPeriods = [];
    timeBoundaries.forEach(boundary => {
      if (boundary.isStart) {
        // we are exiting a quiet period
        if (inflight === ALLOWED_CONCURRENT_REQUESTS) {
          quietPeriods.push({start: quietPeriodStart, end: boundary.time});
          quietPeriodStart = Infinity;
        }
        inflight++;
      } else {
        inflight--;
        // we are entering a quiet period
        if (inflight <= ALLOWED_CONCURRENT_REQUESTS) {
          quietPeriodStart = Math.min(boundary.time, quietPeriodStart);
        }
      }
    });

    // Check if the trace ended in a quiet period
    if (quietPeriodStart !== Infinity) {
      quietPeriods.push({start: quietPeriodStart, end: traceEnd});
    }

    return quietPeriods;
  }

  static _findCPUQuietPeriods(longTasks, traceOfTab) {
    const navStartTsInMs = traceOfTab.timestamps.navigationStart;
    const traceEndTsInMs = traceOfTab.timestamps.traceEnd;
    if (longTasks.length === 0) {
      return [{start: 0, end: traceEndTsInMs}];
    }

    const quietPeriods = [];
    longTasks.forEach((task, index) => {
      if (index === 0) {
        quietPeriods.push({
          start: 0,
          end: task.start + navStartTsInMs,
        });
      }

      if (index === longTasks.length - 1) {
        quietPeriods.push({
          start: task.end + navStartTsInMs,
          end: traceEndTsInMs,
        });
      } else {
        quietPeriods.push({
          start: task.end + navStartTsInMs,
          end: longTasks[index + 1].start + navStartTsInMs,
        });
      }
    });

    return quietPeriods;
  }

  static findOverlappingQuietPeriods(longTasks, networkRecords, traceOfTab) {
    const FMPTsInMs = traceOfTab.timestamps.firstMeaningfulPaint;

    const networkQuietPeriods = this._findNetworkQuietPeriods(networkRecords, traceOfTab)
        .filter(period => period.end > FMPTsInMs + REQUIRED_QUIET_WINDOW &&
            period.end - period.start >= REQUIRED_QUIET_WINDOW);
    const cpuQuietPeriods = this._findCPUQuietPeriods(longTasks, traceOfTab)
        .filter(period => period.end > FMPTsInMs + REQUIRED_QUIET_WINDOW &&
            period.end - period.start >= REQUIRED_QUIET_WINDOW);

    const cpuQueue = cpuQuietPeriods.slice();
    const networkQueue = networkQuietPeriods.slice();

    // We will check for a CPU quiet period contained within a Network quiet period or vice-versa
    let cpuCandidate = cpuQueue.shift();
    let networkCandidate = networkQueue.shift();
    while (cpuCandidate && networkCandidate) {
      if (cpuCandidate.start >= networkCandidate.start) {
        // CPU starts later than network, it must be contained by network or we check the next network
        if (networkCandidate.end >= cpuCandidate.start + REQUIRED_QUIET_WINDOW) {
          return {
            cpuQuietPeriod: cpuCandidate,
            networkQuietPeriod: networkCandidate,
            cpuQuietPeriods,
            networkQuietPeriods,
          };
        } else {
          networkCandidate = networkQueue.shift();
        }
      } else {
        // Network starts later than CPU, it must be contained by CPU or we check the next CPU
        if (cpuCandidate.end >= networkCandidate.start + REQUIRED_QUIET_WINDOW) {
          return {
            cpuQuietPeriod: cpuCandidate,
            networkQuietPeriod: networkCandidate,
            cpuQuietPeriods,
            networkQuietPeriods,
          };
        } else {
          cpuCandidate = cpuQueue.shift();
        }
      }
    }

    const culprit = cpuCandidate ? 'Network' : 'CPU';
    throw new Error(`${culprit} did not quiet for at least 5s before the end of the trace.`);
  }

  /**
   * Identify the time the page is "consistently interactive"
   * @see https://docs.google.com/document/d/1GGiI9-7KeY3TPqS3YT271upUVimo-XiL5mwWorDUD4c/edit#
   *
   * @param {!Artifacts} artifacts
   * @return {!Promise<!AuditResult>}
   */
  static audit(artifacts) {
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const networkRecords = artifacts.networkRecords[Audit.DEFAULT_PASS];
    const computedTraceArtifacts = [
      artifacts.requestTracingModel(trace),
      artifacts.requestTraceOfTab(trace),
    ];

    return Promise.all(computedTraceArtifacts)
      .then(([traceModel, traceOfTab]) => {
        if (!traceOfTab.timestamps.firstMeaningfulPaint) {
          throw new Error('No firstMeaningfulPaint found in trace.');
        }

        const longTasks = TracingProcessor.getMainThreadTopLevelEvents(traceModel, trace)
            .filter(event => event.end - event.start >= 50);
        const quietPeriodInfo = this.findOverlappingQuietPeriods(longTasks, networkRecords,
            traceOfTab);
        const cpuQuietPeriod = quietPeriodInfo.cpuQuietPeriod;

        const timestamp = Math.max(
          cpuQuietPeriod.start,
          traceOfTab.timestamps.firstMeaningfulPaint,
          traceOfTab.timestamps.domContentLoaded
        );
        const timeInMs = timestamp - traceOfTab.timestamps.navigationStart;
        const extendedInfo = Object.assign(quietPeriodInfo, {timestamp, timeInMs});

        let score = 100 * distribution.computeComplementaryPercentile(timeInMs);
        // Clamp the score to 0 <= x <= 100.
        score = Math.min(100, score);
        score = Math.max(0, score);
        score = Math.round(score);

        const displayValue = Math.round(timeInMs / 10) * 10;
        return {
          score,
          rawValue: timeInMs,
          displayValue: `${displayValue.toLocaleString()}ms`,
          optimalValue: this.meta.optimalValue,
          extendedInfo: {
            value: extendedInfo,
            formatter: Formatter.SUPPORTED_FORMATS.NULL,
          }
        };
      });
  }
}

module.exports = ConsistentlyInteractiveMetric;