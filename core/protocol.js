var inherits = require('util').inherits;

inherits(BaseError, Error);
function BaseError(message) {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name;
  this.message = message || 'BaseError';
}

inherits(BadPayload, BaseError);
function BadPayload(message) {
  BaseError.call(this);
  this.message = message || 'BadPayload';
}

exports.errors = {
  BaseError: BaseError,
  BadPayload: BadPayload
};