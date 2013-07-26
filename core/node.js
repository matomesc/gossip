var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var zmq = require('zmq');
var uuid = require('node-uuid');
var __stack = require('callsite');
var utils = require('./utils');
var protocol = require('./protocol');
var Message = require('./message');
var MessageFactory = require('./message_factory');

var keys = Object.keys;

/**
 * The node is the building block of gossip.
 *
 * Each node consists of a hub. A hub an abstraction built out of a router and pub socket that allows
 * 1-N request-reply and fire-forget messaging.
 *
 * @class   Node
 * @module  core
 * @param   {Object} [options]
 * @param   {String} [options.id]                 Should uniquely identify the node in the cluster.
 * @param   {Object} [options.endpoints]
 * @param   {String} [options.endpoints.router]   The router socket to bind to (ipc://..., tcp://...).
 * @param   {String} [options.endpoints.pub]      The pub socket to bind to.
 * @param   {String} [options.name]               A name for the node, not necessarily unique.
 * @param   {Object} [options.keepalive]
 * @param   {Number} [options.keepalive.period]   How often to send keepalives to the cluster.
 * @constructor
 */
function Node(options) {
  this.id = (options && options.id) || uuid.v4();
  this.socketId = Node.buildSocketId(this.id);
  this.name = (options && options.name) || 'node-' + this.id;

  var endpoints = options && options.endpoints;

  this.endpoints = {
    router: (endpoints && endpoints.router) || 'ipc:///tmp/router-' + this.id,
    pub: (endpoints && endpoints.pub) || 'ipc:///tmp/pub-' + this.id
  };

  this.keepalive = {
    // how often this node will notify the cluster of it' liveness
    // if we don't send any keep alives
    // the node attempts to send 3 keepalives per period
    period: (options && options.keepalive && options.keepalive.period) || 1000
  };

  // message types that this node has subscribed through a call to `.on()`
  // by default every node is subscribed to a few internal messages:
  //
  // _ping: emitted when a new node in the cluster sends us their info, should reply with _pong
  // _pong: emitted when an existing node replies with the cluster info
  // _ka: emitted when receiving keepalives from other nodes
  //
  // internal subscriptions are created in `_initListeners()`
  //
  this.messages = {};

  this._msgFactory = new MessageFactory({
    id: uuid.v4,    // message id
    src: this.id    // node id
  });

  // the long we think it takes us to reply to message
  // nodes in the cluster will then expect you to reply within this time,
  // otherwise the sending node will retry
  // you can set the default by passing in `options.reply.period` or per message type
  // with `.on('something', { period: 5000 },  )`
  this._defaultReplyPeriod = (options && options.reply && options.reply.period) || 5000;

  // if we send a message and we expect a reply back, this is the max
  // number of retries we will automatically do before giving up
  // if the node that we expect a reply back from fails to heartbeat, then
  // we quit early
  this._defaultReplyAttempts = (options && options.reply && options.reply.attempts) || 3;

  // zmq sockets
  // these are initialized in `_initSockets()`
  this._routerSocket = zmq.socket('router');
  this._pubSocket = zmq.socket('pub');
  this._subSocket = zmq.socket('sub');

  // cluster map by node id
  this._cluster = {};

  // another map of the cluster, but by message type
  // used internally by `.send()` to load balance messages randomly
  this._clusterByMsg = {};

  // nodes that we are connected to by id
  this._connectedTo = {};

  this._clusterKeepalive = {};

  // will periodically check `this._clusterKeepalive` and remove nodes
  // whose keepalive expired
  this._keepalivePruneTimer = null;

  // this will periodically send keepalives to the cluster
  this._keepaliveSendTimer = null;

  this._internalEmitter = new EventEmitter();

  // this emits all messages received from the cluster
  // used by `.on()` and `.off()`
  this._msgEmitter = new EventEmitter();

  // we use these to prevent the slow joiner syndrome
  this._defaultPubDelay = 200; // milliseconds
  // any calls to `.send`
  this._pubQueue = [];
  this._shouldQueuePub = true;

  // internally used to save handlers for calls to other nodes
  this._pendingReplies = {};

  // if `.join()` is called before `.start()` then
  // we add all the nodes to the queue
  this._connectQueue = [];

  // clear the pub queue after the default delay expires
  // prevents slow joiner symptom of sub sockets
  setTimeout(this._clearPubQueue, this._defaultPubDelay);

  this._state = Node.STOPPED;
}

