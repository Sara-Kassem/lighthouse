"use strict";require("./base.js");'use strict';global.tr.exportTo('tr.b',function(){var categoryPartsFor={};function getCategoryParts(category){var parts=categoryPartsFor[category];if(parts!==undefined)return parts;parts=category.split(',');categoryPartsFor[category]=parts;return parts;}return{getCategoryParts:getCategoryParts};});