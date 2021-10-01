/**
 * Core plugin script loaded into the plugin process/thread.
 *
 * Initializes the plugin-site API global methods.
 */
import { RPC } from "./rpc.js";

export function connectRPC(connection, config) {
  config = config || {};
  const codecs = {};

  const rpc = new RPC(connection, config, codecs);
  rpc.on("getInterface", function() {
    launchConnected();
  });

  rpc.on("remoteReady", function() {
    const api = rpc.getRemote() || {};
    api.registerCodec = function(config) {
      if (!config["name"] || (!config["encoder"] && !config["decoder"])) {
        throw new Error(
          "Invalid codec format, please make sure you provide a name, type, encoder and decoder."
        );
      } else {
        if (config.type) {
          for (let k of Object.keys(codecs)) {
            if (codecs[k].type === config.type || k === config.name) {
              delete codecs[k];
              console.warn("Remove duplicated codec: " + k);
            }
          }
        }
        codecs[config["name"]] = config;
      }
    };
    api.init = function(config) {
      // register a minimal plugin api
      rpc.setInterface({ setup() {} }, config);
    };
    api.disposeObject = function(obj) {
      rpc.disposeObject(obj);
    };
    api.export = function(_interface, config) {
      rpc.setInterface(_interface, config);
    };
    api.onLoad = function(handler) {
      handler = checkHandler(handler);
      if (connected) {
        handler();
      } else {
        connectedHandlers.push(handler);
      }
    };
    api.dispose = function(_interface) {
      rpc.disconnect();
    };

    if (
      typeof WorkerGlobalScope !== "undefined" &&
      self instanceof WorkerGlobalScope
    ) {
      self.api = api;
      self.postMessage({
        type: "imjoy_remote_api_ready"
      });
      self.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: api })
      );
    } else if (typeof window) {
      window.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: api })
      );
    }
  });

  let connected = false;
  const connectedHandlers = [];

  const launchConnected = function() {
    if (!connected) {
      connected = true;

      let handler;
      while ((handler = connectedHandlers.pop())) {
        handler();
      }
    }
  };

  const checkHandler = function(handler) {
    const type = typeof handler;
    if (type !== "function") {
      const msg =
        "A function may only be subsribed to the event, " +
        type +
        " was provided instead";
      throw new Error(msg);
    }
    return handler;
  };

  return rpc;
}
