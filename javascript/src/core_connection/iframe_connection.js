import { MessageEmitter } from "../utils.js";

const all_connections = {};

export class IframeConnection extends MessageEmitter {
  constructor(sourceIframe) {
    super();
    this._event_handlers = {};
    this._disconnected = false;
    this.pluginConfig = {};
    this._frame = sourceIframe;
    this._access_token = null;
    this._refresh_token = null;
    this._peer_id = null;
    this._plugin_origin = null;
    this.on("initialized", data => {
      this.pluginConfig = data.config;
      // peer_id can only be set for once
      this._peer_id = data.peer_id;
      this._plugin_origin = data.origin || "*";
      all_connections[this._peer_id] = this;
      if (this._plugin_origin !== "*") {
        console.log(
          `connection to the imjoy-rpc peer ${this._peer_id} is limited to origin ${this._plugin_origin}.`
        );
      }
      if (!this._peer_id) {
        throw new Error("Please provide a peer_id for the connection.");
      }
      if (this.pluginConfig.auth) {
        if (this._plugin_origin === "*") {
          console.error(
            "Refuse to transmit the token without an explicit origin, there is a security risk that you may leak the credential to website from other origin. Please specify the `origin` explicitly."
          );
          this._access_token = null;
          this._refresh_token = null;
        }
        if (this.pluginConfig.auth.type !== "jwt") {
          console.error(
            "Unsupported authentication type: " + this.pluginConfig.auth.type
          );
        } else {
          this._expires_in = this.pluginConfig.auth.expires_in;
          this._access_token = this.pluginConfig.auth.access_token;
          this._refresh_token = this.pluginConfig.auth.refresh_token;
        }
      }
    });
  }

  connect() {
    const messageHandler = e => {
      if (this._frame.contentWindow && e.source === this._frame.contentWindow) {
        const target_id = e.data.target_id;
        if (target_id && this._peer_id && target_id !== this._peer_id) {
          const conn = all_connections[target_id];
          if (conn) conn._fire(e.data.type, e.data);
          else
            console.warn(
              `connection with target_id ${target_id} not found, discarding data: `,
              e.data
            );
        } else {
          this._fire(e.data.type, e.data);
        }
      }
    };
    this._messageHandler = messageHandler.bind(this);
    window.addEventListener("message", this._messageHandler);
    this._fire("connected");
  }

  execute(code) {
    return new Promise((resolve, reject) => {
      this.once("executed", result => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve();
        }
      });
      if (this.pluginConfig.allow_execution) {
        this.emit({ type: "execute", code: code });
      } else {
        reject("Connection does not allow execution");
      }
    });
  }

  /**
   * Sends a message to the plugin site
   *
   * @param {Object} data to send
   */
  emit(data) {
    let transferables = undefined;
    if (data.__transferables__) {
      transferables = data.__transferables__;
      delete data.__transferables__;
    }
    if (this._access_token) {
      if (Date.now() >= this._expires_in * 1000) {
        //TODO: refresh access token
        throw new Error("Refresh token is not implemented.");
      }
      data.access_token = this._access_token;
    }
    data.peer_id = this._peer_id || data.peer_id;
    this._frame.contentWindow &&
      this._frame.contentWindow.postMessage(
        data,
        this._plugin_origin || "*",
        transferables
      );
  }

  /**
   * Disconnects the plugin (= kills the frame)
   */
  disconnect(details) {
    if (this._messageHandler)
      window.removeEventListener("message", this._messageHandler);
    if (!this._disconnected) {
      this._disconnected = true;
      if (typeof this._frame !== "undefined") {
        this._frame.parentNode.removeChild(this._frame);
      } // otherwise farme is not yet created
      this._fire("disconnected", details);
    }
    if (this._peer_id && all_connections[this._peer_id])
      delete all_connections[this._peer_id];
  }
}
