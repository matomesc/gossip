var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var zmq = require('zmq');
var retry = require('retry');
var Stately = require('stately.js');
var Message = require('./message.js');
var MessageFactory = require('./message_factory');
var utils = require('./utils');

/**
 * The `Hub` abstracts low level ZeroMQ communication.
 *
 * Features:
 *
 * - 1-1, 1-N req / rep
 * - message acknowledgements
 * - retries
 * - keepalives
 *
 * It three ZMQ sockets: router, pub and sub.
 *
 * TODO:
 *
 * - implement transactions
 * - message stream when expecting multiple replies
 *
 *
 * @class   Hub
 * @extends EventEmitter
 * @module  core
 * @param   {Object}  options
 * @param   {String}  [options.id]      Uniquely identifies the hub on the network.
 * @param   {String}  options.router    Router socket endpoint. Supports all the ZeroMQ socket endpoints.
 * @param   {String}  [options.pub]     Pub socket endpoint.
 * @constructor
 */
function Hub(options) {
  EventEmitter.call(this);

  this.debug = false;

  this.id = options.id || 'hub-' + utils.randomId();
  this.routerEndpoint = options.router;
  this.routerEndpointType = utils.endpointType(this.routerEndpoint);
  this.pubEndpoint = options.pub;
  this.pubEndpointType = this.routerEndpointType;

  if (!this.pubEndpoint) {
    var pieces = this.routerEndpoint.split(':');

    if (this.routerEndpointType === 'tcp') {
      var port = utils.randRange(5000, 1 << 16);
      this.pubEndpoint = [pieces[0], pieces[1], port].join(':');
    } else {
      this.pubEndpoint = [pieces[0], '/tmp/pub-' + this.id];
    }
  }

  // these are lazily initiated in `.bind()`
  this.routerSocket = null;
  this.pubSocket = null;
  this.subSocket = null;

  this.connectTimeout = options.connectTimeout || 1000;
  this.connectAttempts = options.connectAttempts || 3;
  this.connectPeriod = options.connectPeriod || 200;

  /**
   * The id of the hub's router socket. Other nodes use this to send messages us messages from their router sockets.
   *
   * @property  routerSocketId
   * @type      {Buffer}
   * @default   null
   */
  this.routerSocketId = null;

  /**
   * Whether all messages that this node sends should be `ack`ed.
   *
   * @property   ackAll
   * @type      {Boolean}
   * @default   true
   */
  this.ackAll = true;

  /**
   * Messages types which the node should `ack`. Overrides `ackAll`.
   *
   * @property   ackOnly
   * @type      {Object}
   * @default   {}
   */
  this.ackOnly = {};

  /**
   * The hub's message factory. Used to create all messages sent.
   *
   * @property  messageFactory
   * @type      {MessageFactory}
   */
  this.messageFactory = new MessageFactory({
    id: utils.randomId,
    src: this.id
  });

  /**
   * The hub's state machine.
   *
   * @property  _machine
   * @type      {Stately}
   * @private
   */
  this._machine = new Stately({
    CLOSED: {
      bind: 'BOUND'
    },
    BOUND: {
      close: 'CLOSED'
    }
  }, 'CLOSED');

  this._pendingAcks = {};
  this._pendingReplies = {};

  this._pendingAcksByTime = [];
  this._pendingAcksPruner = null;

  this._ops = {
    fast: Hub.op({
      retries: 10,
      minTimeout: 100,
      maxTimeout: 1000
    }),
    medium: Hub.op({
      retries: 10,
      minTimeout: 1000,
      maxTimeout: 10 * 1000
    }),
    slow: Hub.op({
      retries: 10,
      minTimeout: 30 * 1000,
      maxTimeout: 3 * 60 * 1000
    })
  };

  this._connectedHubs = {};
  this._connectedRouterEndpoints = {};
  this._connectedSubEndpoints = {};
}
inherits(Hub, EventEmitter);

/**
 * Bind the router and pub sockets and subscribe to all messages.
 *
 * The hub can now send/receive messages.
 *
 * @method  bind
 */
