/**
 * Contains the routines loaded by the plugin Worker under web-browser.
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { setupCore } from "./pluginCore.js";

(function() {
  // make sure this runs inside a webworker
  if (
    typeof WorkerGlobalScope === "undefined" ||
    !self ||
    !(self instanceof WorkerGlobalScope)
  ) {
    throw new Error("This script can only loaded in a webworker");
  }
  /**
   * Executes the given code in a jailed environment. For web
   * implementation, we're already jailed in the iframe and the
   * worker, so simply eval()
   *
   * @param {String} code code to execute
   */
  var execute = function(code) {
    try {
      if (code.type === "requirements") {
        try {
          if (
            code.requirements &&
            (Array.isArray(code.requirements) ||
              typeof code.requirements === "string")
          ) {
            try {
              if (!Array.isArray(code.requirements)) {
                code.requirements = [code.requirements];
              }
              for (var i = 0; i < code.requirements.length; i++) {
                if (
                  code.requirements[i].toLowerCase().endsWith(".css") ||
                  code.requirements[i].startsWith("css:")
                ) {
                  throw "unable to import css in a webworker";
                } else if (
                  code.requirements[i].toLowerCase().endsWith(".js") ||
                  code.requirements[i].startsWith("js:")
                ) {
                  if (code.requirements[i].startsWith("js:")) {
                    code.requirements[i] = code.requirements[i].slice(3);
                  }
                  importScripts(code.requirements[i]);
                } else if (code.requirements[i].startsWith("http")) {
                  importScripts(code.requirements[i]);
                } else if (code.requirements[i].startsWith("cache:")) {
                  //ignore cache
                } else {
                  console.log(
                    "Unprocessed requirements url: " + code.requirements[i]
                  );
                }
              }
            } catch (e) {
              throw "failed to import required scripts: " +
                code.requirements.toString();
            }
          }
        } catch (e) {
          throw e;
        }
      } else if (code.type === "script") {
        try {
          if (
            code.requirements &&
            (Array.isArray(code.requirements) ||
              typeof code.requirements === "string")
          ) {
            try {
              if (Array.isArray(code.requirements)) {
                for (let i = 0; i < code.requirements.length; i++) {
                  importScripts(code.requirements[i]);
                }
              } else {
                importScripts(code.requirements);
              }
            } catch (e) {
              throw "failed to import required scripts: " +
                code.requirements.toString();
            }
          }
          eval(code.content);
        } catch (e) {
          console.error(e.message, e.stack);
          throw e;
        }
      } else {
        throw "unsupported code type.";
      }
      self.postMessage({ type: "executeSuccess" });
    } catch (e) {
      console.error("failed to execute scripts: ", code, e);
      self.postMessage({ type: "executeFailure", error: e.stack || String(e) });
    }
  };

  /**
   * Connection object provided to the RPC constructor,
   * plugin site implementation for the web-based environment.
   * Global will be then cleared to prevent exposure into the
   * Worker, so we put this local connection object into a closure
   */
  const conn = {
    disconnect: function() {
      self.close();
    },
    send: function(data, transferables) {
      data.__transferables__ = transferables;
      self.postMessage(data, transferables);
    },
    onMessage: function(h) {
      conn._messageHandler = h;
    },
    _messageHandler: function() {},
    onDisconnect: function() {}
  };

  const spec = {
    dedicatedThread: true,
    allowExecution: true,
    language: "javascript"
  };

  /**
   * Event lisener for the plugin message
   */
  self.addEventListener("message", function(e) {
    const m = e.data;
    switch (m && m.type) {
      case "getSpec":
        self.postMessage({
          type: "spec",
          spec: spec
        });
        break;
      case "execute":
        execute(m.code);
        if (m.code.type === "requirements") {
          if (!Array.isArray(m.code.requirements)) {
            m.code.requirements = [m.code.requirements];
          }
          self.postMessage({
            type: "cacheRequirements",
            requirements: m.code.requirements
          });
        }
        break;
      // for webworker only
      case "setupCore":
        setupCore(conn, m.config);
        break;
      default:
        conn._messageHandler(m);
    }
  });
  self.postMessage({
    type: "initialized",
    spec: spec
  });
})();
