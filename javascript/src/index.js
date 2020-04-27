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

export { ImJoyRPC } from "./imjoyRPC.js";

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
    if (pArr[0] == paramName) return pArr[1]; //return value
  }
}

function cacheUrlInServiceWorker(url) {
  return new Promise(function(resolve, reject) {
    const message = {
      command: "add",
      url: url
    };
    if (!navigator.serviceWorker || !navigator.serviceWorker.register) {
      reject("Service worker is not supported.");
      return;
    }
    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = function(event) {
      if (event.data && event.data.error) {
        reject(event.data.error);
      } else {
        resolve(event.data && event.data.result);
      }
    };

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message, [
        messageChannel.port2
      ]);
    } else {
      reject("Service worker controller is not available");
    }
  });
}

async function cacheRequirements(requirements) {
  if (requirements && requirements.length > 0) {
    for (let req of requirements) {
      //remove prefix
      if (req.startsWith("js:")) req = req.slice(3);
      if (req.startsWith("css:")) req = req.slice(4);
      if (req.startsWith("cache:")) req = req.slice(6);
      if (!req.startsWith("http")) continue;

      await cacheUrlInServiceWorker(req).catch(e => {
        console.error(e);
      });
    }
  }
}

/**
 * Initializes the plugin inside a web worker. May throw an exception
 * in case this was not permitted by the browser.
 */
function setupWebWorker(config) {
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
    if (m.data.type == "initialized") {
      clearTimeout(fallbackTimeout);
    } else if (m.data.type == "disconnect") {
      worker.terminate();
    } else if (m.data.type == "message") {
      if (m.data.data.__transferables__) {
        transferables = m.data.data.__transferables__;
        delete m.data.data.__transferables__;
      }
    }
    parent.postMessage(m.data, "*", transferables);
  });

  window.addEventListener("message", function(m) {
    let transferables = undefined;
    if (m.data.type == "message") {
      if (m.data.data.__transferables__) {
        transferables = m.data.data.__transferables__;
        delete m.data.data.__transferables__;
      }
    }
    worker.postMessage(m.data, transferables);
  });
}

export function initializeRPC(config) {
  config = config || {};
  if (inIframe()) {
    if (config.messageHandler) {
      config.messageHandler.send = function(data, transferables) {
        parent.postMessage(data, "*", transferables);
      };
      // if a config.messageProcessor is specified, use it to process the message.
      window.addEventListener("message", function(e) {
        config.messageHandler.handleMessage(e.data);
      });

      if (!config.messageHandler.handleMessage) {
        throw new Error(
          "handleMessage method is required for the messageHanlder"
        );
      }
    } else {
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
        throw "Unsupported plugin type: " + plugin_type;
      }

      // register service worker for offline access
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", function() {
          navigator.serviceWorker.register("/plugin-service-worker.js").then(
            function(registration) {
              // Registration was successful
              console.log(
                "ServiceWorker registration successful with scope: ",
                registration.scope
              );
            },
            function(err) {
              // registration failed :(
              console.log("ServiceWorker registration failed: ", err);
            }
          );
        });
      }

      // event listener for the plugin message
      window.addEventListener("message", function(e) {
        const m = e.data && e.data.data;
        if (m && m.type === "execute") {
          const code = m.code;
          if (code.type == "requirements") {
            if (!Array.isArray(code.requirements)) {
              code.requirements = [code.requirements];
            }
            cacheRequirements(code.requirements);
          }
        }
      });
    }
  } else {
    throw new Error("imjoy-rpc should only run inside an iframe.");
  }
}
