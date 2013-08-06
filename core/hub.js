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
 * - 1-1, 1-N request / reply
 * - message `ack`s
 * - retries
 *
 * It facilitates 1-N communication between connected endpoints by using a router, pub and sub sockets.
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
 * Bind the router and pub sockets. The hub can now send/receive messages.
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

  // throw errors if messages sent can't be routed
//  this.routerSocket.setsockopt(zmq.ZMQ_ROUTER_MANDATORY, 1);

  // bind sockets
  try {
    this.routerSocket.bindSync(this.routerEndpoint);
  } catch (e) {
    console.log('endpoint attempted:', this.routerEndpoint);
    throw e;
  }

  this.pubSocket.bindSync(this.pubEndpoint);

  var self = this;
  function routeMessage(msg) {
    var type = msg.body().type;

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
//    console.log('%s: RECV ROUTER', self.id);
//    console.log([].map.call(arguments, function (f) {
//      return f.toString();
//    }));
//    console.log('%s: REPLY HANDLERS', self.id);
//    console.log(self._pendingReplies);

    var message = new Message(data);
    routeMessage(message);
  });

  this.pubSocket.on('message', function () {
    console.log('pub message:');
    console.log(arguments);
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

  // this must be async since the close operation
  // is not synchronous and breaks tests
  setTimeout(function () {
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

    if (callback) {
      callback();
    }
  }, 20);
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
  var message = this.messageFactory.build({
    type: '_handshake',
    data: {
      id: this.id,
      router: this.routerEndpoint,
      pub: this.pubEndpoint
    }
  });

  function handleReply(err, msg) {
    var data = msg.body().data;

    hub.id = data.id;
    hub.pubEndpoint = data.pub;

    self._connectSub(hub.pubEndpoint);

    self._connectedHubs[hub.id] = hub;

    callback();
  }

  this._addAckHandler(message);
  this._addReplyHandler(message, handleReply);

  // need to connect in order to receive reply
  self._connectRouter(hub.routerEndpoint);

  var socket = zmq.socket('req');
  socket.connect(hub.routerEndpoint);
  socket.send(message.rawBody());
  socket.close();
};

/**
 * Called when the hub receives a `_handshake` message.
 *
 * @method onHandshake
 * @param  {Message}    msg
 */
Hub.prototype.onHandshake = function (msg) {
  var body = msg.body();
  var data = body.data;

  var hub = new Hub({
    id: data.id,
    pub: data.pub,
    router: data.router
  });

  this._connectRouter(hub.routerEndpoint);
  this._connectSub(hub.pubEndpoint);

  this._connectedHubs[hub.id] = hub;

  this.ack(msg);

  this.reply(msg, this.messageFactory.build({
    data: {
      id: this.id,
      router: this.routerEndpoint,
      pub: this.pubEndpoint
    },
    type: '_reply',
    parent: msg.body().id
  }));
};

/**
 * Acknowledge the receival of a message by sending an `_ack` message.
 *
 * @method  ack
 * @param   {Message} msg
 */
Hub.prototype.ack = function (msg) {
  var body = msg.body();

//  console.log('%s sending ack for:\n%s', this.id, msg.rawBody().toString());

  this.sendById(body.src, this.messageFactory.build({
    type: '_ack',
    parent: body.id
  }));
};

Hub.prototype.onAck = function (msg) {
  var body = msg.body();

  if (this._pendingAcks[body.id]) {
    this._pendingAcks[body.id].fulfilled = true;
    delete this._pendingAcks[body.id];
  }
};

/**
 * Reply to a message. Pass in a callback if you're expecting a reply.
 *
 * @method  reply
 * @param   {Message}   msg     The message you are replying to.
 * @param   {Object}    [data]  Optional data to send
 * @param   {Function}  [callback]
 */
Hub.prototype.reply = function (msg, data, callback) {
  var src = msg.body().src;
  var reply = {
    parent: msg.body().id
  };

  if (arguments.length === 2 && typeof data === 'function') {
    callback = data;
    data = undefined;
  }

  if (data !== undefined) {
    reply.data = data;
  }

  var replyMsg = this.messageFactory.build(reply);

  this._sendRouter([
    Hub.routerSocketId(src),
    utils.EMPTY_BUFFER,
    replyMsg().rawBody()
  ]);

  if (callback) {
    this._addAckHandler(msg);
    this._addReplyHandler(msg, callback);
  }
};

Hub.prototype.onReply = function (msg) {
  var body = msg.body();

  if (this._pendingReplies[body.parent]) {
    this._pendingReplies[body.parent].cb.forEach(function (cb) {
      cb(null, msg);
    });
    delete this._pendingReplies[body.parent];
  }
};

/**
 * Send a message to the hub identified by `id`.
 *
 * @method  sendById
 * @param   {String}          id
 * @param   {Message}         msg
 * @param   {Object|Function} [options]
 * @param   {Boolean}         [options.ack]               Whether this message should be `ack`ed by the receiving node. Overrides `ackAll` and `ackOnly`
 * @param   {String|Object}   [options.retry]             A string (`'fast'`, `'medium'`, `'slow'`) or a `RetryOperation` object. Overides `retries`, `minTimeout` and `maxTimeout`.
 * @param   {Number}          [options.retries=3]         Maximum retries before giving up.
 * @param   {Number}          [options.minTimeout=100]    Maximum time to wait for a reply before retrying.
 * @param   {Number}          [options.maxTimeout=1000]   Maximum time to wait for a reply before retrying.
 * @param   {Function}        [callback]                  If you are expecting a reply, this will be called with `(err, reply)`.
 */
Hub.prototype.sendById = function (id, msg, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  } else if (arguments.length === 2) {
    options = {};
  }

  // TODO: figure out retry logic
  var ack = options.ack || this.ackOnly[msg.body().type] || this.ackAll,
      retry = options.retry;

  if (!retry && (options.retries || options.minTimeout || options.maxTimeout)) {
    retry = Hub.op({
      retries: options.retries || 10,
      minTimeout: options.minTimeout || 100,
      maxTimeout: options.maxTimeout || 1000
    });
  } else if (typeof retry === 'string') {
    retry = this._ops[retry];
  }

  if (callback) {
    this._addReplyHandler(msg, callback);
    this._addAckHandler(msg);
  }

  this._sendRouter([
    Hub.routerSocketId(id),
    new Buffer(''),
    msg.rawBody()
  ]);
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
 * The first frame **must** be the socket of the other hub.
 *
 * @method _sendRouter
 * @param  {Array}    frames    Array of `Buffer`s.
 * @private
 */
Hub.prototype._sendRouter = function (frames) {
//  console.log('%s: SEND ROUTER', this.id);
//  console.log(frames.map(function (f) {
//    return f.toString();
//  }));
//  console.log('%s: REPLY HANDLERS', this.id);
//  console.log(this._pendingReplies);
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

Hub.prototype._addAckHandler = function (msg) {
  var ack = {
    expires: Date.now() + 100,
    fulfilled: false
  };

  this._pendingAcks[msg.body().id] = ack;
  this._pendingAcksByTime.push(ack);
};

Hub.prototype._addReplyHandler = function (msg, callback) {
  var body = msg.body();

  if (!this._pendingReplies[body.id]) {
    this._pendingReplies[body.id] = {
      cb: []
    };
  }

  this._pendingReplies[body.id].cb.push(callback);
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