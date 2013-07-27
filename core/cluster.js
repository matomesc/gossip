/**
 * Cluster data structure.
 *
 * Responsible for maintaing the state of the nodes in the cluster.
 *
 * @class   Cluster
 * @module  core
 * @param   {Object}  [options]
 * @constructor
 */
function Cluster(options) {

  /**
   * Maps node ids to node objects.
   *
   * @property  _idIndex
   * @type      Object
   * @private
   */
  this._idIndex = {};


  /**
   * Maps message types to node ids.
   *
   * @property  _messageTypeIndex
   * @type      Object
   * @private
   */
  this._messageTypeIndex = {};
}

/**
 * Add a new node to the cluster.
 *
 * @method  addNode
 * @param   {Node}          node
 */
Cluster.prototype.addNode = function (node) {
  var self = this;

  // index the node
  this._idIndex[node.id] = node;

  // index the node's messages
  Object.keys(node.hub.messages).forEach(function (type) {
    if (!self._messageTypeIndex[type]) {
      self._messageTypeIndex[type] = {};
    }
    self._messageTypeIndex[type][node.id] = 1;
  });
};

/**
 * Removes a node from the cluster.
 *
 * @method  removeNode
 * @param   {String}  id
 */
Cluster.prototype.removeNode = function (id) {
  var self = this;
  var node = this._idIndex[id];

  Object.keys(node.hub.messages).forEach(function (type) {
    delete self._messageTypeIndex[type][id];
  });

  delete this._idIndex[id];
};

/**
 * Get a node by id.
 *
 * @method  getById
 * @param   {String}  id
 * @return  {Node}
 */
Cluster.prototype.getById = function (id) {
  return this._idIndex[id];
};

/**
 * Get a node by message type.
 *
 * @method  getByMessageType
 * @param   {String}  type
 * @return  {Array}   Array of `Node` objects
 */
Cluster.prototype.getByMessageType = function (type) {
  return Object.keys(this._messageTypeIndex[type]);
};

module.exports = Cluster;