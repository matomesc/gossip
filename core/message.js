/**
 * @param {Object|Buffer} [body=null]
 * @constructor
 */
function Message(body) {
  if (Buffer.isBuffer(body)) {
    this._obj = undefined;
    this._raw = body;
  } else {
    this._obj = (body === undefined ? null : body);
    this._raw = null;
  }
}

/**
 * Get the message body as an object.
 *
 * @returns {Object}
 */
Message.prototype.body = function () {
  if (this._obj === undefined && Buffer.isBuffer(this._raw)) {
    this._obj = JSON.parse(this._raw.toString('utf8'));
  }
  return this._obj;
};

/**
 * Get the message body as a buffer.
 *
 * @returns {Buffer}
 */
Message.prototype.raw = function () {
  if (!Buffer.isBuffer(this._raw)) {
    this._raw = new Buffer(JSON.stringify(this._obj));
  }
  return this._raw;
};

module.exports = Message;