/*********************************************
 * Public API
 *********************************************/

/**
 * Starts the node.
 *
 * Internally, it initializes the sockets and internal listeners, transitions the node the `STARTED` state
 * and flushes queued `join()` calls.
 *
 * @method start
 * @return {Node}
 * @chainable
 */
Node.prototype.start = function () {
  if (this._state === Node.STOPPED) {
    this._initSockets();
    this._initListeners();
    this._state = Node.STARTED;
    this._emit('started');

    if (this._connectQueue.length) {
      this._drainConnectQueue();
    }
  }

  return this;
};

/**
 * Stops the node. Once a node is stopped, it can't be started again.
 * If you want to temporarily stop receiving messages, see `.pause()` and `.unpause()`.
 *
 * This removes all message listeners and the node transitions to the STOPPED state.
 *
 * @method stop
 * @return {Node}
 * @chainable
 */
Node.prototype.stop = function () {
  if (this._state !== Node.STOPPED) {
    this._closeSockets();
    this.off();
    this._state = Node.STOPPED;
    this._emit('stopped');
  }

  return this;
};

/**
 * Join a cluster.
 *
 * You must specifiy either a node object or the configuration of a node
 * already in the cluster.
 *
 * @param   {Object|Node} node
 * @param   {String}      node.id
 * @param   {String}      node.endpoints.router
 * @param   {String}      node.endpoints.pub
 * @param   {Function}    cb
 * @return  {Node}
 */
Node.prototype.join = function (node, cb) {
  var self = this;

  if (node instanceof Node) {
    node = node.getInfo();
  }

  if (self._state === Node.STOPPED) {
    // queue connects requests - these are eventually drained by `_drainConnectQueue()`
    self._connectQueue.push([node, cb]);
    return self;
  }

  self._addNodeToCluster(node);

//  self._logInfo('about to send _join message');

  self.sendTo(node.id, '_join', self.getInfo(), function (err, msg) {
//    self._logInfo('inside join()');
//    self._logInfo(err, msg);
    if (err) {
      self._removeNodeFromCluster(node.id);
      return cb(err);
    }

    // save the node that replied to us
    self._addNodeToCluster(msg.data.me);

    // contact the rest of the cluster
    var data = self.getInfo();
    keys(msg.data.cluster).forEach(function (id) {
      // don't connect to ourselves
      if (self.id === id) {
        return;
      }

      var other = msg.data.cluster[id];

      self._addNodeToCluster(other);

      self.sendTo(id, '_connect', data, function (err, msg) {
        if (err) {
          console.log('failed to connect to', id, ':');
          console.log(err.stack);
          self._disconnectNode(node);
        } else {
          self._addNodeToCluster(msg.data);
          console.log('connected to', id);
        }
      });
    });

    return cb(null);
  });

  return self;
};

// TODO
Node.prototype.pause = function () {

};

// TODO
Node.prototype.unpause = function () {

};

/**
 * Subscribe to messages from other nodes.
 *
 * @method  on
 * @param   {String}            type                The type of message.
 * @param   {Object|Function}   [options]
 * @param   {Number}            [options.period]    Maximum time another node will wait for an answer before retrying.
 * @param   {Number}            [options.attempts]  Maximum attempts
 * @param   {Function}          cb                  Callback to execute when a message is received.
 * @return  {Node}
 * @chainable
 */
Node.prototype.on = function (type, options, cb) {
  if (arguments.length === 2) {
    cb = options;
    options = {};
  }

  this._msgEmitter.on(type, cb);

  this.messages[type] = {
    period: (options && options.period) || this._defaultReplyPeriod,
    attempts: (options && options.attempts) || this._defaultReplyAttempts
  };

  return this;
};

/**
 * Unsubscribe from messages from other nodes.
 *
 * @param  {String}   [msgType] The type of message to unsubscribe from. If not specified,
 *                              unsubscribes from all messages.
 * @param  {Function} [cb]      The listener to remove. If not specified, removes all
 *                              listeners.
 * @return {Node}
 * @chainable
 */
Node.prototype.off = function (msgType, cb) {
  if (cb) {
    this._msgEmitter.removeListener(msgType, cb);
    if (this._msgEmitter.listeners(msgType).length === 0) {
      delete this.messages[msgType];
    }
  } else if (msgType) {
    this._msgEmitter.removeAllListeners(msgType);
    delete this.messages[msgType];
  } else {
    this._msgEmitter.removeAllListeners();
    this.messages = {};
  }

  return this;
};

