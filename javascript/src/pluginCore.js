/**
 * Core plugin script loaded into the plugin process/thread.
 *
 * Initializes the plugin-site API global methods.
 */
import { RPC } from "./rpc.js";

export function connectRPC(connection, config) {
  const application = {};
  config = config || {};

  const rpc = new RPC(connection, config);
  rpc.onGetInterface(function() {
    launchConnected();
  });

  rpc.onRemoteUpdate(function() {
    application.remote = rpc.getRemote();
    if (!application.remote) return;
    const api = application.remote || {};
    if (api.export) {
      console.error("WARNING: overwriting function 'export'.");
    }
    if (api.onload) {
      console.error("WARNING: overwriting function 'onload'.");
    }
    if (api.dispose) {
      console.error("WARNING: overwriting function 'dispose'.");
    }
    api.export = application.setInterface;
    api.onLoad = application.whenConnected;
    api.dispose = application.disconnect;
    if (
      typeof WorkerGlobalScope !== "undefined" &&
      self instanceof WorkerGlobalScope
    ) {
      self.api = api;
      self.postMessage({
        type: "imjoy_remote_api_ready"
      });
    } else if (typeof window) {
      window.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: api })
      );
    }
  });

  var connected = false;
  var connectedHandlers = [];

  var launchConnected = function() {
    if (!connected) {
      connected = true;

      var handler;
      while ((handler = connectedHandlers.pop())) {
        handler();
      }
    }
  };

  var checkHandler = function(handler) {
    var type = typeof handler;
    if (type !== "function") {
      var msg =
        "A function may only be subsribed to the event, " +
        type +
        " was provided instead";
      throw new Error(msg);
    }

    return handler;
  };

  /**
   * Sets a function executed after the connection to the
   * application is estaplished, and the initial interface-exchange
   * messaging is completed
   *
   * @param {Function} handler to be called upon initialization
   */
  application.whenConnected = function(handler) {
    handler = checkHandler(handler);
    if (connected) {
      handler();
    } else {
      connectedHandlers.push(handler);
    }
  };

  /**
   * Sets the plugin interface available to the application
   *
   * @param {Object} _interface to set
   */
  application.setInterface = function(_interface) {
    rpc.setInterface(_interface);
  };

  /**
   * Disconnects the plugin from the application (sending
   * notification message) and destroys itself
   */
  application.disconnect = function(_interface) {
    rpc.disconnect();
  };
}
