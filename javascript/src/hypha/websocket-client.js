import { RPC, API_VERSION } from "./rpc.js";
import { assert, loadRequirements, randId, waitFor } from "./utils.js";
import { getRTCService, registerRTCService } from "./webrtc-client.js";

export { RPC, API_VERSION };
export { version as VERSION } from "../../package.json";
export { loadRequirements };
export { getRTCService, registerRTCService };

const MAX_RETRY = 10000;

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
    this._handle_connect = null; // Connection open event handler
    this._disconnect_handler = null; // Disconnection event handler
    this._timeout = timeout * 1000; // Convert seconds to milliseconds
    this._WebSocketClass = WebSocketClass || WebSocket; // Allow overriding the WebSocket class
    this._opening = null;
    this._closing = false;
    this._legacy_auth = null;
    this.connection_info = null;
  }

  on_message(handler) {
    assert(handler, "handler is required");
    this._handle_message = handler;
  }

  on_connect(handler){
    this._handle_connect = handler;
    if (this._websocket && this._websocket.readyState === WebSocket.OPEN) {
      this._handle_connect(this);
    }
  }

  on_disconnected(handler) {
    this._disconnect_handler = handler;
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
      if (!this._legacy_auth) {
        // Send authentication info as the first message if connected without query params
        const authInfo = JSON.stringify({
          client_id: this._client_id,
          workspace: this._workspace,
          token: this._token,
          reconnection_token: this._reconnection_token
        });
        this._websocket.send(authInfo);
        // Wait for the first message from the server
        await waitFor(
          new Promise((resolve, reject) => {
            this._websocket.onmessage = event => {
              const data = event.data;
              const first_message = JSON.parse(data);
              if (!first_message.success) {
                const error = first_message.error || "Unknown error";
                console.error("Failed to connect, " + error);
                this.connection_info = None;
                reject(new Error(error));
              } else if (first_message) {
                console.log(
                  "Successfully connected: " + JSON.stringify(first_message)
                );
                this.connection_info = first_message;
              }
              resolve();
            };
          }),
          this._timeout / 1000.0,
          "Failed to receive the first message from the server"
        );
      }

      this._websocket.onmessage = event => {
        const data = event.data;
        this._handle_message(data);
      };

      if (this._handle_connect) {
        await this._handle_connect(this);
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
  if (config.server) {
    config.server_url = config.server_url || config.server.url;
    config.WebSocketClass =
      config.WebSocketClass || config.server.WebSocketClass;
  }
  let clientId = config.client_id;
  if (!clientId) {
    clientId = randId();
    config.client_id = clientId;
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
  let workspace = config.workspace
  if(connection.connection_info){
    workspace = connection.connection_info.workspace
  }
  const rpc = new RPC(connection, {
    client_id: clientId,
    workspace,
    manager_id: "workspace-manager",
    default_context: { connection_type: "websocket" },
    name: config.name,
    method_timeout: config.method_timeout,
    app_id: config.app_id,
  });
  const wm = await rpc.get_remote_service("workspace-manager:default");
  wm.rpc = rpc;

  async function _export(api) {
    api.id = "default";
    api.name = api.name || config.name || api.id;
    api.description = api.description || config.description
    api.docs = api.docs || config.docs
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

  wm.config["client_id"] = clientId;
  wm.export = _export;
  wm.getPlugin = getPlugin;
  wm.listPlugins = wm.listServices;
  wm.disconnect = disconnect;
  wm.registerCodec = rpc.register_codec.bind(rpc);
  wm.emit = rpc.emit
  wm.on = rpc.on
  if(rpc.manager_id){
    rpc.on("force-exit", async (message) => {
      if (message.from.endsWith("/" + rpc.manager_id)){
        console.log("Disconnecting from server, reason:", message.reason)
        await disconnect()
      }
    });
  }
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

class LocalWebSocket {
  constructor(url, client_id, workspace) {
    this.url = url;
    this.onopen = () => {};
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onerror = () => {};
    this.client_id = client_id;
    this.workspace = workspace;
    const context = typeof window !== "undefined" ? window : self;
    const isWindow = typeof window !== "undefined";
    this.postMessage = message => {
      if (isWindow) {
        window.parent.postMessage(message, "*");
      } else {
        self.postMessage(message);
      }
    };

    this.readyState = WebSocket.CONNECTING;
    context.addEventListener(
      "message",
      event => {
        const { type, data, to } = event.data;
        if (to !== this.client_id) {
          console.debug("message not for me", to, this.client_id);
          return;
        }
        switch (type) {
          case "message":
            if (this.readyState === WebSocket.OPEN && this.onmessage) {
              this.onmessage({ data: data });
            }
            break;
          case "connected":
            this.readyState = WebSocket.OPEN;
            this.onopen(event);
            break;
          case "closed":
            this.readyState = WebSocket.CLOSED;
            this.onclose(event);
            break;
          default:
            break;
        }
      },
      false
    );

    if (!this.client_id) throw new Error("client_id is required");
    if (!this.workspace) throw new Error("workspace is required");
    this.postMessage({
      type: "connect",
      url: this.url,
      from: this.client_id,
      workspace: this.workspace
    });
  }

  send(data) {
    if (this.readyState === WebSocket.OPEN) {
      this.postMessage({
        type: "message",
        data: data,
        from: this.client_id,
        workspace: this.workspace
      });
    }
  }

  close() {
    this.readyState = WebSocket.CLOSING;
    this.postMessage({
      type: "close",
      from: this.client_id,
      workspace: this.workspace
    });
    this.onclose();
  }

  addEventListener(type, listener) {
    if (type === "message") {
      this.onmessage = listener;
    }
    if (type === "open") {
      this.onopen = listener;
    }
    if (type === "close") {
      this.onclose = listener;
    }
    if (type === "error") {
      this.onerror = listener;
    }
  }
}

export function setupLocalClient({
  enable_execution = false,
  on_ready = null
}) {
  return new Promise((resolve, reject) => {
    const context = typeof window !== "undefined" ? window : self;
    const isWindow = typeof window !== "undefined";
    context.addEventListener(
      "message",
      event => {
        const {
          type,
          server_url,
          workspace,
          client_id,
          token,
          method_timeout,
          name,
          config
        } = event.data;

        if (type === "initializeHyphaClient") {
          if (!server_url || !workspace || !client_id) {
            console.error("server_url, workspace, and client_id are required.");
            return;
          }

          if (!server_url.startsWith("https://local-hypha-server:")) {
            console.error(
              "server_url should start with https://local-hypha-server:"
            );
            return;
          }

          connectToServer({
            server_url,
            workspace,
            client_id,
            token,
            method_timeout,
            name
          }).then(async server => {
            globalThis.api = server;
            try {
              // for iframe
              if (isWindow && enable_execution) {
                function loadScript(script) {
                  return new Promise((resolve, reject) => {
                    const scriptElement = document.createElement("script");
                    scriptElement.innerHTML = script.content;
                    scriptElement.lang = script.lang;

                    scriptElement.onload = () => resolve();
                    scriptElement.onerror = e => reject(e);

                    document.head.appendChild(scriptElement);
                  });
                }
                if (config.styles && config.styles.length > 0) {
                  for (const style of config.styles) {
                    const styleElement = document.createElement("style");
                    styleElement.innerHTML = style.content;
                    styleElement.lang = style.lang;
                    document.head.appendChild(styleElement);
                  }
                }
                if (config.links && config.links.length > 0) {
                  for (const link of config.links) {
                    const linkElement = document.createElement("a");
                    linkElement.href = link.url;
                    linkElement.innerText = link.text;
                    document.body.appendChild(linkElement);
                  }
                }
                if (config.windows && config.windows.length > 0) {
                  for (const w of config.windows) {
                    document.body.innerHTML = w.content;
                    break;
                  }
                }
                if (config.scripts && config.scripts.length > 0) {
                  for (const script of config.scripts) {
                    if (script.lang !== "javascript")
                      throw new Error("Only javascript scripts are supported");
                    await loadScript(script); // Await the loading of each script
                  }
                }
              }
              // for web worker
              else if (
                !isWindow &&
                enable_execution &&
                config.scripts &&
                config.scripts.length > 0
              ) {
                for (const script of config.scripts) {
                  if (script.lang !== "javascript")
                    throw new Error("Only javascript scripts are supported");
                  eval(script.content);
                }
              }

              if (on_ready) {
                await on_ready(server, config);
              }
              resolve(server);
            } catch (e) {
              // If any script fails to load, send an error message
              await server.update_client_info({
                id: client_id,
                error: e.message
              });
              reject(e);
            }
          });
        }
      },
      false
    );
    if (isWindow) {
      window.parent.postMessage({ type: "hyphaClientReady" }, "*");
    } else {
      self.postMessage({ type: "hyphaClientReady" });
    }
  });
}
