import { RPC, API_VERSION } from "./rpc.js";
import { assert, loadRequirements, randId, waitFor } from "./utils.js";
import { getRTCService, registerRTCService } from "./webrtc-client.js";

export { RPC, API_VERSION };
export { version as VERSION } from "../../package.json";
export { loadRequirements };
export { getRTCService, registerRTCService };

class WebsocketRPCConnection {
  constructor(
    server_url,
    client_id,
    workspace,
    token,
    timeout = 60,
    WebSocketClass = null
  ) {
    assert(server_url && client_id, "server_url and client_id are required");
    this._server_url = server_url;
    this._client_id = client_id;
    this._workspace = workspace;
    this._token = token;
    this._reconnection_token = null;
    this._websocket = null;
    this._handle_message = null;
    this._disconnect_handler = null; // Disconnection event handler
    this._on_open = null; // Connection open event handler
    this._timeout = timeout * 1000; // Convert seconds to milliseconds
    this._WebSocketClass = WebSocketClass || WebSocket; // Allow overriding the WebSocket class
    this._opening = null;
    this._closing = false;
    this._legacy_auth = null;
  }

  on_message(handler) {
    assert(handler, "handler is required");
    this._handle_message = handler;
  }

  on_disconnected(handler) {
    this._disconnect_handler = handler;
  }

  on_open(handler) {
    this._on_open = handler;
  }

  set_reconnection_token(token) {
    this._reconnection_token = token;
  }

  async _attempt_connection(server_url, attempt_fallback = true) {
    return new Promise((resolve, reject) => {
      this._legacy_auth = false;
      const websocket = new this._WebSocketClass(server_url);
      websocket.binaryType = "arraybuffer";

      websocket.onopen = () => {
        console.info("WebSocket connection established");
        resolve(websocket);
      };

      websocket.onerror = event => {
        console.error("WebSocket connection error:", event);
        reject(event);
      };

      websocket.onclose = event => {
        if (event.code === 1003 && attempt_fallback) {
          console.info(
            "Received 1003 error, attempting connection with query parameters."
          );
          this._attempt_connection_with_query_params(server_url)
            .then(resolve)
            .catch(reject);
        } else if (this._disconnect_handler) {
          this._disconnect_handler(this, event.reason);
        }
      };

      websocket.onmessage = event => {
        const data = event.data;
        this._handle_message(data);
      };
    });
  }

  async _attempt_connection_with_query_params(server_url) {
    // Initialize an array to hold parts of the query string
    const queryParamsParts = [];

    // Conditionally add each parameter if it has a non-empty value
    if (this._client_id)
      queryParamsParts.push(`client_id=${encodeURIComponent(this._client_id)}`);
    if (this._workspace)
      queryParamsParts.push(`workspace=${encodeURIComponent(this._workspace)}`);
    if (this._token)
      queryParamsParts.push(`token=${encodeURIComponent(this._token)}`);
    if (this._reconnection_token)
      queryParamsParts.push(
        `reconnection_token=${encodeURIComponent(this._reconnection_token)}`
      );

    // Join the parts with '&' to form the final query string, prepend '?' if there are any parameters
    const queryString =
      queryParamsParts.length > 0 ? `?${queryParamsParts.join("&")}` : "";

    // Construct the full URL by appending the query string if it exists
    const full_url = server_url + queryString;

    this._legacy_auth = true; // Assuming this flag is needed for some other logic
    return await this._attempt_connection(full_url, false);
  }

  async open() {
    if (this._closing || this._websocket) {
      return; // Avoid opening a new connection if closing or already open
    }
    try {
      this._opening = true;
      this._websocket = await this._attempt_connection(this._server_url);
      if (this._legacy_auth) {
        // Send authentication info as the first message if connected without query params
        const authInfo = JSON.stringify({
          client_id: this._client_id,
          workspace: this._workspace,
          token: this._token,
          reconnection_token: this._reconnection_token
        });
        this._websocket.send(authInfo);
      }

      if (this._on_open) {
        this._on_open();
      }
    } catch (error) {
      console.error("Failed to connect to", this._server_url, error);
    } finally {
      this._opening = false;
    }
  }

  async emit_message(data) {
    if (this._closing) {
      throw new Error("Connection is closing");
    }
    await this._opening;
    if (!this._websocket || this._websocket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket connection is not open");
    }
    try {
      this._websocket.send(data);
    } catch (exp) {
      console.error(`Failed to send data, error: ${exp}`);
      throw exp;
    }
  }

  disconnect(reason) {
    this._closing = true;
    if (this._websocket && this._websocket.readyState === WebSocket.OPEN) {
      this._websocket.close(1000, reason);
      console.info(`WebSocket connection disconnected (${reason})`);
    }
  }
}

function normalizeServerUrl(server_url) {
  if (!server_url) throw new Error("server_url is required");
  if (server_url.startsWith("http://")) {
    return server_url.replace("http://", "ws://").replace(/\/$/, "") + "/ws";
  } else if (server_url.startsWith("https://")) {
    return server_url.replace("https://", "wss://").replace(/\/$/, "") + "/ws";
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
    config.method_timeout || 60,
    config.WebSocketClass
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
  wm.on_disconnected = connection.on_disconnected.bind(connection);
  wm.on_open = connection.on_open.bind(connection);
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
