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

    def fail(self, coro, resolve, reject, arg=None):
        try:
            if callable(reject):
                reject(PromiseException(arg))
                return
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

try:
    import numpy as np
    NUMPY = np
except:
    NUMPY = False
import io
from collections import OrderedDict

_codecs = {}
_object_store = {}
def _encode(a_object, as_interface=False, object_id=None):
    """Encode object."""
    if isinstance(a_object, (int, float, bool, str, bytes)) or a_object is None:
        return a_object

    if callable(a_object):
        return a_object

    if isinstance(a_object, tuple):
        a_object = list(a_object)

    if isinstance(a_object, dotdict):
        a_object = dict(a_object)

    # skip if already encoded
    if isinstance(a_object, dict) and "_rtype" in a_object:
        # make sure the interface functions are encoded
        if "_rintf" in a_object:
            temp = a_object["_rtype"]
            del a_object["_rtype"]
            b_object = _encode(a_object, as_interface, object_id)
            b_object._rtype = temp
        else:
            b_object = a_object
        return b_object

    isarray = isinstance(a_object, list)
    b_object = None

    encoded_obj = None
    for tp in _codecs:
        codec = _codecs[tp]
        if codec.encoder and isinstance(a_object, codec.type):
            # TODO: what if multiple encoders found
            encoded_obj = codec.encoder(a_object)
            if isinstance(encoded_obj, dict) and "_rtype" not in encoded_obj:
                encoded_obj["_rtype"] = codec.name
            # encode the functions in the interface object
            if isinstance(encoded_obj, dict) and "_rintf" in encoded_obj:
                temp = encoded_obj["_rtype"]
                del encoded_obj["_rtype"]
                encoded_obj = _encode(encoded_obj, True)
                encoded_obj["_rtype"] = temp
            b_object = encoded_obj
            return b_object

    if NUMPY and isinstance(a_object, (NUMPY.ndarray, NUMPY.generic)):
        v_bytes = a_object.tobytes()
        b_object = {
            "_rtype": "ndarray",
            "_rvalue": v_bytes,
            "_rshape": a_object.shape,
            "_rdtype": str(a_object.dtype),
        }

    elif isinstance(a_object, Exception):
        b_object = {"_rtype": "error", "_rvalue": str(a_object)}
    elif isinstance(a_object, memoryview):
        b_object = {"_rtype": "memoryview", "_rvalue": a_object.tobytes()}
    elif isinstance(
        a_object, (io.IOBase, io.TextIOBase, io.BufferedIOBase, io.RawIOBase)
    ):
        b_object = {
            "_rtype": "blob",
            "_rvalue": a_object.read(),
            "_rmime": "application/octet-stream",
        }
    # NOTE: "typedarray" is not used
    elif isinstance(a_object, OrderedDict):
        b_object = {
            "_rtype": "orderedmap",
            "_rvalue": _encode(list(a_object), as_interface),
        }
    elif isinstance(a_object, set):
        b_object = {
            "_rtype": "set",
            "_rvalue": _encode(list(a_object), as_interface),
        }
    elif hasattr(a_object, "_rintf") and a_object._rintf == True:
        b_object = _encode(a_object, True)
    elif isinstance(a_object, (list, dict)) or inspect.isclass(type(a_object)):
        b_object = [] if isarray else {}
        if not isinstance(a_object, (list, dict)) and inspect.isclass(
            type(a_object)
        ):
            a_object_norm = {
                a: getattr(a_object, a)
                for a in dir(a_object)
                if not a.startswith("_")
            }
            # always encode class instance as interface
            as_interface = True
        else:
            a_object_norm = a_object

        keys = range(len(a_object_norm)) if isarray else a_object_norm.keys()
        # encode interfaces
        if (not isarray and a_object_norm.get("_rintf")) or as_interface:
            if object_id is None:
                object_id = str(uuid.uuid4())
                _object_store[object_id] = a_object

            has_function = False
            for key in keys:
                if isinstance(key, str) and key.startswith("_"):
                    continue
                encoded = _encode(
                    a_object_norm[key],
                    as_interface + "." + str(key)
                    if isinstance(as_interface, str)
                    else key,
                    object_id,
                )
                if callable(a_object_norm[key]):
                    has_function = True
                if isarray:
                    b_object.append(encoded)
                else:
                    b_object[key] = encoded
            # TODO: how to despose list object? create a wrapper for list?
            if not isarray and has_function:
                b_object["_rintf"] = object_id
            # remove interface when closed
            if "on" in a_object_norm and callable(a_object_norm["on"]):

                def remove_interface():
                    del _object_store[object_id]

                a_object_norm["on"]("close", remove_interface)
        else:
            for key in keys:
                if isarray:
                    b_object.append(_encode(a_object_norm[key]))
                else:
                    b_object[key] = _encode(a_object_norm[key])
    else:
        raise Exception("imjoy-rpc: Unsupported data type:" + str(aObject))
    return b_object

