import { Whenable } from "./utils.js";

export class BasicConnection {
  constructor(sourceIframe) {
    this._init = new Whenable(true);
    this._fail = new Whenable(true);
    this._disconnected = false;
    this.platformSpec = {};
    this._executeSCb = function() {};
    this._executeFCb = function() {};
    this._messageHandler = function() {};
    this._frame = sourceIframe;

    // TODO: remove listener when disconnected
    window.addEventListener("message", e => {
      if (this._frame.contentWindow && e.source === this._frame.contentWindow) {
        const m = e.data;
        switch (m && m.type) {
          case "spec":
            this.platformSpec = m.spec;
            break;
          case "initialized":
            this.platformSpec = m.spec;
            this._init.emit(this.platformSpec);
            break;
          case "executeSuccess":
            this._executeSCb();
            break;
          case "executeFailure":
            this._executeFCb(m.error);
            break;
          default:
            this._messageHandler(m);
        }
      }
    });
  }

  execute(code) {
    return new Promise((resolve, reject) => {
      this._executeSCb = resolve;
      this._executeFCb = reject;
      if (this.platformSpec.allowExecution) {
        this.send({ type: "execute", code: code });
      } else {
        reject("Connection does not allow execution");
      }
    });
  }

  /**
   * Sets-up the handler to be called upon the BasicConnection
   * initialization is completed.
   *
   * For the web-browser environment, the handler is issued when
   * the plugin worker successfully imported and executed the
   * _pluginWebWorker.js or _pluginWebIframe.js, and replied to
   * the application site with the initImprotSuccess message.
   *
   * @param {Function} handler to be called upon connection init
   */
  onInit(handler) {
    this._init.whenEmitted(handler);
  }

  /**
   * Sets-up the handler to be called upon the BasicConnection
   * failed.
   *
   * For the web-browser environment, the handler is issued when
   * the plugin worker successfully imported and executed the
   * _pluginWebWorker.js or _pluginWebIframe.js, and replied to
   * the application site with the initImprotSuccess message.
   *
   * @param {Function} handler to be called upon connection init
   */
  onFailed(handler) {
    this._fail.whenEmitted(handler);
  }

  /**
   * Sends a message to the plugin site
   *
   * @param {Object} data to send
   */
  send(data, transferables) {
    this._frame.contentWindow &&
      this._frame.contentWindow.postMessage(data, "*", transferables);
  }

  /**
   * Adds a handler for a message received from the plugin site
   *
   * @param {Function} handler to call upon a message
   */
  onMessage(handler) {
    this._messageHandler = handler;
  }

  /**
   * Adds a handler for the event of plugin disconnection
   * (not used in case of Worker)
   *
   * @param {Function} handler to call upon a disconnect
   */
  onDisconnect(handler) {
    this._disconnectHandler = handler;
  }

  /**
   * Disconnects the plugin (= kills the frame)
   */
  disconnect() {
    if (!this._disconnected) {
      this._disconnected = true;
      if (typeof this._frame !== "undefined") {
        this._frame.parentNode.removeChild(this._frame);
      } // otherwise farme is not yet created
      if (this._disconnectHandler) this._disconnectHandler();
    }
  }
}
