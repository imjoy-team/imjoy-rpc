import { RPC } from "./rpc.js";
import { assert, randId } from "./utils.js";

class WebRTCConnection {
  constructor(channel) {
    this._data_channel = channel;
    this._handle_message = null;
    this._reconnection_token = null;
    this._data_channel.onmessage = async event => {
      let data = event.data;
      if (data instanceof Blob) {
        data = await data.arrayBuffer();
      }
      this._handle_message(data);
    };
    const self = this;
    this._data_channel.onclose = function() {
      console.log("websocket closed");
      self._data_channel = null;
    };
  }

  set_reconnection_token(token) {
    this._reconnection_token = token;
  }

  on_message(handler) {
    assert(handler, "handler is required");
    this._handle_message = handler;
  }

  async emit_message(data) {
    assert(this._handle_message, "No handler for message");
    try {
      this._data_channel.send(data);
    } catch (exp) {
      //   data = msgpack_unpackb(data);
      console.error(`Failed to send data, error: ${exp}`);
      throw exp;
    }
  }

  async disconnect(reason) {
    this._data_channel = null;
    console.info(`data channel connection disconnected (${reason})`);
  }
}

async function _setupRPC(config) {
  assert(config.channel, "No channel provided");
  assert(config.workspace, "No workspace provided");
  const channel = config.channel;
  const clientId = config.client_id || randId();
  const connection = new WebRTCConnection(channel);
  config.context = config.context || {};
  config.context.connection_type = "webrtc";
  const rpc = new RPC(connection, {
    client_id: clientId,
    manager_id: null,
    default_context: config.context,
    name: config.name,
    method_timeout: config.method_timeout || 10.0,
    workspace: config.workspace
  });
  return rpc;
}

async function _createOffer(params, server, config, onInit, context) {
  config = config || {};
  let offer = new RTCSessionDescription({
    sdp: params.sdp,
    type: params.type
  });

  let pc = new RTCPeerConnection({
    iceServers: config.ice_servers || [
      { urls: ["stun:stun.l.google.com:19302"] }
    ],
    sdpSemantics: "unified-plan"
  });

  if (server) {
    pc.addEventListener("datachannel", async event => {
      const channel = event.channel;
      let ctx = null;
      if (context && context.user) ctx = { user: context.user };
      const rpc = await _setupRPC({
        channel: channel,
        client_id: channel.label,
        workspace: server.config.workspace,
        context: ctx
      });
      // Map all the local services to the webrtc client
      rpc._services = server.rpc._services;
    });
  }

  if (onInit) {
    await onInit(pc);
  }

  await pc.setRemoteDescription(offer);

  let answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  return {
    sdp: pc.localDescription.sdp,
    type: pc.localDescription.type,
    workspace: server.config.workspace
  };
}

async function getRTCService(server, service_id, config) {
  config = config || {};
  config.peer_id = config.peer_id || randId();

  const pc = new RTCPeerConnection({
    iceServers: config.ice_servers || [
      { urls: ["stun:stun.l.google.com:19302"] }
    ],
    sdpSemantics: "unified-plan"
  });

  return new Promise(async (resolve, reject) => {
    try {
      pc.addEventListener(
        "connectionstatechange",
        () => {
          if (pc.connectionState === "failed") {
            pc.close();
            reject(new Error("Connection failed"));
          }
        },
        false
      );

      if (config.on_init) {
        await config.on_init(pc);
        delete config.on_init;
      }
      let channel = pc.createDataChannel(config.peer_id, { ordered: true });
      channel.binaryType = "arraybuffer";
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const svc = await server.getService(service_id);
      const answer = await svc.offer({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type
      });

      channel.onopen = () => {
        config.channel = channel;
        config.workspace = answer.workspace;
        // Wait for the channel to be open before returning the rpc
        // This is needed for safari to work
        setTimeout(async () => {
          const rpc = await _setupRPC(config);
          pc.rpc = rpc;
          async function getService(name) {
            return await rpc.get_remote_service(config.peer_id + ":" + name);
          }
          async function disconnect() {
            await rpc.disconnect();
            pc.close();
          }
          pc.get_service = getService;
          pc.getService = getService;
          pc.disconnect = disconnect;
          pc.register_codec = rpc.register_codec;
          pc.registerCodec = rpc.register_codec;
          resolve(pc);
        }, 500);
      };

      channel.onclose = () => reject(new Error("Data channel closed"));

      await pc.setRemoteDescription(
        new RTCSessionDescription({
          sdp: answer.sdp,
          type: answer.type
        })
      );
    } catch (e) {
      reject(e);
    }
  });
}

async function registerRTCService(server, service_id, config) {
  config = config || {
    visibility: "protected",
    require_context: true
  };
  const onInit = config.on_init;
  delete config.on_init;
  await server.registerService({
    id: service_id,
    config,
    offer: (params, context) =>
      _createOffer(params, server, config, onInit, context)
  });
}

export { getRTCService, registerRTCService };
