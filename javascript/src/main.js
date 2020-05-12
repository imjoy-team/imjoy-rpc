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

function _inIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function _injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.addEventListener("load", resolve);
    script.addEventListener("error", () => {
      document.head.removeChild(script);
      reject("Error loading script: " + src);
    });
    script.addEventListener("abort", () => reject("Script loading aborted."));
    document.head.appendChild(script);
  });
}

if (!window.location.origin) {
  window.location.origin =
    window.location.protocol +
    "//" +
    window.location.hostname +
    (window.location.port ? ":" + window.location.port : "");
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
      m.config.origin = window.location.origin;
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

export function waitForInitialization(config) {
  config = config || {};
  const targetOrigin = config.target_origin || "*";
  const done = () => {
    window.removeEventListener("message", this);
  };
  if (
    config.credential_required &&
    typeof config.verify_credential !== "function"
  ) {
    throw new Error(
      "Please also provide the `verify_credential` function with `credential_required`."
    );
  }
  if (config.credential_required && targetOrigin === "*") {
    throw new Error(
      "`target_origin` was set to `*` with `credential_required=true`, there is a security risk that you may leak the credential to website from other origin. Please specify the `target_origin` explicitly."
    );
  }
  this.handleEvent = e => {
    if (
      e.type === "message" &&
      (targetOrigin === "*" || e.origin === targetOrigin)
    ) {
      if (e.data.type === "initialize") {
        done();
        const cfg = e.data.config;
        // override the target_origin setting if it's configured by the rpc client
        // otherwise take the setting from the core
        if (targetOrigin !== "*") {
          cfg.target_origin = targetOrigin;
        }
        if (config.credential_required) {
          config.verify_credential(cfg.credential).then(result => {
            if (result && result.auth && !result.error) {
              // pass the authentication information with tokens
              cfg.auth = result.auth;
              setupRPC(cfg).then(() => {
                console.log("ImJoy RPC loaded successfully!");
              });
            } else {
              throw new Error(
                "Failed to verify the credentail:" + (result && result.error)
              );
            }
          });
        } else {
          setupRPC(cfg).then(() => {
            console.log("ImJoy RPC loaded successfully!");
          });
        }
      } else {
        throw new Error(`invalid command: ${e.data.cmd}`);
      }
    }
  };
  window.addEventListener("message", this);
  parent.postMessage({ type: "imjoyRPCReady", config: config }, "*");
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
  if (config.enable_service_worker) {
    setupServiceWorker(config.target_origin, config.cache_requirements);
  }
  if (config.cache_requirements) {
    delete config.cache_requirements;
  }
  // remove functions
  config = Object.keys(config).reduce((p, c) => {
    if (typeof config[c] !== "function") p[c] = config[c];
    return p;
  }, {});
  return new Promise((resolve, reject) => {
    if (_inIframe()) {
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
          const api = e.detail;
          if (config.expose_api_globally) {
            window.api = api;
          }
          // imjoy plugin api
          resolve(api);
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
