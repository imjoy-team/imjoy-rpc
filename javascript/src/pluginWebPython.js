/**
 * Contains the routines loaded by the plugin iframe under web-browser
 * in case when worker failed to initialize
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */

import { connectRPC } from "./pluginCore.js";
import { API_VERSION } from "./rpc.js";

export default function setupWebPython(config) {
  config = config || {};
  // Create a new, plain <span> element
  function _htmlToElement(html) {
    var template = document.createElement("template");
    html = html.trim(); // Never return a text node of whitespace as the result
    template.innerHTML = html;
    return template.content.firstChild;
  }

  var _importScript = function(url) {
    //url is URL of external file, implementationCode is the code
    //to be called from the file, location is the location to
    //insert the <script> element
    return new Promise((resolve, reject) => {
      var scriptTag = document.createElement("script");
      scriptTag.src = url;
      scriptTag.onload = resolve;
      scriptTag.onreadystatechange = function() {
        if (this.readyState === "loaded" || this.readyState === "complete") {
          resolve();
        }
      };
      scriptTag.onerror = reject;
      document.head.appendChild(scriptTag);
    });
  };

  // support importScripts outside web worker

  async function importScripts() {
    var args = Array.prototype.slice.call(arguments),
      len = args.length,
      i = 0;
    for (; i < len; i++) {
      await _importScript(args[i]);
    }
  }

  var startup_script = `
  from js import api
  import sys
  from types import ModuleType
  m = ModuleType("imjoy")
  sys.modules[m.__name__] = m
  m.__file__ = m.__name__ + ".py"
  m.api = api
  `;
  var _export_plugin_api = null;
  var execute_python_code = function(code) {
    try {
      if (!_export_plugin_api) {
        _export_plugin_api = window.api.export;
        window.api.export = function(p) {
          if (typeof p === "object") {
            const _api = {};
            for (let k in p) {
              if (!k.startsWith("_")) {
                _api[k] = p[k];
              }
            }
            _export_plugin_api(_api);
          } else if (typeof p === "function") {
            const _api = {};
            const getattr = window.pyodide.pyimport("getattr");
            const hasattr = window.pyodide.pyimport("hasattr");
            for (let k of Object.getOwnPropertyNames(p)) {
              if (!k.startsWith("_") && hasattr(p, k)) {
                const func = getattr(p, k);
                _api[k] = function() {
                  return func(...Array.prototype.slice.call(arguments));
                };
              }
            }
            _export_plugin_api(_api);
          } else {
            throw "unsupported api export";
          }
        };
      }
      window.pyodide.runPython(startup_script);
      window.pyodide.runPython(code.content);
    } catch (e) {
      throw e;
    }
  };

  // evaluates the provided string
  var execute = async function(code) {
    try {
      if (code.type === "requirements") {
        if (code.requirements) {
          code.requirements =
            typeof code.requirements === "string"
              ? [code.requirements]
              : code.requirements;
          if (Array.isArray(code.requirements)) {
            const python_packages = [];
            for (var i = 0; i < code.requirements.length; i++) {
              if (
                code.requirements[i].toLowerCase().endsWith(".css") ||
                code.requirements[i].startsWith("css:")
              ) {
                if (code.requirements[i].startsWith("css:")) {
                  code.requirements[i] = code.requirements[i].slice(4);
                }
                link_node = document.createElement("link");
                link_node.rel = "stylesheet";
                link_node.href = code.requirements[i];
                document.head.appendChild(link_node);
              } else if (
                // code.requirements[i].toLowerCase().endsWith(".js") ||
                code.requirements[i].startsWith("js:")
              ) {
                if (code.requirements[i].startsWith("js:")) {
                  code.requirements[i] = code.requirements[i].slice(3);
                }
                await importScripts(code.requirements[i]);
              } else if (code.requirements[i].startsWith("cache:")) {
                //ignore cache
              } else if (
                code.requirements[i].toLowerCase().endsWith(".js") ||
                code.requirements[i].startsWith("package:")
              ) {
                if (code.requirements[i].startsWith("package:")) {
                  code.requirements[i] = code.requirements[i].slice(8);
                }
                python_packages.push(code.requirements[i]);
              } else if (
                code.requirements[i].startsWith("http:") ||
                code.requirements[i].startsWith("https:")
              ) {
                console.log(
                  "Unprocessed requirements url: " + code.requirements[i]
                );
              } else {
                python_packages.push(code.requirements[i]);
              }
            }
            await window.pyodide.loadPackage(python_packages);
          } else {
            throw "unsupported requirements definition";
          }
        }
      } else if (code.type === "script") {
        if (code.src) {
          var script_node = document.createElement("script");
          script_node.setAttribute("type", code.attrs.type);
          script_node.setAttribute("src", code.src);
          document.head.appendChild(script_node);
        } else {
          if (code.content && code.lang === "python") {
            execute_python_code(code);
          } else if (code.content && code.lang === "javascript") {
            try {
              eval(code.content);
            } catch (e) {
              console.error(e.message, e.stack);
              throw e;
            }
          } else {
            var node = document.createElement("script");
            node.setAttribute("type", code.attrs.type);
            node.appendChild(document.createTextNode(code.content));
            document.body.appendChild(node);
          }
        }
      } else if (code.type === "style") {
        var style_node = document.createElement("style");
        if (code.src) {
          style_node.src = code.src;
        }
        style_node.innerHTML = code.content;
        document.head.appendChild(style_node);
      } else if (code.type === "link") {
        var link_node = document.createElement("link");
        if (code.rel) {
          link_node.rel = code.rel;
        }
        if (code.href) {
          link_node.href = code.href;
        }
        if (code.attrs && code.attrs.type) {
          link_node.type = code.attrs.type;
        }
        document.head.appendChild(link_node);
      } else if (code.type === "html") {
        document.body.appendChild(_htmlToElement(code.content));
      } else {
        throw "unsupported code type.";
      }
      parent.postMessage({ type: "executeSuccess" }, "*");
    } catch (e) {
      console.error("failed to execute scripts: ", code, e);
      parent.postMessage(
        { type: "executeFailure", error: e.stack || String(e) },
        "*"
      );
    }
  };
  const targetOrigin = config.target_origin || "*";
  // connection object for the RPC constructor
  const conn = {
    disconnect: function() {},
    send: function(data, transferables) {
      parent.postMessage(data, targetOrigin, transferables);
    },
    onMessage: function(h) {
      conn._messageHandler = h;
    },
    _messageHandler: function() {},
    onDisconnect: function() {}
  };

  config.dedicated_thread = false;
  config.lang = "python";
  config.api_version = API_VERSION;

  // event listener for the plugin message
  window.addEventListener("message", function(e) {
    if (targetOrigin === "*" || e.origin === targetOrigin) {
      const m = e.data;
      switch (m && m.type) {
        case "getConfig":
          parent.postMessage(
            {
              type: "config",
              config: config
            },
            targetOrigin
          );
          break;
        case "execute":
          if (config.allow_execution) {
            execute(m.code);
            if (m.code.type === "requirements") {
              if (!Array.isArray(m.code.requirements)) {
                m.code.requirements = [m.code.requirements];
              }
            }
          } else {
            console.warn(
              "execute script is not allowed (allow_execution=false)"
            );
          }
          break;
        default:
          conn._messageHandler(m);
      }
    }
  });

  window.languagePluginUrl = "https://static.imjoy.io/pyodide/";

  importScripts("https://static.imjoy.io/pyodide/pyodide.js").then(() => {
    // hack for matplotlib etc.
    window.iodide = {
      output: {
        element: function element(type) {
          const div = document.createElement(type);
          const output = document.getElementById("output") || document.body;
          output.appendChild(div);
          return div;
        }
      }
    };

    window.languagePluginLoader.then(() => {
      // pyodide is now ready to use...
      console.log(window.pyodide.runPython("import sys\nsys.version"));

      connectRPC(conn, {
        forwarding_functions: config.forwarding_functions
      });
      parent.postMessage(
        {
          type: "initialized",
          config: config
        },
        targetOrigin
      );
    });
  });
}
