//var assert = require('assert');
//var sinon = require('sinon');
//var Node = require('../').Node;
//var randRange = require('../core/utils').randRange;
//
//describe('core.Node', function () {
//  describe('new Node()', function () {
//    it('should create a new default node instance', function (done) {
//      var node = new Node();
//
//      assert(node);
//      assert(node.id);
//      assert(node.name);
//      assert(node.endpoints.router);
//      assert(node.endpoints.pub);
//      assert(node._routerSocket);
//      assert(node._pubSocket);
//      assert(node._subSocket);
//      assert(new RegExp('ipc:\/\/\/tmp\/router-' + node.id).test(node.endpoints.router));
//      assert(new RegExp('ipc:\/\/\/tmp\/pub-' + node.id).test(node.endpoints.pub));
//
//      done();
//    });
//
//    it('should use id, endpoints and name options, if provided', function (done) {
//      var router = 'ipc:///tmp/testrouter_' + randRange(),
//          pub = 'ipc:///tmp/testpub_' + randRange(),
//          id = 'dat-unique-id-' + randRange(),
//          name = 'kulper-belt-' + randRange();
//      var node = new Node({
//        id: id,
//        endpoints: {
//          router: router,
//          pub: pub
//        },
//        name: name
//      });
//
//      assert(node.id === id);
//      assert(node.name === name);
//      assert(node.endpoints.router === router);
//      assert(node.endpoints.pub === pub);
//
//      done();
//    });
//  });
//
//  describe('node.start()', function () {
//    var node;
//
//    beforeEach(function (done) {
//      node = new Node();
//      done();
//    });
//
//    afterEach(function (done) {
//      node.stop();
//      done();
//    });
//
//    it('should initialize sockets, internal listeners and emit `started`', function (done) {
//      var spySockets = sinon.spy(node, '_initSockets');
//      var spyListeners = sinon.spy(node, '_initListeners');
//      var spyStarted = sinon.spy();
//
//      node._on('started', spyStarted);
//      node.start();
//
//      assert(spySockets.calledOnce);
//      assert(spyListeners.calledOnce);
//      assert(spyStarted.calledOnce);
//
//      done();
//    });
//
//    it('should transition the node to the STARTED state', function (done) {
//      assert(node._state === Node.STOPPED);
//      node.start();
//      assert(node._state === Node.STARTED);
//      done();
//    });
//  });
//
//  describe('node.stop()', function () {
//    var node;
//
//    beforeEach(function (done) {
//      node = new Node();
//      done();
//    });
//
//    afterEach(function (done) {
//      node.stop();
//      done();
//    });
//
//    it('should close sockets, remove listeners, emit `stopped`', function (done) {
//      var spySockets = sinon.spy(node, '_closeSockets');
//      var spyListeners = sinon.spy(node, 'off');
//      var spyStopped = sinon.spy();
//
//      node._on('stopped', spyStopped);
//      node.start();
//      node.stop();
//
//      assert(spySockets.calledOnce);
//      assert(spyListeners.calledOnce);
//      assert(spyStopped.calledOnce);
//
//      done();
//    });
//
//    it('should transition the node to the STOPPED state', function (done) {
//      node.start();
//      assert(node._state === Node.STARTED);
//      node.stop();
//      assert(node._state === Node.STOPPED);
//      done();
//    });
//
//    it('should be idempotent', function (done) {
//      var spySockets = sinon.spy(node, '_closeSockets');
//      var spyListeners = sinon.spy(node, 'off');
//      var spyStopped = sinon.spy();
//
//      node._on('stopped', spyStopped);
//      node.start();
//      node.stop();
//
//      // should not do anything
//      node.stop();
//
//      assert(spySockets.calledOnce);
//      assert(spyListeners.calledOnce);
//      assert(spyStopped.calledOnce);
//
//      done();
//    });
//  });
//
//  describe('node.join()', function () {
//    it('should join the cluster of the other node', function (done) {
//      var nodeA = new Node({ id: 'A' });
//      var nodeB = new Node({ id: 'B' });
//      nodeA.start();
//      nodeB.start();
//
//      nodeA.join(nodeB, function (err) {
//        assert.ifError(err)
//      });
//
//      setTimeout(function () {
//        nodeA.stop();
//        nodeB.stop();
//        done();
//      }, 100);
//    });
//  });
//
//  describe('node.pause()', function () {
//
//  });
//
//  describe('node.unpause()', function () {
//
//  });
//
//  describe('node.on()', function () {
//
//  });
//
//  describe('node.off()', function () {
//
//  });
//
//  describe('node.send()', function () {
//
//  });
//
//  describe('node.sendTo()', function () {
//
//  });
//
//  describe('node.sendAll()', function () {
//
//  });
//
//
//
//});