Hub.prototype.bind = function () {
  var state = this._machine.getMachineState();
  if (state !== 'CLOSED') {
    return;
  }

  // create sockets
  this.routerSocket = zmq.socket('router');
  this.pubSocket = zmq.socket('pub');
  this.subSocket = zmq.socket('sub');

  // generate router socket id
  this.routerSocketId = Hub.routerSocketId(this.id);

  // set router socket identity
  this.routerSocket.setsockopt(zmq.options.identity, this.routerSocketId);
  this.routerSocket.setsockopt(zmq.ZMQ_LINGER, 0);

  // bind sockets
  try {
    this.routerSocket.bindSync(this.routerEndpoint);
  } catch (e) {
    console.log('failed to bind router: attempted', this.routerEndpoint);
    throw e;
  }

  try {
    this.pubSocket.bindSync(this.pubEndpoint);
  } catch (e) {
    console.log('failed to bind pub: attempted', this.routerEndpoint);
    throw e;
  }

  // subscribe sub socket to everything
  this.subSocket.setsockopt(zmq.ZMQ_SUBSCRIBE, utils.EMPTY_BUFFER);

  var self = this;
  function routeMessage(msg) {
    var type = msg.get('type');

    if (type === '_ack') {
      self.onAck(msg);
    } else if (type === '_handshake') {
      self.onHandshake(msg);
    } else if (type === '_reply') {
      self.onReply(msg);
    }

    self.emit(type, msg);
  }

  // set message handlers
  this.routerSocket.on('message', function (id, delimiter, data) {
    if (self.debug) {
      console.log('%s: RECV ROUTER', self.id);
      console.log([].map.call(arguments, function (f) {
        return f.toString();
      }));
      //    console.log('%s: REPLY HANDLERS', self.id);
      //    console.log(self._pendingReplies);
    }

    var message = new Message(data);
    routeMessage(message);
  });

  this.subSocket.on('message', function (data) {
    var message = new Message(data);
    routeMessage(message);
  });

  this._startAckPruner();

  this._machine.bind();

  return this;
};

Hub.prototype.close = function (callback) {
  this._machine.close();

  if (this._machine.getMachineState() !== 'CLOSED') {
    return;
  }

  var self = this;

  // note: socket.close() is async
  if (self.routerSocket) {
    self.routerSocket.close();
    self.routerSocket = null;
  }

  if (self.pubSocket) {
    self.pubSocket.close();
    self.pubSocket = null;
  }

  if (self.subSocket) {
    self.subSocket.close();
    self.subSocket = null;
  }

  self._stopAckPruner();

  process.nextTick(function () {
    if (callback) {
      callback();
    }
  });
};

/**
 * Connect the hub to another hub.
 *
 * @method  handshake
 * @param   {Hub}       hub       The hub to connect to.
 * @param   {Function}  callback  Called after completing the handshake.
 */
Hub.prototype.handshake = function (hub, callback) {
  var self = this;

  if (this._connectedHubs[hub.id]) {
    return process.nextTick(function () {
      callback(new Error('you dont handshake twice bro.'));
    });
  }

  var message = this.messageFactory.build({
    type: '_handshake',
    data: {
      id: this.id,
      router: this.routerEndpoint,
      pub: this.pubEndpoint
    }
  });

  function handleReply(err, msg) {
    if (err) {
      self._disconnectRouter(hub.routerEndpoint);
      return console.log('error handshaking:\n', err.stack);
    }

    hub.id = msg.get('data.id');
    hub.pubEndpoint = msg.get('data.pub');

    self._connectSub(hub.pubEndpoint);
    self._connectedHubs[hub.id] = hub;

    callback();
  }

  this._addAckHandler(message);
  this._addReplyHandler(message, handleReply);

  // need to connect router in order to receive reply
  self._connectRouter(hub.routerEndpoint);

  // send the handshake message
  var socket = zmq.socket('req');
  socket.connect(hub.routerEndpoint);
  socket.send(message.serialize());
  socket.close();
};

/**
 * Called when the hub receives a `_handshake` message.
 *
 * @method onHandshake
 * @param  {Message}    msg
 */
Hub.prototype.onHandshake = function (msg) {
  var data = msg.get('data');

  var hub = new Hub({
    id: data.id,
    pub: data.pub,
    router: data.router
  });

  this._connectRouter(hub.routerEndpoint);
  this._connectSub(hub.pubEndpoint);

  this._connectedHubs[hub.id] = hub;

  this.ack(msg);

  this.reply(msg, {
    id: this.id,
    router: this.routerEndpoint,
    pub: this.pubEndpoint
  });
};

