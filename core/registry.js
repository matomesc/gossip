var assert = require('assert');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var zmq = require('zmq');
var uuid = require('node-uuid');
var utils = require('./utils');
var protocol = require('./protocol');
var errors = protocol.errors;

var HEARTBEAT = 5000;
var keys = Object.keys;

inherits(Registry, EventEmitter);
function Registry(endpoint, options) {
  assert(endpoint, 'Registry requires endpoint parameter');
  assert(endpoint.indexOf('ipc://') === 0, 'endpoint must be ipc: ipc://...');

  EventEmitter.call(this);

  this._id = uuid.v4();
  this._name = (options && options.name) || 'registry-' + this._id;

  // zmq endpoints
  this._routerEndpoint = endpoint;
  this._pubEndpoint = 'ipc:///tmp/centaur-registry-pub-' + this._id;

  // zmq sockets
  this._routerSocket = zmq.socket('router');
  this._dealerSocket = zmq.socket('dealer');
  this._pubSocket = zmq.socket('pub');
  this._subSocket = zmq.socket('sub');

  // stores centaur state
  this._centaurs = {};

  // stores registry state
  this._registries = {};

  // interval that calls `_prune()`
  // see `_startPruner()` and `_stopPruner()`
  this._pruner = null;
}

Registry.prototype._initSockets = function () {
  var self = this;

  // only the router and pub need to bind
  // dealer and sub should connect to other registries
  this._routerSocket.bindSync(this._dealerEndpoint);
  this._pubSocket.bindSync(this._pubEndpoint);

  // the main router handler
  this._routerSocket.on('message', function (frames) {
    var id = frames[0];
    var msg = frames[1];

    try {
      msg = JSON.parse(msg);
    } catch (e) {
      return self._send([id, new errors.BadPayload('bad json')]);
    }

    if (!msg || typeof msg != 'object') {
      return self._send([id, new errors.BadPayload('bad message')]);
    }

    if (!msg.id) {
      return self._send([id, new Error('missing node id')]);
    }

    if (msg.type === 'heartbeat') {
      self._onHeartbeat(msg);
      self.emit('heartbeat', msg);
    } else if (msg.type === 'register') {
      self._onRegister(msg, function (err, peers) {
        return self._send([id, err ? err : peers]);
      });
      self.emit('register', msg.node);
    } else {
      self._send([id, new Error('invalid message type')]);
    }
  });
};

Registry.prototype._startPruner = function () {
  if (!this._pruner) {
    this._pruner = setInterval(this._prune.bind(this), 100);
    this.emit('prune:start');
  }
};

Registry.prototype._stopPruner = function () {
  if (this._pruner) {
    clearInterval(this.pruner);
    this._pruner = null;
    this.emit('prune:stop');
  }
};

/**
 * Called when centaurs send heartbeats.
 * @param  {[type]}   id [description]
 * @param  {Function} cb [description]
 * @return {[type]}      [description]
 */
Registry.prototype._onHeartbeat = function (id) {
  this._map[id].heartbeatTime = utils.currentTime() + HEARTBEAT;
};

Registry.prototype._onRegister = function (data, cb) {

  if (!data.id) {
    return cb(new Error('missing node id'));
  }

  // save node
  this._map[data.id] = {
    id: data.id,
    endpoint: data.endpoint,
    names: data.names
  };

  // respond with other nodes
  var reply = {
    nodes: this._map,
    subscribe: this._pubEndpoint
  };

  cb(null, reply);
};

/**
 * Removes dead centaurs from the registry and updates everyone else.
 */
Registry.prototype._prune = function () {
  var self = this;
  var current = utils.currentTime();

  keys(self._map).forEach(function (key) {
    var node = self._map[key];
    if (node.heartbeatTime > current) {
      var msg = {
        type: 'prune',
        node: { id: node.id }
      };
      self._publish(msg);
      self.emit('prune', msg);
      delete self._map[key];
    }
  });
};

/**
 * Publish message to all the centaurs in the cluster.
 *
 * @param  {Object}   data
 * @param  {Function} cb
 */
Registry.prototype._publish = function (data, cb) {
  this._pubSocket.send(JSON.stringify(data));
};

/**
 * Reply to individual centaur requests.
 *
 * @param  {Array} frames The first frame must be the socket id.
 * @return Registry       The registry itself.
 */
Registry.prototype._send = function (frames) {
  var id = frames[0];
  var data = frames[1];

  if (data instanceof Error) {
    // send error message
    return this._routerSocket.send({
      type: 'error',
      message: data.message,
      stackframe: null // TODO
    });
  }

  return this._routerSocket.send(data);
};

Registry.prototype.start = function (cb) {
  var self = this;
  self._initSockets();
  self._startPruner();
  process.nextTick(function () {
    self.emit('start');
    if (cb) cb(null);
  });
};

module.exports = Registry;