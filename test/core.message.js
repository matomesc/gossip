var assert = require('assert');
var sinon = require('sinon');
var Message = require('../core/message');

describe.only('core.Message', function () {
  describe('new Message()', function () {
    it('should create an empty message', function () {
      var m = new Message();
      assert(!m.data);
      assert(!m.raw);
    });
  });

  describe('new Message(object)', function () {
    it('should create a new message with object body', function () {
      var body = { human: false };
      var m = new Message(body);
      assert.deepEqual(m.data, body);
      assert(m.raw === null);
    });
  });

  describe('new Message(buffer)', function () {
    it('should create a new message with buffer body', function () {
      var body = new Buffer('{ "human": false }');
      var m = new Message(body);
      assert(m.raw === body);
      assert(m.data === undefined);
    });
  });

  describe('message.deserialize()', function () {
    it('should parse the raw buffer into an object', function () {
      var msg = { human: false };
      var body = new Buffer(JSON.stringify(msg));
      var m = new Message(body);

      m.deserialize();

      assert.deepEqual(m.get(), msg);
    });
  });

  describe('message.serialize()', function () {
    it('should stringify the object into a buffer', function () {
      var body = { human: false };
      var jsonBody = JSON.stringify(body);
      var m = new Message(body);

      assert(m.serialize().toString('utf8') === jsonBody);
    });
  });

  describe('message.get(path)', function () {
    it('should return the value at path', function () {
      var body = {
        a: 10,
        b: {
          c: 15
        }
      };
      var message = new Message(body);

      assert.deepEqual(message.get(), body);
      assert(message.get('a') === 10);
      assert(message.get('b.c') === 15);
      assert(message.get('a.b.c') === undefined);
    });
  });

  describe('message.set(path, value)', function () {
    it('should set the value at path', function () {
      var m = new Message({
        a: 10
      });
      m.set('a', 20);
      m.set('d', 10);
      m.set('b.c', 'asdf');
      assert(m.get('a') === 20);
      assert(m.get('d') === 10);
      assert(m.get('b.c') === 'asdf');
    });
  });
});