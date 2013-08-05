var assert = require('assert');
var sinon = require('sinon');
var zmq = require('zmq');
var Hub = require('../core/hub');

describe('core.Hub', function () {

  var hub;

  beforeEach(function (done) {
    hub = new Hub({
      id: 'a',
      router:'tcp://127.0.0.1:5000'
    });
    done();
  });

  afterEach(function (done) {
    hub.close(done);
  });

  describe('new Hub() with id and router endpoint', function () {
    it('should create a new hub with sane defaults', function (done) {
      assert(hub.id);
      assert(hub.routerEndpoint);
      assert(hub.routerEndpointType === 'tcp');
      assert(hub.pubEndpoint);
      assert(hub.pubEndpointType === 'tcp');
      assert(hub.routerSocket === null);
      assert(hub.pubSocket === null);
      assert(hub.subSocket === null);

      done();
    });
  });

  describe('hub.bind()', function () {

    var zmqStub;

    beforeEach(function () {
      var orig = zmq.socket;
      zmqStub = sinon.stub(zmq, 'socket', function () {
        var sock = orig.apply(zmq, arguments);
        sinon.spy(sock, 'setsockopt');
        sinon.stub(sock, 'bindSync');
        sinon.stub(sock, 'on');
        return sock;
      });
    });

    afterEach(function () {
      zmqStub.restore();
    });

    it('should generate a socket id for the router socket', function (done) {
      hub.bind();
      assert(hub.routerSocket.setsockopt.calledWith(
        zmq.options.identity,
        sinon.match.instanceOf(Buffer)
      ));
      done();
    });

    it('should bind the hub\'s pub and router sockets', function (done) {
      hub.bind();
      assert(hub.routerSocket.bindSync.calledWith(
        sinon.match.typeOf('string')
      ));
      assert(hub.pubSocket.bindSync.calledWith(
        sinon.match.typeOf('string')
      ));
      done();
    });

    it('should attach handlers for messages on the pub and router sockets', function (done) {
      hub.bind();
      assert(hub.routerSocket.on.calledOnce);
      assert(hub.pubSocket.on.calledOnce);
      done();
    });
  });

  describe('hub.close()', function () {
    var routerSpy;
    var pubSpy;
    var subSpy;
    var ackPrunerSpy;

    beforeEach(function (done) {
      hub.bind();

      routerSpy = sinon.spy(hub.routerSocket, 'close');
      pubSpy = sinon.spy(hub.pubSocket, 'close');
      subSpy = sinon.spy(hub.subSocket, 'close');
      ackPrunerSpy = sinon.spy(hub, '_stopAckPruner');

      hub.close(done);
    });

    it('should close the router, pub and sub sockets', function (done) {
      assert(routerSpy.calledOnce);
      assert(pubSpy.calledOnce);
      assert(subSpy.calledOnce);
      done();
    });

    it('should stop the ack pruner', function (done) {
      assert(ackPrunerSpy.calledOnce);
      done();
    });
  });

  describe('hub.handshake(otherHub)', function () {

    var otherHub;

    beforeEach(function (done) {
      hub.bind();
      otherHub = new Hub({
        id: 'b',
        router: 'tcp://127.0.0.1:6000'
      }).bind();
      done();
    });

    afterEach(function (done) {
      otherHub.close(done);
    });

    it('should connect the hub to the other hub', function (done) {
      hub.handshake(otherHub, function (err) {
        assert.ifError(err);
        done();
      });
    });
  });

});