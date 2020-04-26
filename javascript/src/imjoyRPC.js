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
import setupIframe from "./pluginWebIframe.js";
import setupWebPython from "./pluginWebPython.js";

export { JailedSite } from "./jailedSite.js";

(function() {
  function inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  var getParamValue = function(paramName) {
    var url = window.location.search.substring(1); //get rid of "?" in querystring
    var qArray = url.split("&"); //get key-value pairs
    for (var i = 0; i < qArray.length; i++) {
      var pArr = qArray[i].split("="); //split key and value
      if (pArr[0] == paramName) return pArr[1]; //return value
    }
  };

  var plugin_mode = getParamValue("_plugin_type");

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
  var initWebworkerPlugin = function() {
    var worker = new PluginWorker();

    // mixed content warning in Chrome silently skips worker
    // initialization without exception, handling this with timeout
    var fallbackTimeout = setTimeout(function() {
      worker.terminate();
      console.warn(
        `Plugin failed to start as a web-worker, running in an iframe instead.`
      );
      setupIframe();
    }, 2000);

    // forwarding messages between the worker and parent window
    worker.addEventListener("message", function(m) {
      var transferables = undefined;
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
      var transferables = undefined;
      if (m.data.type == "message") {
        if (m.data.data.__transferables__) {
          transferables = m.data.data.__transferables__;
          delete m.data.data.__transferables__;
        }
      }
      worker.postMessage(m.data, transferables);
    });
  };

  if (inIframe()) {
    plugin_mode = plugin_mode || "window";
    if (plugin_mode === "web-worker") {
      try {
        initWebworkerPlugin();
      } catch (e) {
        // fallback to iframe
        setupIframe();
      }
    } else if (
      plugin_mode === "web-python" ||
      plugin_mode === "web-python-window"
    ) {
      setupWebPython();
    } else if (plugin_mode === "iframe" || plugin_mode === "window") {
      setupIframe();
    } else {
      console.error("Unsupported plugin type: " + plugin_mode);
      throw "Unsupported plugin type: " + plugin_mode;
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
      var m = e.data && e.data.data;
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
  } else {
    console.warn("_frame.js should only run inside an iframe.");
  }
})();