/**
 * Send a message that will be load balanced across all other nodes that are
 * interested in the message.
 *
 * @param   {String}   type   The type of message to send.
 * @param   {Object}   data
 * @param   {Function} cb     Called with `(error, [reply])`
 * @return  {Node}
 * @chainable
 */
Node.prototype.send = function (type, data, cb) {
  if (!this._clusterByMsg[type]) {
    return cb(new Error('nobody cares about that message type'));
  }

  // randomly generate the id of the node we will send to
  var dest = utils.randRange(0, this._clusterByMsg[type].length);

  return this.sendTo(dest, type, data, cb);
};

/**
 * Send a message to a specific node.
 *
 * TODO: check if `cb.length === 1` and don't attach reply handler
 * TODO: this `.reply()` should delegate to the same method
 *
 * @param {String}    id
 * @param {String}    type
 * @param {*}         [data]
 * @param {Function}  cb
 * @chainable
 */
Node.prototype.sendTo = function (id, type, data, cb) {
  if (!this._cluster[id]) {
    return cb(new Error('no such node'));
  }

  if (arguments.length === 3) {
    cb = data;
    data = undefined;
  }

  var idBuf = this._cluster[id].socketId;
  var msg = this._msgFactory.build({
    dest: id,
    type: type,
    data: data
  });

//  this._logInfo('in sendTo():');
//  this._logInfo('arguments:', arguments);
//  this._logInfo('destination socket id:', idBuf.toString());
//  this._logInfo(msg);

//  console.log(idBuf);
//  console.log('sendTo():', msg.raw().toString());

  if (cb.length === 2) {
    this._addReplyHandler(msg.body(), cb);
  }

  this._sendRouter([idBuf, msg.raw()]);

  return this;
};

/**
 * Send a message to all nodes that are listening for message of type `type`.
 *
 * If you are expecting a reply, pass in a callback.
 *
 * @param  {String}   type
 * @param  {Object}   data
 * @param  {Function} [cb]
 * @return {Node}
 * @chainable
 */
Node.prototype.sendAll = function (type, data, cb) {
  var msg = this._msgFactory.build({
    dest: '_all',
    type: type,
    data: data
  });

  if (cb) {
    // TODO: since multiple nodes will be receiving our message
    // cb should be called with a stream
    this._addReplyHandler(msg, cb);
  }

  this._sendPub(msg.raw());

  return this;
};

/**
 * Send a reply to a message.
 *
 * TODO: refactor this and `.sendTo`
 *
 * @param {Object}    origMsg   The message that we want to reply to
 * @param {Object}    data      Data that we want to send
 * @param {Function}  cb        Called with `(error, [reply])`
 */
Node.prototype.reply = function (origMsg, data, cb) {
  if (!this._cluster[origMsg.src]) {
    return cb(new Error('no such node'));
  }

  if (arguments.length === 2) {
    cb = data;
    data = undefined;
  }

  var idBuf = Node.buildSocketId(origMsg.src);
  var msg = this._msgFactory.build({
    dest: origMsg.src,
    type: '_reply',
    data: data,
    parent: origMsg.id
  });

//  this._logInfo('reply():');
//  this._logInfo(arguments);

  if (cb.length === 2) {
    this._addReplyHandler(msg.body(), cb);
  }

  this._sendRouter([idBuf, msg.raw()]);
};

/**
 * Returns information about this node.
 *
 * @return {Object}
 */
Node.prototype.getInfo = function () {
  return {
    id: this.id,
    name: this.name,
    endpoints: this.endpoints,
    keepalive: this.keepalive,
    messages: this.messages
  };
};

/*********************************************
 * Private API
 *********************************************/

/**
 * Initialze listeners for protocol messages.
 *
 * @private
 */
Node.prototype._initListeners = function () {
  this.on('_join', this._onJoin.bind(this));
  this.on('_reply', this._onReply.bind(this));
  this.on('_connect', this._onConnect.bind(this));
  this.on('_ka', this._onKeepalive.bind(this));
  this.on('_leave', this._onLeave.bind(this));
};

/**
 * Initializes the pub and router sockets.
 *
 * @return {Node}
 * @private
 */
