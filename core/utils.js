var _random = Math.random;
var _floor = Math.floor;

exports.currentTime = function () {
  return new Date().getTime();
};

/**
 * Returns a random integer in the interval [a, b)
 * @param   {Number=0}        [a]
 * @param   {Number=10000000} [b]
 * @returns {Number}
 */
exports.randRange = function (a, b) {
  a = a || 0;
  b = b || 10000000;
  return _floor(a + _random() * b);
};