import { RPC, API_VERSION } from "./rpc.js";
import { assert, loadRequirements, randId } from "./utils.js";

export { RPC, API_VERSION };
export { version as VERSION } from "../package.json";
export { loadRequirements };

class WebsocketRPCConnection {
  constructor(server_url, client_id, workspace, token) {
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
    return await new Promise(resolve => {
      this._websocket.addEventListener("open", resolve);
    });
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

export async function connectToServer(config) {
  let clientId = config.client_id;
  if (!clientId) {
    clientId = randId();
  }
  let connection = new WebsocketRPCConnection(
    config.server_url,
    clientId,
    config.workspace,
    config.token
  );
  await connection.open();
  const rpc = new RPC(connection, {
    client_id: clientId,
    root_target_id: "workspace-manager",
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
    const svc = await rpc.get_remote_service(rpc._client_id + ":default");
    if (svc.setup) {
      await svc.setup();
    }
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
  return wm;
}