Node.prototype._initSockets = function () {
  this._routerSocket.setsockopt(zmq.options.identity, this.socketId);
  this._routerSocket.setsockopt(zmq.ZMQ_SNDHWM, 100000);
  this._routerSocket.setsockopt(zmq.ZMQ_RCVHWM, 100000);
  this._routerSocket.setsockopt(zmq.ZMQ_SNDBUF, 100000);
  this._routerSocket.setsockopt(zmq.ZMQ_RCVBUF, 100000);
  this._routerSocket.bindSync(this.endpoints.router);
  this._routerSocket.on('message', this._onRouterMessage.bind(this));

  this._r2 = zmq.socket('router');
  this._r2.on('message', this._onRouterMessage.bind(this));

  this._pubSocket.bindSync(this.endpoints.pub);
  this._subSocket.on('message', this._onSubMessage.bind(this));
};

/**
 * Called when the sub socket receives a message.
 *
 * Messages that node hasn't subscribed to with `.on()` will be ignored.
 *
 * Emits an event of type `msg.type` with the message.
 *
 * @param frame
 * @private
 */
Node.prototype._onSubMessage = function (frame) {
  var msg = new Message(frame);
  var body = msg.body();

  if (this._subscribedTo(body.type)) {
    this._msgEmitter.emit(body.type, body);
  }

//  this._log('info', '_onSubMessage(): received sub message')
//  this._log('info', frame.toString());
};

/**
 * Called when the node receives a message on router socket.
 *
 * @private
 */
Node.prototype._onRouterMessage = function (id, message) {
  var msg = new Message(message);
  var body = msg.body();

//  this._logInfo('_onRouterMessage(): received from %s:', id.toString());
//  this._logInfo(body);

  if (this.messages[body.type]) {
    this._msgEmitter.emit(body.type, body);
  }
};

Node.prototype._onReply = function (body) {
//  this._logInfo(this._pendingReplies);
//  this._logInfo('_onReply(): got reply:\n%j', body);
  if (!this._pendingReplies[body.parent]) {
    return;
  }

//  console.log(body);

//  this._logInfo(this._pendingReplies[body.parent].cbs[0].toString());

  var self = this;

  this._pendingReplies[body.parent].cbs.forEach(function (fn) {
    fn.call(self, null, body);
  });
};

Node.prototype._onJoin = function (body) {
  var self = this;

  this._addNodeToCluster(body.data);

  var data = { cluster: this._cluster, me: this.getInfo() };

  this.reply(body, data, function (err) {
    if (err) {
      self._logError('failed to reply to _join:');
      self._logError(err.stack);
    }
  });
};

Node.prototype._onConnect = function (msg) {
  var self = this;
  var data = this.getInfo();

  this._addNodeToCluster(msg.data);

  this.reply(msg, data, function (err) {
    if (err) {
      self._log('error', 'failed to reply to _connect:');
      self._log('error', err.stack);
    }
  });
};

Node.prototype._onLeave = function (msg) {
  this._disconnectNode(this._cluster[msg.src]);
  this._removeNodeFromCluster(msg.src);
};

Node.prototype._onKeepalive = function (msg) {
  var id = msg.src;
  this._clusterKeepalive[id] = Date.now() + this._cluster[id].keepalive.period;
};

/**
 * Handles delayed `.connect()` calls that were made before calling `.start()`.
 *
 * @private
 */
Node.prototype._drainConnectQueue = function () {
  var self = this;
  var args = self._connectQueue.shift();

  if (args) {
    self.join.apply(self, args);
    if (self._connectQueue.length) {
      self._drainConnectQueue();
    }
  }
};

/**
 * Add a node to our cluster.
 *
 * @param     {Object|Node}   node
 * @param     {String}        node.id
 * @param     {String}        node.name
 * @param     {String}        node.endpoints.router
 * @param     {String}        node.endpoints.pub
 * @param     {String}        node.keepalive.period
 * @param     {Object}        node.messages
 *
 * @private
 */
