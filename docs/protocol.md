# Silk Protocol

The Silk Protocol defines brokerless reliable dialog between a cluster of nodes.

## Goals

- cluster should operate without intermediary brokers
- nodes are both consumers and producers of messages
- reliable request-reply between nodes
- nodes can send messages either to the entire cluster or a subset that is interested in a particular message type
- nodes should be able to load balance outgoing messages
- nodes should be able to multicast to all nodes in the cluster
- nodes should be able to send a direct message to a particular node in the cluster

## Architecture

### Nodes

Nodes are represented by an object that looks like:

```
{
  id: uuid.v4(),
  endpoints: {
    router: 'ipc://router-a',
    pub: 'ipc://pub-a'
  },
  keepalive: {
    period: 1000
  },
  messages: {
    message_type_a: {
      reply: {
        period: 1000
      }
    },
    // ...
  }
}
```

Every node must store this info for every other node in the cluster, so that it can send and receive messages.

### Joining a cluster

Suppose node A is trying to join a cluster by connecting to node B.

Then:

A must send a `_join` message to B
B must reply to A with the cluster state
A must send a `_connect` message to everyone in the cluster, except B

A will then be able to send and receive messages.

### Leaving a cluster

To leave a cluster, a node can send a `_leave` message to the entire cluster.
After leaving a cluster, the node can't send any more messages until it rejoins.

### Node failures

Nodes should notify the cluster upon detecting a node failure.

### Sending requests

Sending a message looks like:

#### Direct messages

Direct messages are messages that are sent from one node to another by specifying the id of the node.


#### Load balancing messages

#### Broadcasting messages

### Sending replies

A node can reply to any message, however the node that sent the original message gets to decide
if it's interested in a reply or not. This means you can either send messages in a reliable or
fire-or-forget manner.

To reply to a message send a message that looks like:

```
{
  src: uuid.v4(),       // required: id of node that is replying
  dest: uuid.v4(),      // required: id of node that sent the initial message
  id: uuid.v4(),        // unique message id
  type: '_reply',
  data: Object,         // optional - data object
  reply: uuid.v4(),     // required - id of the original message
}
```

### Messages

Messages are JSON encoded strings. Each message has the following fields:

```
{
  src: uuid.v4(),     // required: node id of message source
  dest: uuid.v4(),    // required: node id of message destination
  id: uuid.v4(),      // required: unique message id (automatically generated)
  type: String,       // message type - internal messages are prefixed with `_`
  data: Object,       // optional - data object
  reply: uuid.v4(),   // optional - if the message is a reply, this is the id of the original message
}
```

#### _join

Suppose A wants to join B's cluster. Then A will send a message to B that looks like:

```
{
  src: A.id,            // A's id
  dest: B.id,           // B's id
  id: "unique_id",
  type: "_join",
  data: {}              // A's info
}
```

And B replies with:

```
{
  src: B.id,
  dest: A.id,
  id: uuid.v4(),
  type: '_reply',
  data: {
    cluster: {
      // zero or more of:
      node_id: {
        id: "node_id",
        endpoints: {
          router: "ipc://router-node_id",
          pub: "ipc://pub-node_id"
        },
        name: "kulper-belt-1"
      }
    },
    me: {
      id: B.id,
      endpoints: {
        router: "ipc://router-node_id",
        pub: "ipc://pub-node_id"
      },
      name: "kulper-belt-1"
    }
  },
  parent: "unique_id",   // the id of the initial _join message (see above)
}
```

#### _connect

```
src: A.id,
dest: B.id,
id: uuid.v4(),
type: '_connect',
data: {
  id: A.id,
  name: A.name,
  endpoints: {
    router: A.endpoints.router,
    pub: A.endpoints.pub
  },
  keepalive: {
    period: A.keepalive.period
  },
  messages: {
    'a': {
      attempts: 4,
      period: 1000
    },
    'b': {
      attempts: 1,
      period: 200
    }
  },
}
```

Reply:

```
src: B.id,
dest: A.id,
id: uuid.v4(),
type: '_reply',
data: {
  id: B.id,
  name: B.name,
  endpoints: {
    router: B.endpoints.router,
    pub: B.endpoints.pub
  },
  keepalive: {
    period: B.keepalive.period
  },
  messages: {
    'c': {
      attempts: 6,
      period: 100
    },
    'd': {
      attempts: 3,
      period: 200
    }
  },
}
```

#### _leave

Sent by a node to gracefully leave a cluster.

Suppose node A leaves its cluster. Then, A will publish a message to the entire cluster
that looks like:

```
{
  src: A.id,
  dest: '_all',
  id: uuid.v4(),
  type: '_leave',
}
```

#### _ka

Sent by a node to the cluster as a keepalive signal. This prevents disconnects from the cluster
and indicates to the rest of the cluster that the node is still alive.

If node A wants to send a keepalive to the cluster, the message will look like:

```
{
  src: A.id,
  dest: '_all',
  id: uuid.v4(),
  type: '_ka',
}
```

#### _reply

Sent by a node when replying to another node's message.

Look at `_join` above.