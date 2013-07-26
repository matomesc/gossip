# Gossip

Distributed messaging built with ZeroMQ.

[![Build Status](https://travis-ci.org/matomesc/gossip.png)](https://travis-ci.org/matomesc/gossip)

## Install

Make sure you have you have ZeroMQ v3.2.3+ installed.

If you are using OS X you can use `brew`:

```
brew install zeromq
```

For Windows / UNIX check the [instructions here.](http://www.zeromq.org/intro:get-the-software).

## Quick Start

Suppose you wanted to monitor the temperature of a bunch of remote gauges so things don't blow up.

A typical Gossip setup for this would be to run a `Node` on the monitor server and a `Node` on the gauges server.

This would look like:

```javascript

//
// Gauges server
//

var gossip = require('gossip');

// Nodes are the building block of gossip. You should run one node per process.
// They can send and receive messages to / from a cluster of nodes.
var node = new gossip.Node('ipc://temp-gauges');

// You can subscribe to messages you are interested in.
// Now, any node can send check your temperature by sending you a `check-temp` message. Yay!
node.on('check-temp', function (message, reply) {
  var gauge = gauges[message.data.gauge];

  // read the temperature
  var temp = gauge.readTemp();

  // this is what we're replying with
  var response = {
    temp: temp,
    time: Date.now()
  };

  // send the temperature back
  reply(null, response);
});


//
// Monitor server
//

var gossip = require('gossip');

var node = new gossip.Node('ipc://temp-monitor');

// Join the node with the gauges. This will also let you send messages to any nodes that are known
// by the node you are connecting to.
node.join('ipc://temp-gauges');

setInterval(function () {
  // check temperature
  node.send('check-temp', { gauge: 'main' }, function (err, response) {
    if (response.data.temp > 600) {
      // sound the alarm
    }
  }, 100);
});

```