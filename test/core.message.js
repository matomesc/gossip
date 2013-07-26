var assert = require('assert');
var sinon = require('sinon');
var Message = require('../core/message');

describe('core.Message', function () {
  describe('new Message()', function () {
    it('should create a new message with null body', function () {
      var m = new Message();
      assert(m._obj === null);
      assert(m._obj === null);
    });
  });

  describe('new Message(object)', function () {
    it('should create a new message with object body', function () {
      var body = { human: false };
      var m = new Message(body);
      assert.deepEqual(m._obj, body);
      assert(m._body === undefined);
    });
  });

  describe('new Message(buffer)', function () {
    it('should create a new message with buffer body', function () {
      var body = new Buffer('{ "human": false }');
      var m = new Message(body);
      assert(m._raw === body);
      assert(m._obj === undefined);
    });
  });

  describe('message.body()', function () {
    it('should be lazy and only parse once', function () {
      var msg = { human: false };
      var body = new Buffer(JSON.stringify(msg));
      var m = new Message(body);
      var spy = sinon.spy(JSON, 'parse');

      assert(m._obj === undefined);
      assert.deepEqual(m.body(), msg);
      assert.deepEqual(m._obj, msg);
      assert.deepEqual(m.body(), msg);
      assert(spy.calledOnce);
    });
  });

  describe('message.raw()', function () {
    it('should be lazy and only parse once', function () {
      var body = { human: false };
      var jsonBody = JSON.stringify(body);
      var m = new Message(body);
      var spy = sinon.spy(JSON, 'stringify');

      assert(m._obj === body);
      assert(m._raw === null);
      assert(m.raw().toString('utf8') === jsonBody);
      assert(m._raw.toString('utf8') === jsonBody);
      assert(m.raw().toString('utf8') === jsonBody);
      assert(spy.calledOnce);
    });
  });
});