/**
 * Acknowledge the receival of a message by sending an `_ack` message.
 *
 * @method  ack
 * @param   {Message} msg
 */
Hub.prototype.ack = function (msg) {

  this.sendById(msg.get('src'), this.messageFactory.build({
    type: '_ack',
    parent: msg.get('id')
  }));
};

/**
 * Called when an `_ack` message is received. This fulfills the pending acknowledgment.
 *
 * @method  onAck
 * @param   {Message} msg
 */
Hub.prototype.onAck = function (msg) {
  if (this._pendingAcks[msg.id]) {
    this._pendingAcks[msg.id].fulfilled = true;
    delete this._pendingAcks[msg.id];
  }
};

/**
 * Reply to a message. Pass in a callback if you're expecting a reply.
 *
 * @method  reply
 * @param   {Object}    msg     The message you are replying to.
 * @param   {Object}    [data]  Optional data to send
 * @param   {Function}  [callback]
 */
Hub.prototype.reply = function (msg, data, callback) {
  var src = msg.get('src');
  var id = msg.get('id');

  var reply = this.messageFactory.build({
    parent: id,
    type: '_reply'
  });

  if (arguments.length === 2 && typeof data === 'function') {
    callback = data;
    data = undefined;
  }

  if (data !== undefined) {
    reply.set('data', data);
  }

  this._sendRouter([
    Hub.routerSocketId(src),
    utils.EMPTY_BUFFER,
    reply.serialize()
  ]);

  if (callback) {
    this._addAckHandler(reply);
    this._addReplyHandler(reply, callback);
  }
};

/**
 * Called when a `_reply` message is received.
 *
 * All message handlers are invoked immediately.
 *
 * @method  onReply
 * @param   {Message} msg
 */
Hub.prototype.onReply = function (msg) {
  var parent = msg.get('parent');

  if (this._pendingReplies[parent]) {
    this._pendingReplies[parent].cb.forEach(function (cb) {
      cb(null, msg);
    });
    delete this._pendingReplies[parent];
  }
};

/**
 * Send a message to the hub identified by `id`.
 *
 * @method  sendById
 * @param   {String}    id
 * @param   {Message}   message
 * @param   {Function}  [callback]  If you are expecting a reply, this will be called with `(err, reply)`.
 */
Hub.prototype.sendById = function (id, message, callback) {
  // TODO: figure out retry logic
  if (callback) {
    this._addReplyHandler(message, callback);
    this._addAckHandler(message);
  }

  this._sendRouter([
    Hub.routerSocketId(id),
    utils.EMPTY_BUFFER,
    message.serialize()
  ]);
};

/**
 * Send a message to all connected hubs.
 *
 * @method  sendAll
 * @param   {Message}   message
 * @param   {Function}  callback
 */
Hub.prototype.sendAll = function (message, callback) {
  if (callback) {
    this._addAckHandler(message);
    this._addReplyHandler(message, callback);
  }

  this._sendPub(message.serialize());
};

/**
 * Connect the router socket to an endpoint.
 *
 * @param   {String} endpoint
 * @private
 */
Hub.prototype._connectRouter = function (endpoint) {
  if (!this._connectedRouterEndpoints[endpoint]) {
    this.routerSocket.connect(endpoint);
    this._connectedRouterEndpoints[endpoint] = 1;
  }
};

/**
 * Disconnects the router socket.
 *
 * @method  _disconnectRouter
 * @param   {string} endpoint
 * @private
 */
Hub.prototype._disconnectRouter = function (endpoint) {
  if (this._connectedRouterEndpoints[endpoint]) {
    this.routerSocket.disconnect(endpoint);
    delete this._connectedRouterEndpoints[endpoint];
  }
};

Hub.prototype._isRouterConnectedTo = function (endpoint) {
  return this._connectedRouterEndpoints[endpoint] === 1;
};

Hub.prototype._connectSub = function (endpoint) {
  if (!this._connectedSubEndpoints[endpoint]) {
    this.subSocket.connect(endpoint);
    this._connectedSubEndpoints[endpoint] = 1;
  }
};

