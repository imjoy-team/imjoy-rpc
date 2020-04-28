/**
 * Contains the code executed in the sandboxed frame under web-browser
 *
 * Tries to create a Web-Worker inside the frame and set up the
 * communication between the worker and the parent window. Some
 * browsers restrict creating a worker inside a sandboxed iframe - if
 * this happens, the plugin initialized right inside the frame (in the
 * same thread)
 */
import PluginWorker from "./pluginWebWorker.js";
import setupIframe from "./pluginIframe.js";
import setupWebPython from "./pluginWebPython.js";
import { setupServiceWorker, cacheRequirements } from "./utils.js";

export { RPC } from "./rpc.js";
export { Connection } from "./connection.js";
export { Whenable } from "./utils.js";

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
  worker.addEventListener("message", function(m) {
    let transferables = undefined;
    if (m.data.type === "initialized") {
      // remove functions
      const filteredConfig = Object.keys(config).reduce((p, c) => {
        if (typeof config[c] !== "function") p[c] = config[c];
        return p;
      }, {});
      // send config to the worker
      worker.postMessage({
        data: { type: "setupCore", config: filteredConfig }
      });
      clearTimeout(fallbackTimeout);
    } else if (m.data.type === "imjoy_remote_api_ready") {
      // if it's a webworker, there will be no api object returned
      window.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: null })
      );
    } else if (
      m.data.type === "cacheRequirements" &&
      config.cache_requirements
    ) {
      config.cache_requirements(m.data.requirements);
    } else if (m.data.type === "disconnect") {
      worker.terminate();
    } else if (m.data.type === "message") {
      if (m.data.data.__transferables__) {
        transferables = m.data.data.__transferables__;
        delete m.data.data.__transferables__;
      }
    }
    parent.postMessage(m.data, "*", transferables);
  });

  window.addEventListener("message", function(m) {
    let transferables = undefined;
    if (m.data.type === "message") {
      if (m.data.data.__transferables__) {
        transferables = m.data.data.__transferables__;
        delete m.data.data.__transferables__;
      }
    }
    worker.postMessage(m.data, transferables);
  });
}

export async function setupBaseFrame(config) {
  config = config || {};
  config.allow_execution = config.allow_execution || true;
  config.enable_service_worker = config.enable_service_worker || true;
  if (config.enable_service_worker) {
    setupServiceWorker();
    config.cache_requirements = config.cache_requirements || cacheRequirements;
  }
  // expose the api object to window globally.
  // note: the returned value will be null for webworker
  window.api = await imjoyRPC.setupRPC(config);

  return window.api;
}

export function setupRPC(config) {
  config = config || {};
  return new Promise((resolve, reject) => {
    if (inIframe()) {
      const plugin_type =
        config.plugin_type || getParamValue("_plugin_type") || "window";
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

class CustomRPC {
  init(config) {
    parent.postMessage(
      {
        type: "initialized",
        dedicatedThread: false,
        allowExecution: config.allow_execution
      },
      "*"
    );

    // event listener for the plugin message
    window.addEventListener("message", e => {
      const targetOrigin = config.target_origin || "*";
      if (targetOrigin === "*" || e.origin === targetOrigin) {
        var m = e.data && e.data.data;
        switch (m && m.type) {
          case "import":
          case "importJailed": // already jailed in the iframe
            this.import(m.url);
            break;
          case "execute":
            this.execute(m.code);
            break;
          case "message":
            this.processMessage(m.data);
            break;
        }
      }
    });
  }

  import() {}

  execute() {}

  processMessage() {}
}
