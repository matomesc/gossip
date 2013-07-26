var Message = require('./message');

/**
 * Message factory.
 * @param {Object}  [options]
 * @param {Object}  [options.defaults]
 * @constructor
 */
function MessageFactory(options) {
  this.defaults = options || {};
}

var _ownProp = Object.hasOwnProperty;

/**
 * Build a message. Defaults are first applied, then `body`.
 *
 * @param   {Object}  body  message body
 * @returns {Message}
 */
MessageFactory.prototype.build = function (body) {
  var _body = {};
  var defaultsKey, bodyKey;

  // apply defaults
  for (defaultsKey in this.defaults) {
    if (_ownProp.call(this.defaults, defaultsKey)) {
      if (typeof this.defaults[defaultsKey] === 'function') {
        _body[defaultsKey] = this.defaults[defaultsKey]();
      } else {
        _body[defaultsKey] = this.defaults[defaultsKey];
      }
    }
  }

  // apply body parameter
  if (body) {
    for (bodyKey in body) {
      if (_ownProp.call(body, bodyKey)) {
        _body[bodyKey] = body[bodyKey];
      }
    }
  }

  return new Message(_body);
};

module.exports = MessageFactory;