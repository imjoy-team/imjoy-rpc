import { RPC, API_VERSION } from "./rpc.js";
import { assert, loadRequirements, randId, waitFor } from "./utils.js";
import { getRTCService, registerRTCService } from "./webrtc-client.js";

export { RPC, API_VERSION };
export { version as VERSION } from "../../package.json";
export { loadRequirements };
export { getRTCService, registerRTCService };

const MAX_RETRY = 10000;

class WebsocketRPCConnection {
  constructor(server_url, client_id, workspace, token, timeout = 60) {
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
    this._timeout = timeout * 1000; // converting to ms
    this._opening = null;
    this._retry_count = 0;
    this._closing = false;
  }

  set_reconnection_token(token) {
    this._reconnection_token = token;
  }

  on_message(handler) {
    assert(handler, "handler is required");
    this._handle_message = handler;
  }

  async open() {
    if (this._opening) {
      return this._opening;
    }
    this._opening = new Promise((resolve, reject) => {
      const server_url = this._reconnection_token
        ? `${this._server_url}&reconnection_token=${this._reconnection_token}`
        : this._server_url;
      console.info("Creating a new connection to ", server_url.split("?")[0]);

      const websocket = new WebSocket(server_url);
      websocket.binaryType = "arraybuffer";
      websocket.onmessage = event => {
        const data = event.data;
        this._handle_message(data);
      };

      websocket.onopen = () => {
        this._websocket = websocket;
        console.info("WebSocket connection established");
        this._retry_count = 0; // Reset retry count
        resolve();
      }

      websocket.onclose = event => {
        console.log("websocket closed");
        if (!this._closing) {
          console.log("Websocket connection interrupted, retrying...");
          this._retry_count++;
          setTimeout(() => this.open(), this._timeout);
        }
        this._websocket = null;
      };

      websocket.onerror = event => {
        console.log("Error occurred in websocket connection: ", event);
        reject(new Error("Websocket connection failed."));
        this._websocket = null;
      };
    }).finally(() => {
      this._opening = null;
    });
    return this._opening;
  }

  async emit_message(data) {
    assert(this._handle_message, "No handler for message");
    if (!this._websocket || this._websocket.readyState !== WebSocket.OPEN) {
      await this.open();
    }
    return new Promise((resolve, reject) => {
      if (!this._websocket) {
        reject(new Error("Websocket connection not available"));
      } else if (this._websocket.readyState === WebSocket.CONNECTING) {
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timed out"));
        }, this._timeout);

        this._websocket.addEventListener("open", () => {
          clearTimeout(timeout);
          try {
            this._websocket.send(data);
            resolve();
          } catch (exp) {
            console.error(`Failed to send data, error: ${exp}`);
            reject(exp);
          }
        });
      } else if (this._websocket.readyState === WebSocket.OPEN) {
        try {
          this._websocket.send(data);
          resolve();
        } catch (exp) {
          console.error(`Failed to send data, error: ${exp}`);
          reject(exp);
        }
      } else {
        reject(new Error("WebSocket is not in the OPEN or CONNECTING state"));
      }
    });
  }

  disconnect(reason) {
    this._closing = true;
    const ws = this._websocket;
    this._websocket = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
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
  const service_id = config.login_service_id || "public/*:hypha-login";
  const timeout = config.login_timeout || 60;
  const callback = config.login_callback;

  const server = await connectToServer({
    name: "initial login client",
    server_url: config.server_url
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
    config.method_timeout || 60
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
    await registerRTCService(wm, clientId + "-rtc", config.webrtc_config);
  }
  if (wm.get_service || wm.getService) {
    const _get_service = wm.get_service || wm.getService;
    wm.get_service = async function(query, webrtc, webrtc_config) {
      assert(
        [undefined, true, false, "auto"].includes(webrtc),
        "webrtc must be true, false or 'auto'"
      );
      const svc = await _get_service(query);
      if (webrtc === true || webrtc === "auto") {
        if (svc.id.includes(":") && svc.id.includes("/")) {
          const client = svc.id.split(":")[0];
          try {
            // Assuming that the client registered a webrtc service with the client_id + "-rtc"
            const peer = await getRTCService(
              wm,
              client + ":" + client.split("/")[1] + "-rtc",
              webrtc_config
            );
            const rtcSvc = await peer.get_service(svc.id.split(":")[1]);
            rtcSvc._webrtc = true;
            rtcSvc._peer = peer;
            rtcSvc._service = svc;
            return rtcSvc;
          } catch (e) {
            console.warn(
              "Failed to get webrtc service, using websocket connection",
              e
            );
          }
        }
        if (webrtc === true) {
          throw new Error("Failed to get the service via webrtc");
        }
      }
      return svc;
    };
    wm.getService = wm.get_service;
  }
  return wm;
}