def _decode(a_object, with_promise=False):
    """Decode object."""
    if a_object is None:
        return a_object
    if isinstance(a_object, dict) and "_rtype" in a_object:
        b_object = None
        if (
            _codecs.get(a_object["_rtype"])
            and _codecs[a_object["_rtype"]].decoder
        ):
            if "_rintf" in a_object:
                temp = a_object["_rtype"]
                del a_object["_rtype"]
                a_object = _decode(a_object, with_promise)
                a_object["_rtype"] = temp
            b_object = _codecs[a_object["_rtype"]].decoder(a_object)
        elif a_object["_rtype"] == "callback":
            raise Exception("Unsupported object decoding: callback")
        elif a_object["_rtype"] == "interface":
            raise Exception("Unsupported object decoding: interface")
        elif a_object["_rtype"] == "ndarray":
            # create build array/tensor if used in the plugin
            try:
                if isinstance(a_object["_rvalue"], (list, tuple)):
                    a_object["_rvalue"] = reduce(
                        (lambda x, y: x + y), a_object["_rvalue"]
                    )
                elif not isinstance(a_object["_rvalue"], bytes):
                    raise Exception(
                        "Unsupported data type: " + str(type(a_object["_rvalue"]))
                    )
                if NUMPY:
                    b_object = NUMPY.frombuffer(
                        a_object["_rvalue"], dtype=a_object["_rdtype"]
                    ).reshape(tuple(a_object["_rshape"]))

                else:
                    b_object = a_object
                    logger.warn("numpy is not available, failed to decode ndarray")

            except Exception as exc:
                logger.debug("Error in converting: %s", exc)
                b_object = a_object
                raise exc
        elif a_object["_rtype"] == "memoryview":
            b_object = memoryview(a_object["_rvalue"])
        elif a_object["_rtype"] == "blob":
            if isinstance(a_object["_rvalue"], str):
                b_object = io.StringIO(a_object["_rvalue"])
            elif isinstance(a_object["_rvalue"], bytes):
                b_object = io.BytesIO(a_object["_rvalue"])
            else:
                raise Exception(
                    "Unsupported blob value type: " + str(type(a_object["_rvalue"]))
                )
        elif a_object["_rtype"] == "typedarray":
            if NUMPY:
                b_object = NUMPY.frombuffer(
                    a_object["_rvalue"], dtype=a_object["_rdtype"]
                )
            else:
                b_object = a_object["_rvalue"]
        elif a_object["_rtype"] == "orderedmap":
            b_object = OrderedDict(_decode(a_object["_rvalue"], with_promise))
        elif a_object["_rtype"] == "set":
            b_object = set(_decode(a_object["_rvalue"], with_promise))
        elif a_object["_rtype"] == "error":
            b_object = Exception(a_object["_rvalue"])
        else:
            # make sure all the interface functions are decoded
            if "_rintf" in a_object:
                temp = a_object["_rtype"]
                del a_object["_rtype"]
                a_object = _decode(a_object, with_promise)
                a_object["_rtype"] = temp
            b_object = a_object
    elif isinstance(a_object, (dict, list, tuple)):
        if isinstance(a_object, tuple):
            a_object = list(a_object)
        isarray = isinstance(a_object, list)
        b_object = [] if isarray else dotdict()
        keys = range(len(a_object)) if isarray else a_object.keys()
        for key in keys:
            val = a_object[key]
            if isarray:
                b_object.append(_decode(val, with_promise))
            else:
                b_object[key] = _decode(val, with_promise)
    else:
        b_object = a_object

    # object id, used for dispose the object
    if isinstance(a_object, dict) and a_object.get("_rintf"):
        # make the dict hashable
        if isinstance(b_object, dict) and not isinstance(b_object, dotdict):
            b_object = dotdict(b_object)
        # _object_weakmap[b_object] = a_object.get("_rintf")
    return b_object


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
    func = getattr(api, k)
    if callable(func) and k not in ['export', 'registerCodec']:
        def remote_method(func, *args, **kwargs):
            args = list(args)
            # wrap keywords to a dictionary and pass to the last argument
            if kwargs:
                args = args + [kwargs]
            args = _encode(args)
            return WrappedPromise(func(*args))
        # this has to be partial, otherwise it crashes
        wrapped_api[k] = partial(remote_method, func)
    else:
        wrapped_api[k] = func

def unwrap_func_args(func):
    def wrapped_function(*args):
        return func(*_decode(args))
    return wrapped_function
    
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
        const unwrap_func_args = window.pyodide.pyimport("unwrap_func_args");
        const callable = window.pyodide.pyimport("callable");
        const loop = WebLoop();
        if (typeof p === "object") {
          const _api = {};
          for (let k in p) {
            if (!k.startsWith("_") && callable(p[k])) {
              const func = unwrap_func_args(p[k]);
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
            if (
              !k.startsWith("_") &&
              hasattr(p, k) &&
              callable(getattr(p, k))
            ) {
              const func = unwrap_func_args(getattr(p, k));
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
