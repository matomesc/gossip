# Silk Protocol

The Silk Protocol defines brokerless reliable dialog between a cluster of nodes.

## Goals

- cluster should operate without intermediary brokers
- nodes are both consumers and producers of messages
- reliable request-reply between nodes
- nodes can send messages either to the entire cluster or a subset that is interested in a particular message type
- nodes should be able to load balance outgoing messages
- nodes should be able to send a direct message to a particular node in the cluster

## Messages

Assume all messages have the following standard fields:

```js
{
  "id": uuid.v4(),
  "src": "unique id of message source"
}
```

### Acknowledging messages

By default, each node will acknowledge messages that it receives by sending back acknowledge messages.

An acknowledge message looks like:

```js
{
  type: "_ack",
  parent: "the id of the message you want to acknowledge"
}
```

### Replies

Messages can be replied to by sending a message to the node that sent the original message.

A reply looks like:

```js
{
  "type": "_reply",
  "parent": "the id of the message you want to reply to"
}
```

### Data

Messages can contain arbitrary data. A message containing data looks like:

```js
{
  "data": { "some": "stuff" }
}
```

## Architecture

### Handshake

To connect two nodes, they must perform a handshake with information about the their endpoints.

The node that initiates the handshake must send the following message:

```js
{
  type: "_handshake",
  data: {
    id: "unique id of handshake initiator",
    router: "zmq endpoint",
    pub: "zmq endpoint"
  }
}
```

The other node must reply with:

```js
{
  type: "_reply",
  data: {
    id: "unique id of node",
    router: "zmq endpoint",
    pub: "zmq endpoint"
  },
  parent: "the id of the intial _handshake message",
}
```

### Keepalive

TODO

### Disconnect

TODO