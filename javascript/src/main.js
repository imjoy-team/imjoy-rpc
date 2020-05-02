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
    if (m.type === "initialized") {
      // send config to the worker
      worker.postMessage({ type: "connectRPC", config: config });
      clearTimeout(fallbackTimeout);
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
    parent.postMessage(m, "*", transferables);
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
  config.allow_execution = config.allow_execution || true;
  config.enable_service_worker = config.enable_service_worker || true;
  if (config.enable_service_worker) {
    setupServiceWorker(config.target_origin, config.cache_requirements);
  }
  if (config.cache_requirements) {
    delete config.cache_requirements;
  }
  // expose the api object to window globally.
  // note: the returned value will be null for webworker
  window.api = await imjoyRPC.setupRPC(config);

  return window.api;
}

export function setupRPC(config) {
  config = config || {};
  const plugin_type = config.type || getParamValue("_plugin_type") || "window";
  config.type = plugin_type;
  config.id = config.id || randId();
  config.allow_execution = config.allow_execution || false;
  config.token = config.token = randId();
  // remove functions
  config = Object.keys(config).reduce((p, c) => {
    if (typeof config[c] !== "function") p[c] = config[c];
    return p;
  }, {});
  return new Promise((resolve, reject) => {
    if (inIframe()) {
      if (plugin_type === "web-worker") {
        try {
          setupWebWorker(config);
        } catch (e) {
          // fallback to iframe
          setupIframe(config);
        }
      } else if (
        plugin_type === "web-python" ||
        plugin_type === "web-python-window"
      ) {
        setupWebPython(config);
      } else if (plugin_type === "iframe" || plugin_type === "window") {
        setupIframe(config);
      } else {
        console.error("Unsupported plugin type: " + plugin_type);
        reject("Unsupported plugin type: " + plugin_type);
      }
      try {
        window.addEventListener("imjoy_remote_api_ready", e => {
          // imjoy plugin api
          resolve(e.detail);
        });
      } catch (e) {
        reject(e);
      }
    } else {
      reject(new Error("imjoy-rpc should only run inside an iframe."));
    }
  });
}
