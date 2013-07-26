/**
 * The `Hub` abstracts low level ZeroMQ communication.
 *
 * It facilitates 1-N communication between connected endpoints by using a router, pub and sub sockets.
 *
 * @class   Hub
 * @module  core
 * @param   {Object}  [options]
 * @param   {String}  [options.id]        If provided, must uniquely identify the hub in the cluster.
 *                                        Silly things can happen if you're not careful.
 * @param   {String}  [options.router]    Router socket endpoint. Supports all the ZeroMQ socket endpoints.
 * @param   {String}  [options.pub]       Pub socket endpoint.
 *
 * @constructor
 */
function Hub(options) {

}

module.exports = Hub;