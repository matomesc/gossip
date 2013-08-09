var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

/**
 * Streams messages.
 *
 * Should this be a Readable stream?
 *
 * @class   MessageStream
 * @extends EventEmitter
 * @module  core
 * @constructor
 */
function MessageStream() {
  EventEmitter.call(this);

  this.received = 0;

  /**
   * The state of the stream.
   *
   * ```
   * 0 - ready
   * 1 - flowing
   * 2 - closed
   *
   * Valid transitions:
   * 0 -> 1
   * 1 -> 2
   * ```
   *
   * @property  state
   * @type      {number}
   */
  this.state = 0;
}
inherits(MessageStream, EventEmitter);

MessageStream.prototype.emitMessage = function (msg) {
  if (this.state === 0) {
    this.state = 1;
  } else if (this.isClosed()) {
    return;
  }

  this.received += 1;

  this.emit('message', msg);
};

MessageStream.prototype.close = function () {
  this.state = 2;
};

MessageStream.prototype.isClosed = function () {
  return this.state === 2;
};

MessageStream.prototype.isReady = function () {
  return this.state === 0;
};

MessageStream.prototype.isFlowing = function () {
  return this.state === 1;
};

module.exports = MessageStream;