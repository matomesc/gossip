/**
 * @param {Object|Buffer} [body=null]
 * @constructor
 */
function Message(body) {
  this.data = undefined;
  this.raw = null;

  if (Buffer.isBuffer(body)) {
    this.raw = body;
  } else if (typeof body === 'object') {
    this.data = body;
  }
}

/**
 * @method  set
 * @param   path
 * @param   value
 */
Message.prototype.set = function (path, value) {
  var pieces = path.split('.');
  var current = this.data;

  if (!this.data) {
    this.data = {};
  }

  for (var i = 0, len = pieces.length; i < len; i++) {
    if (i === len - 1) {
      current[pieces[i]] = value;
    } else {
      if (!current[pieces[i]]) {
        current[pieces[i]] = {};
      }
      current = current[pieces[i]];
    }
  }
};

/**
 * @method  get
 * @param   [path]
 * @returns {*}
 */
Message.prototype.get = function (path) {
  if (this.raw && !this.data) {
    this.deserialize();
  }

  if (!path) {
    return this.data;
  }

  var pieces = path.split('.');
  var current = this.data;

  for (var i = 0, len = pieces.length; i < len; i++) {
    current = (current === undefined || current === null) ? undefined : current[pieces[i]];
    if (current === undefined) {
      break;
    }
  }

  return current;
};

/**
 * @method  serialize
 * @returns {Buffer}
 */
Message.prototype.serialize = function () {
  this.raw = new Buffer(JSON.stringify(this.data) || '');
  return this.raw;
};

/**
 * @method  deserialize
 * @returns {Message}
 */
Message.prototype.deserialize = function () {
  if (this.raw) {
    this.data = JSON.parse(this.raw);
  }
  return this;
};

module.exports = Message;