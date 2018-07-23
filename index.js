import EventEmitter from 'events';

const MQTT_PROTOCOL_NAME  = 'MQTT';
const MQTT_PROTOCOL_LEVEL = 4;

const PACKET_TYPE_CONNECT     = 1;
const PACKET_TYPE_CONNACK     = 2;
const PACKET_TYPE_PUBLISH     = 3;
const PACKET_TYPE_PUBACK      = 4;
const PACKET_TYPE_PUBREC      = 5;
const PACKET_TYPE_PUBREL      = 6;
const PACKET_TYPE_PUBCOMP     = 7;
const PACKET_TYPE_SUBSCRIBE   = 8;
const PACKET_TYPE_SUBACK      = 9;
const PACKET_TYPE_UNSUBSCRIBE = 10;
const PACKET_TYPE_UNSUBACK    = 11;
const PACKET_TYPE_PINGREQ     = 12;
const PACKET_TYPE_PINGRESP    = 13;
const PACKET_TYPE_DISCONNECT  = 14;

const CONNECT_FLAG_CLEAN_SESSION = 0x01;
const CONNECT_FLAG_WILL          = 0x02;
const CONNECT_FLAG_WILL_QOS      = 0x0c;
const CONNECT_FLAG_WILL_RETAIN   = 0x10;
const CONNECT_FLAG_PASSWORD      = 0x20;
const CONNECT_FLAG_USER_NAME     = 0x40;

const CONNACK_FLAG_SESSION_PRESET = 0x01;

function buildPacket(type, flags, header, payload) {
  let remainLen = (header ? header.length : 0) + (payload ? payload.length : 0);
  const bytes = new Uint8Array(4 + remainLen);
  let p = 0;
  bytes[p++] = type << 4 | (flags & 0x0f);
  do {
    let byte = remainLen % 128;
    remainLen = remainLen >> 7;
    if (remainLen > 0) {
      byte |= 0x80;
    }
    bytes[p++] = byte;
  } while (remainLen > 0);
  if (header) {
    for (let i = 0; i < header.length; i++) {
      bytes[p++] = header[i];
    }
  }
  if (payload) {
    for (let i = 0; i < payload.length; i++) {
      bytes[p++] = payload[i];
    }
  }
  return bytes.subarray(0, p);
}

function ntob(number) {
  return [(number >> 8) & 0xff, number & 0xff];
}

function bton(data) {
  return data[0] << 8 | data[1];
}

function stolpb(string) {
  const prefix = ntob(string.length);
  const bytes = stob(string);
  return prefix.concat(bytes);
}

function stob(string) {
  const bytes = new Array(string.length);
  for (let i = 0; i < string.length; i++) {
    bytes[i] = string.charCodeAt(i);
  }
  return bytes;
}

export default class Client extends EventEmitter {
  constructor(options) {
    super();
    const ws = new WebSocket(options.url, 'mqtt');
    ws.binaryType = 'arraybuffer';
    ws.onclose = () => this.emit('close');
    ws.onerror = this.emit.bind(this, 'error');
    ws.onmessage = ({data}) => this._receivePacket(data);
    ws.onopen = () => this._connect();
    this._ws = ws;
    this._clientId = options.clientId ||
      'awstsc_' + Math.random().toString(16).substr(2, 8);
    this._clean = !!options.clean;
    this._keepAlive = !!options.keepAlive || 60;
    this._nextId = 1;
    this._callbacks = Object.create(null);
  }

  _sendPacket(data, packetId, callback) {
    this._ws.send(data);
    if (callback) {
      if (packetId > -1) {
        this._callbacks[packetId] = callback;
      } else {
        callback();
      }
    }
  }

  _receivePacket(data) {
    data = new Uint8Array(data);
    const type = data[0] >> 4;
    const flags = data[0] & 0x0f;
    let p = 1;
    let remainLen = 0;
    let m = 1;
    let byte;
    do {
      byte = data[p++];
      remainLen += ((byte & 0x7f) * m);
      m *= 128;
    } while ((byte & 0x80) !== 0);
    data = data.slice(p, p + remainLen);
    switch (type) {
    case PACKET_TYPE_CONNACK:
      const connackFlags = data[0];
      const returnCode = data[1];
      const callback = this._callbacks[0];
      callback(null, connackFlags, returnCode);
      break;
    case PACKET_TYPE_PUBLISH:
      const dub = !!(flags >> 3);
      const qos = flags >> 1 & 0x3;
      const remain = !!(flags & 0x01);
      const n = bton(data);
      p = 2;
      let topic = String.fromCharCode.apply(null, data.slice(p, p += n));
      const packetId = qos > 0 ? bton(data.slice(p, p += 2)) : -1;
      const payload = String.fromCharCode.apply(null, data.slice(p, remainLen));
      this.emit('message', topic, payload);
      if (qos === 1) {
        this._sendPacket(buildPacket(PACKET_TYPE_PUBACK, 0x00, ntob(packetId)));
      } else if (qos === 2) {
        this._sendPacket(buildPacket(PACKET_TYPE_PUBREC, 0x00, data));
      }
      break;
    case PACKET_TYPE_PUBACK:``
    case PACKET_TYPE_PUBCOMP:
    case PACKET_TYPE_SUBACK:
    case PACKET_TYPE_UNSUBACK:
      this._handleAck(data);
      break;
    case PACKET_TYPE_PUBREC:
      this._sendPacket(buildPacket(PACKET_TYPE_PUBREL, 0x00, data));
      break;
    case PACKET_TYPE_PINGRESP:
      break;
    }
  }