Hub.prototype._disconnectSub = function (endpoint) {
  if (this._connectedSubEndpoints[endpoint]) {
    this.subSocket.disconnect(endpoint);
    delete this._connectedSubEndpoints[endpoint];
  }
};

Hub.prototype._isSubConnectedTo = function (endpoint) {
  return this._connectedSubEndpoints === 1;
};

/**
 * Send an array of buffers on the router socket.
 *
 * The first frame **must** be the socket id of the other hub.
 * The second frame is an empty buffer delimiter.
 * The third frame is the message buffer.
 *
 * @method _sendRouter
 * @param  {Array}    frames    Array of `Buffer`s.
 * @private
 */
Hub.prototype._sendRouter = function (frames) {
  if (this.debug) {
    console.log('%s: SEND ROUTER', this.id);
    console.log(frames.map(function (f) {
      return f.toString();
    }));
    //  console.log('%s: REPLY HANDLERS', this.id);
    //  console.log(this._pendingReplies);
  }

  this.routerSocket.send(frames);
};

/**
 * Send a buffer on the pub socket.
 *
 * @method _sendPub
 * @param  {Buffer} buffer
 * @private
 */
Hub.prototype._sendPub = function (buffer) {
  this.pubSocket.send(buffer);
};

/**
 * Attach an `_ack` handler. If we don't receive an `_ack`, we should
 * attempt to retry.
 *
 * If there is only one node then we will retry again in a bit.
 * Otherwise if there are more hubs connected then we ask another hub.
 *
 * TODO:
 *
 * - retry logic
 *
 * @method  _addAckHandler
 * @param   msg
 * @private
 */
Hub.prototype._addAckHandler = function (msg) {
  var ack = {
    expires: Date.now() + 100,
    fulfilled: false
  };

  this._pendingAcks[msg.get('id')] = ack;
  this._pendingAcksByTime.push(ack);
};

Hub.prototype._addReplyHandler = function (msg, callback) {
  var id = msg.get('id');

  if (!this._pendingReplies[id]) {
    this._pendingReplies[id] = {
      cb: []
    };
  }

  this._pendingReplies[id].cb.push(callback);
};

Hub.prototype._startAckPruner = function () {
  var self = this;
  this._pendingAcksPruner = setInterval(function () {
    var now = Date.now();
    var acks = self._pendingAcksByTime;
    var ack;

    while (acks.length && acks[0].expires < now) {
      ack = self._pendingAcksByTime.shift();

      if (!ack.fulfilled) {
        // TODO: implement retry logic here
        console.log('%s: ack not fulfilled... should retry', self.id);
      }
    }
  }, 1000);
};

Hub.prototype._stopAckPruner = function () {
  if (this._pendingAcksPruner) {
    clearInterval(this._pendingAcksPruner);
  }
};

/**
 * @method  routerSocketId
 * @param   {String} id
 * @return  {Buffer}
 * @static
 */
Hub.routerSocketId = function (id) {
  var socketId = 'g' + id;
  return new Buffer(socketId);
};

/**
 * @method  op
 * @param   {Object}          options   Same options as `retry.operation(options)`
 * @returns {RetryOperation}
 * @static
 */
Hub.op = function (options) {
  var opKey = Object.keys(options).join('|');
  if (!Hub._opCache[opKey]) {
    Hub._opCache[opKey] = retry.operation(options);
  }
  return Hub._opCache[opKey];
};

/**
 * Bind hubs.
 *
 * @method  bindAll
 * @param   {Hub} hub*
 * @static
 */
Hub.bindAll = function (hub) {
  [].slice.call(arguments).forEach(function (hub) {
    hub.bind();
  });
};

/**
 * Caches operations returned by `Hub.op()`.
 *
 * @property  _opCache
 * @type      {Object}
 * @private
 * @static
 */
Hub._opCache = {};

module.exports = Hub;

if (require.main === module) {
  var a = new Hub({
    id: 'a',
    router: 'tcp://127.0.0.1:5000'
  }).bind();
  var b = new Hub({
    id: 'b',
    router: 'tcp://127.0.0.1:6000'
  }).bind();

  a.handshake(b, function (err) {
    console.log('done');
    a.close();
    b.close();
  });
}