Node.prototype._addNodeToCluster = function (node) {
  var self = this;

  if (this.id === node.id) {
    return;
  }

  if (!this._cluster[node.id]) {
    // new node
    this._connectRouter(node.endpoints.router);
    this._connectSub(node.endpoints.pub);
    this._connectedTo[node.id] = 1;
    if (!node.messages) {
      node.messages = {
        _join: {
          period: this._defaultReplyPeriod,
          attempts: this._defaultReplyAttempts
        },
        _leave: {
          period: this._defaultReplyPeriod,
          attempts: this._defaultReplyAttempts
        },
        _connect: {
          period: this._defaultReplyPeriod,
          attempts: this._defaultReplyAttempts
        },
        _ka: {
          period: this._defaultReplyPeriod,
          attempts: this._defaultReplyAttempts
        },
        _reply: {
          period: this._defaultReplyPeriod,
          attempts: this._defaultReplyAttempts
        }
      };
    }
    this._cluster[node.id] = node;
    this._cluster[node.id].socketId = Node.buildSocketId(node.id);
  } else {
    // existing node

    // update messages
    keys(node.messages).forEach(function (type) {
      self._cluster[node.id].messages[type] = node.messages[type];
    });

    // update keepalive
    self._cluster[node.id].keepalive.period = node.keepalive.period;

    // update name
    self._cluster[node.id].name = node.name;
  }

//  this._logInfo('cluster:');
//  this._logInfo(this._cluster);

  // add node to `_clusterByMsg`
  keys(node.messages).forEach(function (type) {
    if (!self._clusterByMsg[type]) {
      self._clusterByMsg[type] = [];
    }
    if (self._clusterByMsg[type].indexOf(node) === -1) {
      self._clusterByMsg[type].push(node);
    }
  });

  // refresh keepalive
  this._clusterKeepalive[node.id] = Date.now() + node.keepalive.period;
};

Node.prototype._removeNodeFromCluster = function (id) {
  var self = this;
  var node = this._cluster[id];

  if (!node) {
    return;
  }

  this._disconnectRouter(node.endpoints.router);
  this._disconnectSub(node.endpoints.pub);

  keys(node.messages).forEach(function (type) {
    self._clusterByMsg[type].splice(self._clusterByMsg.indexOf(node), 1);
  });

  delete this._connectedTo[id];
  delete this._clusterKeepalive[id];
  this._disconnectNode(node);

  delete this._cluster[id];
};

Node.prototype._updateNode = function (id, data) {

};

/**
 *
 * @param {String}    type
 * @param {Function}  cb
 * @chainable
 * @private
 */
Node.prototype._on = function (type, cb) {
  this._internalEmitter.on(type, cb);
};

Node.prototype._off = function (type, cb) {
  if (cb) {
    this._internalEmitter.removeListener(type, cb);
  } else if (type) {
    this._internalEmitter.removeAllListeners(type);
  } else {
    this._internalEmitter.removeAllListeners();
  }
};

/**
 * Emit an internal event.
 *
 * @return {Node}
 * @private
 */
Node.prototype._emit = function () {
  this._internalEmitter.emit.apply(this._internalEmitter, arguments);
  return this;
};

/**
 * Attach a reply handler to a message.
 *
 * @param  {Object}   msg
 * @param  {Function} cb
 * @return {Node}
 * @chainable
 * @private
 */
Node.prototype._addReplyHandler = function (msg, cb) {
  if (!this._pendingReplies[msg.id]) {
    this._pendingReplies[msg.id] = {
      msg: msg,
      cbs: []
    };
  }
  this._pendingReplies[msg.id].cbs.push(cb);

  return this;
};

/**
 * Call reply handlers of a message.
 *
 * @param   {String}    id      The id of the message
 * @param   {Object}    reply   The reply message
 * @param   {Function}  [cb]    Optional callback
 * @return  {Node}
 * @chainable
 * @private
 */
Node.prototype._callReplyHandlers = function (id, reply, cb) {
  var self = this;

  this._pendingReplies[id].cbs.forEach(function (fn) {
    fn.call(self, reply);
  });

  cb();

  return this;
};

/**
 * Send a message from the PUB socket. Messages are automatically
 * queued to prevent the slow joiner symptom (missing messages on
 * subscribers due to TCP handshake delay).
 *
 * @param   {String|Buffer|Array} msg The data to send
 * @return  {Node}
 * @chainable
 * @private
 */
Node.prototype._sendPub = function (msg) {
  if (this._shouldQueuePub) {
    this._pubQueue.push(msg);
  } else {
    this._pubSocket.send(msg);
  }

  return this;
};

/**
 * Send a message from the router socket.
 *
 * @param  {Array} frames Must be [id, message]
 */