  _handleAck(data) {
    const packetId = bton(data.slice(0, 2));
    const callback = this._callbacks[packetId];
    if (callback) {
      const response = data.slice(2);
      callback(null, response);
      delete this._callbacks[packetId];
    }
  }

  _connect() {
    const header = stolpb(MQTT_PROTOCOL_NAME).concat(
      MQTT_PROTOCOL_LEVEL,
      this._clean | CONNECT_FLAG_WILL,
      ntob(this._keepAlive)
    );
    const payload = stolpb(this._clientId);
    const packet = buildPacket(PACKET_TYPE_CONNECT, 0, header, payload);
    const that = this;
    this._sendPacket(packet, 0, (err, flags, returnCode) => {
      if (err) {
        that.emit('error', err);
        return;
      }
      if (returnCode === 0x00) {
        that.emit('connect', flags);
        return;
      }
      let errMessage;
      switch (returnCode) {
      case 0x01:
        errMessage = 'Unsupported protocol level';
        break;
      case 0x02:
        errMessage = 'Invalid client identifier';
        break;
      case 0x03:
        errMessage = 'Service unavailable';
        break;
      case 0x04:
        errMessage = 'Malformed username or password';
        break;
      case 0x05:
        errMessage = 'Client not authorized';
        break;
      default:
        errMessage = 'Connection failed';
      }
      that.emit('error', new Error(errMessage));
    });
  }

  publish(topic, message, options, callback) {
    let dup = false;
    let qos = 0;
    let remain = false;
    if (typeof message !== 'string') {
      callback = options;
      options = message;
      message = null;
    }
    if (typeof options === 'function') {
      callback = options;
      options = null;
    } else if (typeof options === 'number') {
      qos = options;
    } else {
      dup = options.dup;
      qos = options.qos;
      remain = options.remain;
    }
    const flags = dup << 3 | (qos & 0x03) << 1 | remain;
    let packetId = qos > 0 ? this._nextId++ : -1;
    let header = stolpb(topic);
    if (packetId > -1) {
      header = header.concat(ntob(packetId));
    }
    const payload = message && stob(message);
    const packet = buildPacket(PACKET_TYPE_PUBLISH, flags, header, payload);
    this._sendPacket(packet, packetId, err => {
      if (callback) {
        if (err) {
          callback(err);
        } else {
          callback();
        }
      }
    });
  }

  subscribe(topics, qos, callback) {
    if (typeof topics === 'string') {
      topics = [topics];
    }
    if (typeof qos === 'function') {
      callback = qos;
      qos = 0;
    }
    const flags = qos & 0x03;
    const packetId = this._nextId++;
    const payload = topics.reduce((data, topic) =>
      typeof topic === 'object' ?
        data.concat(stolpb(topic.topic), topic.qos & 0x03)
      :
        data.concat(stolpb(topic), flags)
    , []);
    const packet =
      buildPacket(PACKET_TYPE_SUBSCRIBE, 0x02, ntob(packetId), payload)
    ;
    this._sendPacket(packet, packetId, (err, response) => {
      if (callback) {
        if (err) {
          callback(err);
        } else {
          callback(null, topics.map((topic, i) => ({
            topic, qos: response[i]
          })));
        }
      }
    });
  }

  unsubscribe(topics, callback) {
    if (typeof topics === 'string') {
      topics = [topics];
    }
    const packetId = this._nextId++;
    const payload = topics.reduce((data, topic) =>
      data.concat(stolpb(topic))
    , []);
    const packet =
      buildPacket(PACKET_TYPE_UNSUBSCRIBE, 0x02, ntob(packetId), payload)
    ;
    this._sendPacket(packet, packetId, err => {
      if (callback) {
        if (err) {
          callback(err);
        } else {
          callback();
        }
      }
    });
  }

  ping() {
    const packet = buildPacket(PACKET_TYPE_PINGREQ);
    this._sendPacket(packet);
  }

  disconnect() {
    const packet = buildPacket(PACKET_TYPE_DISCONNECT);
    this._sendPacket(packet);
  }
}
