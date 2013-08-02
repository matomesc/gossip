var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var zmq = require('zmq');
var retry = require('retry');
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
 * @module  core
 * @param   {Object}  options
 * @param   {String}  [options.id]      Uniquely identifies the hub on the network.
 * @param   {String}  options.router    Router socket endpoint. Supports all the ZeroMQ socket endpoints.
 * @param   {String}  [options.pub]     Pub socket endpoint.
 * @constructor
 */
function Hub(options) {
  EventEmitter.call(this);

  this.id = options.id;

  this.routerEndpoint = options.router;
  this.pubEndpoint = options.pub;

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

  this.messageFactory = new MessageFactory({
    id: utils.randomId,
    src: this.id
  });

  this._pendingHandshakes = {};
  this._pendingAcks = {};
  this._pendingReplies = {};

//  this._defaultSendRetryOptions = {
//    retries: 10,
//    factor: 1.87005,
//    minTimeout: 100,
//    maxTimeout: 1000,
//    randomize: false
//  };

  this._defaultSendOperation = retry.operation({
    retries: 10,
    factor: 1.87005,
    minTimeout: 100,
    maxTimeout: 500,
    randomize: false
  });

  this._connectedHubs = {};
  this._connectedRouterEndpoints = {};
  this._connectedEndpointsSub = {};

}
inherits(Hub, EventEmitter);

/**
 * Bind the router and pub sockets. The hub can now send/receive messages.
 *
 * @method  bind
 */
Hub.prototype.bind = function () {
  // create sockets
  this.routerSocket = zmq.socket('router');
  this.pubSocket = zmq.socket('pub');
  this.subSocket = zmq.socket('sub');

  // generate router socket id
  this.routerSocketId = Hub.routerSocketId(this.id);

  // set socket identity
  this.routerSocket.setsockopt(zmq.options.identity, this.routerSocketId);

  // bind
  this.routerSocket.bindSync(this.routerEndpoint);
  this.pubSocket.bindSync(this.pubEndpoint);
};

/**
 * Connect the hub to another hub.
 *
 * @method  connect
 * @param   {Hub}       hub       The hub to connect to.
 * @param   {Function}  callback  Called after completing the handshake.
 */
Hub.prototype.connect = function (hub, callback) {
  var endpoint = hub.routerEndpoint;

  if (this._isRouterConnectedTo(endpoint)) {
    if (callback) {
      callback();
    }
    return;
  } else {
    var self = this;
    var message = this.messageFactory.build({
      type: '_handshake',
      dest: hub.id || 'unknown',
      data: {
        id: this.id,
        router: this.routerEndpoint,
        pub: this.pubEndpoint
      }
    });

    // open a dealer socket to initiate the handshake
    // we can't do this on the router since we need to know the id of the other peer
    // maybe each hub should also have a req socket?
    var tempSocket = zmq.socket('req');
    tempSocket.on('message', function (message) {
      message = new Message(message);
      var data = message.body().data;

      self._connectRouter(data.router);
      self._connectSub(data.sub);
      self._connectedHubs[data.id] = data;
    });

    var attemptsLeft = self.connectAttempts;

    function retry(attempts) {

    }

    setTimeout(function retry() {
      attemptsLeft -= 1;

      if (attemptsLeft) {
        retry();
      }
    }, self.connectTimeout);

    tempSocket.connect(endpoint);
    tempSocket.send(message.rawBody());
  }
};

/**
 * Acknowledge the receival of a message by `.reply()`ing to the message with an `_ack`.
 *
 * @method  ack
 * @param   {Message} msg
 */
Hub.prototype.ack = function (msg) {

};

/**
 * Reply to a message. Attach a callback if you're expecting a reply.
 *
 * @method  reply
 * @param   {Message}   msg
 * @param   {Function}  [callback]
 */
Hub.prototype.reply = function (msg, callback) {

};

/**
 * Send a message to the hub identified by `id`.
 *
 * @method  sendById
 * @param   {String}          id
 * @param   {Message}         msg
 * @param   {Object|Function} [options]
 * @param   {Boolean}         [options.ack]           Whether this message should be `ack`ed by the receiving node. Overrides `ackAll` and `ackOnly`
 * @param   {Number}          [options.retries=3]     Maximum retries before giving up.
 * @param   {Number}          [options.timeout=5000]  Maximum time to wait for a reply before retrying.
 * @param   {Function}        [callback]              If you are expecting a reply, this will be called with `(err, reply)`.
 */
Hub.prototype.sendById = function (id, msg, options, callback) {
  var options = options || this._defaultSendOptions,
      ack = options.ack || this.ackOnly[msg.body().type] || this.ackAll,
      retries = options.retries || this._defaultSendOptions.retries,
      timeout = options.timeout || this._defaultSendOptions.timeout;


};

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

Hub.prototype._onMessage = function () {

};

Hub.prototype._onAck = function () {

};

Hub.prototype._onHandshake = function () {

};

Hub.prototype._onReply = function () {

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

module.exports = Hub;