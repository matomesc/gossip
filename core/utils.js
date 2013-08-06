var uuid = require('node-uuid');

/**
 * @class   utils
 * @module  core
 */

/**
 * Caches path pieces from calls to `utils.getPath()`
 *
 * @property  _pathCache
 * @type      Object
 * @private
 */
var _pathCache = {};

/**
 * @method  currentTime
 * @returns {Number}      Unix timestamp in milliseconds.
 * @static
 */
exports.currentTime = function () {
  return new Date().getTime();
};

/**
 * Get a random integer.
 *
 * Example:
 *
 * ```js
 * var arr = ['a', 'b', 'c'];
 *
 * // a random element from arr
 * var random = arr[randRange(arr.length)];
 * ```
 *
 * @method  randRange
 * @param   {Number=0}        [a]
 * @param   {Number=10000000} [b]
 * @returns {Number}          Random integer in the interval [a, b).
 * @static
 */
exports.randRange = function (a, b) {
  if (arguments.length === 1) {
    b = a;
    a = 0;
  } else if (arguments.length === 0) {
    a = 0;
    b = 10000000;
  }

  return Math.floor(a + Math.random() * b);
};

/**
 * Returns the value of a path.
 *
 * @method  getPath
 * @param   {Object}  object
 * @param   {String}  path
 * @returns {Object}  The value of `path` in `object`.
 * @static
 */
exports.getPath = function (object, path) {
  var pieces;

  if (_pathCache[path]) {
    pieces = _pathCache[path];
  } else {
    pieces = path.split('.');
    _pathCache[path] = pieces;
  }

  var current = object;

  for (var i = 0, len = pieces.length; i < len; i++) {
    current = (object === undefined || object === null) ? undefined : object[pieces[i]];
  }

  return current;
};

/**
 * Get uuid v4.
 *
 * @method  randomId
 * @returns {String}
 * @static
 */
exports.randomId = function () {
  return uuid.v4();
};

/**
 * @method  endpointType
 * @param   {String} endpoint
 * @returns {String} `tcp`, `ipc` or `inproc`
 */
exports.endpointType = function (endpoint) {
  if (endpoint.indexOf('tcp') === 0) {
    return 'tcp';
  } else if (endpoint.indexOf('ipc') === 0) {
    return 'ipc';
  } else if (endpoint.indexOf('inproc') === 0) {
    return 'inproc';
  }
};

/**
 * @property EMPTY_BUFFER
 * @type     {Buffer}
 */
exports.EMPTY_BUFFER = new Buffer('');