Node.prototype._sendRouter = function (frames) {
//  if (Math.random() > 0.5) {
    this._routerSocket.send(frames);
//  } else {
//    this._r2.send(frames);
//  }
  return this;
};

/**
 * Closes all the sockets.
 *
 * @return {Node}
 * @chainable
 * @private
 */
Node.prototype._closeSockets = function () {
  var self = this;

  this._logInfo('_closeSockets(): closing sockets');

  self._routerSocket.close();
  self._pubSocket.close();
  self._subSocket.close();

  return this;
};

Node.prototype._connectRouter = function (endpoint) {
  this._logInfo('_connectRouter(): connecting to', endpoint);
  this._routerSocket.connect(endpoint);
  this._r2.connect(endpoint);
  return this;
};

Node.prototype._connectSub = function (endpoint) {
  this._logInfo('_connectSub(): connecting to', endpoint);
  this._subSocket.connect(endpoint);
  return this;
};

Node.prototype._disconnectRouter = function (endpoint) {
  this._logInfo('_disconnectRouter(): disconnecting from', endpoint);
  this._routerSocket.disconnect(endpoint);
  return this;
};

Node.prototype._disconnectSub = function (endpoint) {
  this._logInfo('_disconnectSub(): disconnecting from', endpoint);
  this._subSocket.disconnect(endpoint);
  return this;
};

Node.prototype._clearPubQueue = function () {
  if (this._shouldQueuePub) {
    var self = this;
    this._shouldQueuePub = false;
    this._pubQueue.forEach(function (frame) {
      self._sendPub(frame);
    });
  }
};

/**
 * @param   {String} level    `error` or `info`
 * @param   {String|Object} args*
 * @return  {Node}
 * @private
 * @chainable
 */
Node.prototype._log = function (level, args) {
  args = [].slice.call(arguments, 1);
  var stack = __stack();
  var line = stack[2].getLineNumber();
  var file = stack[2].getFileName();

  var prefix = file + ':' + line + ' ' + new Date().toISOString() + ' ' + this.id + ': ';

  if (typeof args[0] === 'string') {
    args[0] = prefix + args[0];
  } else {
    args.unshift(prefix);
  }

  if (level === 'info') {
    console.log.apply(console, args);
  } else {
    console.error.apply(console, args);
  }

  return this;
};

/**
 * @private
 */
Node.prototype._logError = function () {
  var args = [].slice.call(arguments);
  args.unshift('error');
  this._log.apply(this, args);
};

/**
 * @private
 */
Node.prototype._logInfo = function () {
  var args = [].slice.call(arguments);
  args.unshift('info');
  this._log.apply(this, args);
};

/**
 *
 * @param   {String} id
 * @return  {Buffer}
 * @static
 */
Node.buildSocketId = function (id) {
  var socketId = 'z' + id;
  var buffer = new Buffer(socketId);
  return buffer;
};

Node.STOPPED = 0;
Node.STARTED = 1;
Node.JOINING = 2;
Node.JOINED = 3;
Node.READY = 4;

module.exports = Node;

if (require.main === module) {
  var nodeA = new Node({ id: 'A' });
  var nodeB = new Node({ id: 'B' });
  var got = 0;

  nodeB.on('keke', function () {
    got += 1;
  });

  nodeA.start();
  nodeB.start();

  console.log('node A socket id:', nodeA.socketId.toString(), nodeA.socketId);
  console.log('node B socket id:', nodeB.socketId.toString(), nodeB.socketId);

  nodeA.join(nodeB, function (err) {
    if (err) {
      console.log(err.stack);
    } else {
      console.log('connected to node', nodeB);
    }
  });

  setTimeout(function () {
    console.log('got: ', got);
    console.log('attempted: ', attempted);
    nodeA.stop();
    nodeB.stop();
  }, 10000);

  var attempted = 0;

//  setInterval(function () {
////    nodeA.stop();
////    nodeB.stop();
//    nodeA.sendTo(nodeB.id, 'keke', {kekekeke: true});
//    attempted += 1;
//  }, 0);

  process.nextTick(function () {
    var d1 = Date.now();

    for (var i = 0; i < 100000100; i++) {
      nodeA.sendTo(nodeB.id, 'keke', {kekekeke: true});
      attempted += 1;
    }

    console.log('tool', Date.now() - d1, 'ms');
  });

//  while (true) {
//    nodeA.sendTo(nodeB.id, 'keke', {kekekeke: true});
//  }
}