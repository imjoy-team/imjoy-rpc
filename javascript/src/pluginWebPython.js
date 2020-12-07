/**
 * Contains the routines loaded by the plugin iframe under web-browser
 * in case when worker failed to initialize
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { connectRPC } from "./pluginCore.js";
import { API_VERSION } from "./rpc.js";
import { Connection as IframeConnection, executeCode } from "./pluginIframe";
// Create a new, plain <span> element
function _htmlToElement(html) {
  var template = document.createElement("template");
  html = html.trim(); // Never return a text node of whitespace as the result
  template.innerHTML = html;
  return template.content.firstChild;
}

const _importScript = function(url) {
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

window.TimeoutPromise = function(time) {
  var promise = new Promise(function(resolve, reject) {
    window.setTimeout(function() {
      resolve(time);
    }, time);
  });
  return promise;
};

window.RequestAnimationFramePromise = function() {
  var promise = new Promise(function(resolve, reject) {
    window.requestAnimationFrame(function(timestamp) {
      resolve(timestamp);
    });
  });
  return promise;
};

const startup_script = `
from js import RequestAnimationFramePromise
from functools import partial 
from inspect import isawaitable

class PromiseException(RuntimeError):
    pass

class WebLoop:
    def __init__(self):
        self.coros = []
    def call_soon(self, coro, resolve=None, reject=None):
        self.step(coro, resolve, reject)
    def step(self, coro, resolve, reject, arg=None):
        try:
            x = coro.send(arg) 
            x = x.then(partial(self.step, coro, resolve, reject))
            x.catch(partial(self.fail,coro, resolve, reject))
        except StopIteration as result:
            if callable(resolve):
                resolve(result.value)
        except Exception as e:
            if callable(reject):
                reject(e)

    def fail(self, coro,arg=None):
        try:
            coro.throw(PromiseException(arg))
        except StopIteration:
            pass
    
    def request_animation_frame(self):
        if not hasattr(self, "raf_event"):
            self.raf_event = RAFEvent()
        return self.raf_event


class RAFEvent:
    def __init__(self):
        self.awaiters = []
        self.promise = None
    def __await__(self):
        if self.promise is None:
            self.promise = RequestAnimationFramePromise()
        x = yield self.promise
        self.promise = None
        return x
`;

const init_imjoy_script = `
from js import api, Object
import sys
from functools import partial 
from types import ModuleType
import copy

class dotdict(dict):  # pylint: disable=invalid-name
    """Access dictionary attributes with dot.notation."""

    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __hash__(self):
        # TODO: is there any performance impact?
        return hash(tuple(sorted(self.items())))

    def __deepcopy__(self, memo=None):
        """Make a deep copy."""
        return dotdict(copy.deepcopy(dict(self), memo=memo))


class WrappedPromise:
    def __init__(self, promise):
        self.promise = promise
        try:
            self.then = promise.then
            self.catch = promise.catch
            self.finally_ = promise.finally_
        except:
            self.then = lambda f: f(None)
            self.catch = lambda f: f(None)
            self.finally_ = lambda f: f(None)

    def __await__(self):
        x = yield self.promise
        return x

wrapped_api = dotdict()
for k in Object.keys(api):
    if callable(api[k]) and k not in ['export', 'registerCodec']:
        def remote_method(func, *arguments, **kwargs):
            arguments = list(arguments)
            # wrap keywords to a dictionary and pass to the last argument
            if kwargs:
                arguments = arguments + [kwargs]
            return WrappedPromise(func(*arguments))
        # this has to be partial, otherwise it crashes
        wrapped_api[k] = partial(remote_method, api[k])
    else:
        wrapped_api[k] = api[k]

m = ModuleType("imjoy")
sys.modules[m.__name__] = m
m.__file__ = m.__name__ + ".py"
m.api = wrapped_api
`;

let _export_plugin_api = null;
const execute_python_code = function(code) {
  try {
    if (!_export_plugin_api) {
      _export_plugin_api = window.api.export;
      window.api.export = function(p) {
        window.pyodide.runPython(startup_script);
        const WebLoop = window.pyodide.pyimport("WebLoop");
        const isawaitable = window.pyodide.pyimport("isawaitable");
        const loop = WebLoop();
        if (typeof p === "object") {
          const _api = {};
          for (let k in p) {
            if (!k.startsWith("_")) {
              const func = p[k];
              _api[k] = function() {
                return new Promise((resolve, reject) => {
                  try {
                    const ret = func(...Array.prototype.slice.call(arguments));
                    if (isawaitable(ret)) {
                      loop.call_soon(ret, resolve, reject);
                    } else {
                      resolve(ret);
                    }
                  } catch (e) {
                    reject(e);
                  }
                });
              };
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
                return new Promise((resolve, reject) => {
                  try {
                    const ret = func(...Array.prototype.slice.call(arguments));
                    if (isawaitable(ret)) {
                      loop.call_soon(ret, resolve, reject);
                    } else {
                      resolve(ret);
                    }
                  } catch (e) {
                    reject(e);
                  }
                });
              };
            }
          }
          _export_plugin_api(_api);
        } else {
          throw "unsupported api export";
        }
      };
    }
    window.pyodide.runPython(init_imjoy_script);
    window.pyodide.runPython(code.content);
  } catch (e) {
    throw e;
  }
};

function setupPyodide() {
  return new Promise((resolve, reject) => {
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

      window.languagePluginLoader
        .then(() => {
          // pyodide is now ready to use...
          console.log(window.pyodide.runPython("import sys\nsys.version"));
          resolve();
        })
        .catch(reject);
    });
  });
}
// connection object for the RPC constructor
class Connection extends IframeConnection {
  constructor(config) {
    super(config);
  }
  async execute(code) {
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
          const node = document.createElement("script");
          node.setAttribute("type", code.attrs.type);
          node.appendChild(document.createTextNode(code.content));
          document.body.appendChild(node);
        }
      }
    } else if (code.type === "style") {
      const style_node = document.createElement("style");
      if (code.src) {
        style_node.src = code.src;
      }
      style_node.innerHTML = code.content;
      document.head.appendChild(style_node);
    } else if (code.type === "link") {
      const link_node = document.createElement("link");
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
  }
}

export default function setupWebPython(config) {
  config = config || {};
  config.debug = true;
  config.dedicated_thread = false;
  config.lang = "python";
  config.api_version = API_VERSION;
  const conn = new Connection(config);
  setupPyodide().then(() => {
    connectRPC(conn, config);
    conn.connect();
  });
}
