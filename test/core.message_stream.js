var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var sinon = require('sinon');
var MessageStream = require('../core/message_stream');
var Message = require('../core/message');

describe('core.MessageStream', function () {
  var stream = new MessageStream();

  describe('new MessageStream()', function () {
    it('should create a new message stream and is an EventEmitter', function (done) {
      assert(stream);
      assert(stream instanceof EventEmitter);
      assert(stream.isReady());
      assert(stream.received === 0);

      done();
    });
  });

  describe('stream.emitMessage(msg)', function () {
    var spy = sinon.spy();
    var msg = new Message({ big: 'plays' });

    beforeEach(function () {
      stream.emitMessage(msg);
      stream.on('message', spy);
    });

    it('should transition the stream into the `flowing` mode', function () {
      assert(stream.isFlowing());
    });

    it('should emit the message', function () {
      assert(spy.calledWithExactly(msg));
    });
  });

  describe('stream.close()', function () {
    var msg = new Message({ stuff: 10 });
    var spy = sinon.spy();

    it('should close the stream and not emit anymore messages', function () {
      stream.on('message', spy);
      stream.emitMessage(msg);
      stream.close();
      stream.emitMessage(msg);

      assert(spy.calledOnce);
      assert(spy.calledWithExactly(msg));
    });
  });
});