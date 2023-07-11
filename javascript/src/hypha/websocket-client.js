import { RPC, API_VERSION } from "./rpc.js";
import { assert, loadRequirements, randId, waitFor } from "./utils.js";

export { RPC, API_VERSION };
export { version as VERSION } from "../../package.json";
export { loadRequirements };
export { getRTCService, registerRTCService } from "./webrtc-client.js";

class WebsocketRPCConnection {
  constructor(server_url, client_id, workspace, token, timeout) {
    assert(server_url && client_id, "server_url and client_id are required");
    server_url = server_url + "?client_id=" + client_id;
    if (workspace) {
      server_url += "&workspace=" + workspace;
    }
    if (token) {
      server_url += "&token=" + token;
    }
    this._websocket = null;
    this._handle_message = null;
    this._reconnection_token = null;
    this._server_url = server_url;
    this._timeout = timeout || 5; // 5s
  }

  set_reconnection_token(token) {
    this._reconnection_token = token;
  }

  on_message(handler) {
    assert(handler, "handler is required");
    this._handle_message = handler;
  }

  async open() {
    const server_url = this._reconnection_token
      ? `${this._server_url}&reconnection_token=${this._reconnection_token}`
      : this._server_url;
    console.info("Receating a new connection to ", server_url.split("?")[0]);
    this._websocket = new WebSocket(server_url);
    this._websocket.binaryType = "arraybuffer";
    this._websocket.onmessage = event => {
      const data = event.data;
      this._handle_message(data);
    };
    const self = this;
    this._websocket.onclose = function() {
      console.log("websocket closed");
      self._websocket = null;
    };
    const promise = await new Promise(resolve => {
      this._websocket.addEventListener("open", resolve);
    });
    return await waitFor(
      promise,
      this._timeout,
      "Timeout Error: Failed connect to the server " + server_url.split("?")[0]
    );
  }

  async emit_message(data) {
    assert(this._handle_message, "No handler for message");
    if (!this._websocket) {
      await this.open();
    }
    try {
      if (data.buffer) data = data.buffer;
      this._websocket.send(data);
    } catch (exp) {
      //   data = msgpack_unpackb(data);
      console.error(`Failed to send data, error: ${exp}`);
      throw exp;
    }
  }

  async disconnect(reason) {
    const ws = this._websocket;
    this._websocket = null;
    if (ws) {
      ws.close(1000, reason);
    }
    console.info(`Websocket connection disconnected (${reason})`);
  }
}

function normalizeServerUrl(server_url) {
  if (!server_url) throw new Error("server_url is required");
  if (server_url.startsWith("http://")) {
    server_url =
      server_url.replace("http://", "ws://").replace(/\/$/, "") + "/ws";
  } else if (server_url.startsWith("https://")) {
    server_url =
      server_url.replace("https://", "wss://").replace(/\/$/, "") + "/ws";
  }
  return server_url;
}

export async function login(config) {
  const server_url = normalizeServerUrl(config.server_url);
  const service_id = config.login_service_id || "public/*:hypha-login";
  const timeout = config.login_timeout || 60;
  const callback = config.login_callback;

  const server = await connectToServer({
    name: "initial login client",
    server_url: server_url
  });
  try {
    const svc = await server.get_service(service_id);
    const context = await svc.start();
    if (callback) {
      await callback(context);
    } else {
      console.log(`Please open your browser and login at ${context.login_url}`);
    }
    return await svc.check(context.key, timeout);
  } catch (error) {
    throw error;
  } finally {
    await server.disconnect();
  }
}

export async function connectToServer(config) {
  let clientId = config.client_id;
  if (!clientId) {
    clientId = randId();
  }
  let server_url = normalizeServerUrl(config.server_url);

  let connection = new WebsocketRPCConnection(
    server_url,
    clientId,
    config.workspace,
    config.token,
    config.method_timeout || 5
  );
  await connection.open();
  const rpc = new RPC(connection, {
    client_id: clientId,
    manager_id: "workspace-manager",
    default_context: { connection_type: "websocket" },
    name: config.name,
    method_timeout: config.method_timeout
  });
  const wm = await rpc.get_remote_service("workspace-manager:default");
  wm.rpc = rpc;

  async function _export(api) {
    api.id = "default";
    api.name = config.name || api.id;
    await rpc.register_service(api, true);
    // const svc = await rpc.get_remote_service(rpc._client_id + ":default");
    // if (svc.setup) {
    //   await svc.setup();
    // }
  }

  async function getPlugin(query) {
    return await wm.get_service(query + ":default");
  }

  async function disconnect() {
    await rpc.disconnect();
    await connection.disconnect();
  }

  wm.export = _export;
  wm.getPlugin = getPlugin;
  wm.listPlugins = wm.listServices;
  wm.disconnect = disconnect;
  wm.registerCodec = rpc.register_codec.bind(rpc);
  if (config.webrtc) {
    await registerRTCService(wm, clientId);
  }
  if (wm.get_service || wm.getService) {
    const _get_service = wm.get_service || wm.getService;
    wm.get_service = async function(query, webrtc) {
      assert(
        [undefined, true, false, "auto"].includes(webrtc),
        "webrtc must be true, false or 'auto'"
      );
      if (webrtc === undefined && config.webrtc) webrtc = "auto";
      const svc = await _get_service(query);
      if (webrtc === true || webrtc === "auto") {
        if (svc.id.includes(":") && svc.id.includes("/")) {
          const client = svc.id.split(":")[0];
          // Assuming that the client registered a webrtc service with the same client_id
          const peer = await getRTCService(
            wm,
            client + ":" + client.split("/")[1]
          );
          return await peer.get_service(query);
        }
        if (webrtc === true) {
          throw new Error("Cannot use webrtc for a non-remote service");
        }
      }
      return svc;
    };
    wm.getService = wm.get_service;
  }
  return wm;
}
