/**
 * Contains the routines loaded by the plugin iframe under web-browser
 * in case when worker failed to initialize
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { connectRPC } from "./pluginCore.js";
import { RPC, API_VERSION } from "./rpc.js";
import { MessageEmitter, randId, normalizeConfig } from "./utils.js";
import io from "socket.io-client";

export { setupRPC, waitForInitialization } from "./main.js";
export { version as VERSION } from "../package.json";
export { RPC, API_VERSION };

export class Connection extends MessageEmitter {
  constructor(config) {
    super(config && config.debug);
    this.config = config || {};
    this.peer_id = randId();
  }
  init() {
    return new Promise((resolve, reject) => {
      const config = this.config;
      const url = config.server_url.replace(
        "http://localhost",
        "http://127.0.0.1"
      );
      const extraHeaders = {};
      if (config.token) {
        extraHeaders.Authorization = "Bearer " + config.token;
      }
      const basePath = new URL(url).pathname;
      // Note: extraHeaders only works for polling transport (the default)
      // If we switch to websocket only, the headers won't be respected
      const socket = io(url, {
        withCredentials: true,
        extraHeaders,
        path:
          (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) +
          "/socket.io"
      });
      socket.on("connect", () => {
        socket.emit("register_plugin", config, result => {
          if (!result.success) {
            console.error(result.detail);
            reject(result.detail);
            return;
          }
          this.plugin_id = result.plugin_id;
          socket.on("plugin_message", data => {
            if (data.peer_id === this.peer_id) {
              this._fire(data.type, data);
            } else if (this.config.debug) {
              console.log(
                `connection peer id mismatch ${data.peer_id} !== ${this.peer_id}`
              );
            }
          });

          this.once("initialize", () => {
            if (!this.rpc) {
              this.rpc = connectRPC(this, config);
            } else {
              this.rpc.once("remoteReady", () => {
                this.rpc.sendInterface();
              });
            }
            this.connect();
            resolve();
          });
          this.emit({
            type: "imjoyRPCReady",
            config: config,
            peer_id: this.peer_id
          });
        });
        this._disconnected = false;
      });
      socket.on("connect_error", () => {
        reject("connection error");
        this._fire("connectFailure");
      });
      socket.on("disconnect", () => {
        reject("disconnected");
        this.disconnect();
        this._fire("disconnected");
      });
      this.socket = socket;
    });
  }
  connect() {
    this.emit({
      type: "initialized",
      config: this.config,
      origin: globalThis.location.origin,
      peer_id: this.peer_id
    });
    this._fire("connected");
  }
  reset() {
    this._event_handlers = {};
    this._once_handlers = {};
  }
  execute() {
    throw new Error("Execution is not allowed for socketio connection");
  }
  disconnect() {
    this._fire("beforeDisconnect");
    this.socket.disconnect();
    this.init();
    this._fire("disconnected");
  }
  emit(data) {
    data.plugin_id = this.plugin_id;
    this.socket.emit("plugin_message", data, result => {
      if (!result.success) this._fire("error", data.detail);
    });
  }
}

export function connectToServer(config) {
  config = config || {};
  if (!config.server_url) throw new Error("Server URL is not specified.");
  config.name = config.name || randId();
  config = normalizeConfig(config);
  return new Promise((resolve, reject) => {
    const handleEvent = e => {
      const api = e.detail;
      if (config.expose_api_globally) {
        globalThis.api = api;
      }
      // imjoy plugin api
      resolve(api);
      globalThis.removeEventListener("imjoy_remote_api_ready", handleEvent);
    };
    globalThis.addEventListener("imjoy_remote_api_ready", handleEvent);
    config = config || {};
    config.dedicated_thread = false;
    config.lang = "javascript";
    config.api_version = API_VERSION;
    const conn = new Connection(config);
    conn.init().catch(reject);
  });
}
