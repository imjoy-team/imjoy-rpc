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
    this._client_id = client_id;
    this._workspace = workspace;
    // Allow to override the WebSocket class for mocking or testing
    this._WebSocketClass = WebSocketClass;
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

      let websocket = null;
      if (server_url.startsWith("wss://local-hypha-server:")) {
        if (this._WebSocketClass) {
          websocket = new this._WebSocketClass(server_url);
        } else {
          console.log("Using local websocket");
          console.log("Connecting to local websocket " + server_url);
          websocket = new LocalWebSocket(
            server_url,
            this._client_id,
            this._workspace
          );
        }
      } else {
        if (this._WebSocketClass) {
          websocket = new this._WebSocketClass(server_url);
        } else {
          websocket = new WebSocket(server_url);
        }
      }
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
      };

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
            this.onopen();
            break;
          case "closed":
            this.readyState = WebSocket.CLOSED;
            this.onclose();
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

export function setupLocalClient({ enable_execution = false }) {
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
              try {
                for (const script of config.scripts) {
                  if (script.lang !== "javascript")
                    throw new Error("Only javascript scripts are supported");
                  await loadScript(script); // Await the loading of each script
                }
              } catch (e) {
                // If any script fails to load, send an error message
                await server.update_client_info({
                  id: client_id,
                  error: e.message
                });
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
            try {
              for (const script of config.scripts) {
                if (script.lang !== "javascript")
                  throw new Error("Only javascript scripts are supported");
                eval(script.content);
              }
            } catch (e) {
              await server.update_client_info({
                id: client_id,
                error: e.message
              });
            }
          }
        });
      }
    },
    false
  );
}
