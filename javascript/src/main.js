/**
 * Contains the code executed in the sandboxed frame under web-browser
 *
 * Tries to create a Web-Worker inside the frame and set up the
 * communication between the worker and the parent window. Some
 * browsers restrict creating a worker inside a sandboxed iframe - if
 * this happens, the plugin initialized right inside the frame (in the
 * same thread)
 */
import PluginWorker from "./plugin.webworker.js";
import setupIframe from "./pluginIframe.js";
import setupWebPython from "./pluginWebPython.js";
import { setupServiceWorker, randId } from "./utils.js";

export { RPC, API_VERSION } from "./rpc.js";
export { version as VERSION } from "../package.json";

function inIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function getParamValue(paramName) {
  const url = window.location.search.substring(1); //get rid of "?" in querystring
  const qArray = url.split("&"); //get key-value pairs
  for (let i = 0; i < qArray.length; i++) {
    const pArr = qArray[i].split("="); //split key and value
    if (pArr[0] === paramName) return pArr[1]; //return value
  }
}

/**
 * Initializes the plugin inside a web worker. May throw an exception
 * in case this was not permitted by the browser.
 */
function setupWebWorker(config) {
  if (!config.allow_execution)
    throw new Error(
      "web-worker plugin can only work with allow_execution=true"
    );
  const worker = new PluginWorker();
  // mixed content warning in Chrome silently skips worker
  // initialization without exception, handling this with timeout
  const fallbackTimeout = setTimeout(function() {
    worker.terminate();
    console.warn(
      `Plugin failed to start as a web-worker, running in an iframe instead.`
    );
    setupIframe(config);
  }, 2000);

  // forwarding messages between the worker and parent window
  worker.addEventListener("message", function(e) {
    let transferables = undefined;
    const m = e.data;
    if (m.type === "worker-ready") {
      // send config to the worker
      worker.postMessage({ type: "connectRPC", config: config });
      clearTimeout(fallbackTimeout);
      return;
    } else if (m.type === "initialized") {
      // complete the missing fields
      m.config = Object.assign({}, config, m.config);
    } else if (m.type === "imjoy_remote_api_ready") {
      // if it's a webworker, there will be no api object returned
      window.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: null })
      );
    } else if (
      m.type === "cacheRequirements" &&
      typeof cache_requirements === "function"
    ) {
      cache_requirements(m.requirements);
    } else if (m.type === "disconnect") {
      worker.terminate();
    } else {
      if (m.__transferables__) {
        transferables = m.__transferables__;
        delete m.__transferables__;
      }
    }
    parent.postMessage(m, config.target_origin || "*", transferables);
  });

  window.addEventListener("message", function(e) {
    let transferables = undefined;
    const m = e.data;
    if (m.__transferables__) {
      transferables = m.__transferables__;
      delete m.__transferables__;
    }
    worker.postMessage(m, transferables);
  });
}

export async function setupBaseFrame(config) {
  config = config || {};
  config.name = config.name || "Generic RPC App";
  config.type = config.type || getParamValue("_plugin_type") || "window";
  config.allow_execution = config.allow_execution || true;
  config.enable_service_worker = config.enable_service_worker || true;
  if (config.enable_service_worker) {
    setupServiceWorker(config.target_origin, config.cache_requirements);
  }
  if (config.cache_requirements) {
    delete config.cache_requirements;
  }
  config.forwarding_functions = config.forwarding_functions;
  if (config.forwarding_functions === undefined) {
    config.forwarding_functions = ["close", "on", "off", "emit"];
    if (["rpc-window", "window", "web-python-window"].includes(config.type)) {
      config.forwarding_functions = config.forwarding_functions.concat([
        "resize",
        "show",
        "hide",
        "refresh"
      ]);
    }
  }
  // expose the api object to window globally.
  // note: the returned value will be null for webworker
  window.api = await imjoyRPC.setupRPC(config);
  return window.api;
}

export function setupRPC(config) {
  config = config || {};
  if (!config.name) throw new Error("Please specify a name for your app.");
  config.version = config.version || "0.1.0";
  config.description =
    config.description || `[TODO: add description for ${config.name} ]`;
  config.type = config.type || "rpc-window";
  config.id = config.id || randId();
  config.allow_execution = config.allow_execution || false;
  // remove functions
  config = Object.keys(config).reduce((p, c) => {
    if (typeof config[c] !== "function") p[c] = config[c];
    return p;
  }, {});
  return new Promise((resolve, reject) => {
    if (inIframe()) {
      if (config.type === "web-worker") {
        try {
          setupWebWorker(config);
        } catch (e) {
          // fallback to iframe
          setupIframe(config);
        }
      } else if (
        config.type === "web-python" ||
        config.type === "web-python-window"
      ) {
        setupWebPython(config);
      } else if (
        ["rpc-window", "rpc-worker", "iframe", "window"].includes(config.type)
      ) {
        setupIframe(config);
      } else {
        console.error("Unsupported plugin type: " + config.type);
        reject("Unsupported plugin type: " + config.type);
      }
      try {
        this.handleEvent = e => {
          // imjoy plugin api
          resolve(e.detail);
          window.removeEventListener("imjoy_remote_api_ready", this);
        };
        window.addEventListener("imjoy_remote_api_ready", this);
      } catch (e) {
        reject(e);
      }
    } else {
      reject(new Error("imjoy-rpc should only run inside an iframe."));
    }
  });
}
