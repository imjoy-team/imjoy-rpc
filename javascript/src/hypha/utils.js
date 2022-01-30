export function randId() {
  return (
    Math.random()
      .toString(36)
      .substr(2, 10) + new Date().getTime()
  );
}

export const dtypeToTypedArray = {
  int8: Int8Array,
  int16: Int16Array,
  int32: Int32Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  float32: Float32Array,
  float64: Float64Array,
  array: Array
};

export async function loadRequirementsInWindow(requirements) {
  function _importScript(url) {
    //url is URL of external file, implementationCode is the code
    //to be called from the file, location is the location to
    //insert the <script> element
    return new Promise((resolve, reject) => {
      var scriptTag = document.createElement("script");
      scriptTag.src = url;
      scriptTag.type = "text/javascript";
      scriptTag.onload = resolve;
      scriptTag.onreadystatechange = function() {
        if (this.readyState === "loaded" || this.readyState === "complete") {
          resolve();
        }
      };
      scriptTag.onerror = reject;
      document.head.appendChild(scriptTag);
    });
  }

  // support importScripts outside web worker
  async function importScripts() {
    var args = Array.prototype.slice.call(arguments),
      len = args.length,
      i = 0;
    for (; i < len; i++) {
      await _importScript(args[i]);
    }
  }

  if (
    requirements &&
    (Array.isArray(requirements) || typeof requirements === "string")
  ) {
    try {
      var link_node;
      requirements =
        typeof requirements === "string" ? [requirements] : requirements;
      if (Array.isArray(requirements)) {
        for (var i = 0; i < requirements.length; i++) {
          if (
            requirements[i].toLowerCase().endsWith(".css") ||
            requirements[i].startsWith("css:")
          ) {
            if (requirements[i].startsWith("css:")) {
              requirements[i] = requirements[i].slice(4);
            }
            link_node = document.createElement("link");
            link_node.rel = "stylesheet";
            link_node.href = requirements[i];
            document.head.appendChild(link_node);
          } else if (
            requirements[i].toLowerCase().endsWith(".mjs") ||
            requirements[i].startsWith("mjs:")
          ) {
            // import esmodule
            if (requirements[i].startsWith("mjs:")) {
              requirements[i] = requirements[i].slice(4);
            }
            await import(/* webpackIgnore: true */ requirements[i]);
          } else if (
            requirements[i].toLowerCase().endsWith(".js") ||
            requirements[i].startsWith("js:")
          ) {
            if (requirements[i].startsWith("js:")) {
              requirements[i] = requirements[i].slice(3);
            }
            await importScripts(requirements[i]);
          } else if (requirements[i].startsWith("http")) {
            await importScripts(requirements[i]);
          } else if (requirements[i].startsWith("cache:")) {
            //ignore cache
          } else {
            console.log("Unprocessed requirements url: " + requirements[i]);
          }
        }
      } else {
        throw "unsupported requirements definition";
      }
    } catch (e) {
      throw "failed to import required scripts: " + requirements.toString();
    }
  }
}

export async function loadRequirementsInWebworker(requirements) {
  if (
    requirements &&
    (Array.isArray(requirements) || typeof requirements === "string")
  ) {
    try {
      if (!Array.isArray(requirements)) {
        requirements = [requirements];
      }
      for (var i = 0; i < requirements.length; i++) {
        if (
          requirements[i].toLowerCase().endsWith(".css") ||
          requirements[i].startsWith("css:")
        ) {
          throw "unable to import css in a webworker";
        } else if (
          requirements[i].toLowerCase().endsWith(".js") ||
          requirements[i].startsWith("js:")
        ) {
          if (requirements[i].startsWith("js:")) {
            requirements[i] = requirements[i].slice(3);
          }
          importScripts(requirements[i]);
        } else if (requirements[i].startsWith("http")) {
          importScripts(requirements[i]);
        } else if (requirements[i].startsWith("cache:")) {
          //ignore cache
        } else {
          console.log("Unprocessed requirements url: " + requirements[i]);
        }
      }
    } catch (e) {
      throw "failed to import required scripts: " + requirements.toString();
    }
  }
}

export function loadRequirements(requirements) {
  if (
    typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope
  ) {
    return loadRequirementsInWebworker(requirements);
  } else {
    return loadRequirementsInWindow(requirements);
  }
}

export function normalizeConfig(config) {
  config.version = config.version || "0.1.0";
  config.description =
    config.description || `[TODO: add description for ${config.name} ]`;
  config.type = config.type || "rpc-window";
  config.id = config.id || randId();
  config.target_origin = config.target_origin || "*";
  config.allow_execution = config.allow_execution || false;
  // remove functions
  config = Object.keys(config).reduce((p, c) => {
    if (typeof config[c] !== "function") p[c] = config[c];
    return p;
  }, {});
  return config;
}
export const typedArrayToDtypeMapping = {
  Int8Array: "int8",
  Int16Array: "int16",
  Int32Array: "int32",
  Uint8Array: "uint8",
  Uint16Array: "uint16",
  Uint32Array: "uint32",
  Float32Array: "float32",
  Float64Array: "float64",
  Array: "array"
};

const typedArrayToDtypeKeys = [];
for (const arrType of Object.keys(typedArrayToDtypeMapping)) {
  typedArrayToDtypeKeys.push(eval(arrType));
}

export function typedArrayToDtype(obj) {
  let dtype = typedArrayToDtypeMapping[obj.constructor.name];
  if (!dtype) {
    const pt = Object.getPrototypeOf(obj);
    for (const arrType of typedArrayToDtypeKeys) {
      if (pt instanceof arrType) {
        dtype = typedArrayToDtypeMapping[arrType.name];
        break;
      }
    }
  }
  return dtype;
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

export async function cacheRequirements(requirements) {
  requirements = requirements || [];
  if (!Array.isArray(requirements)) {
    requirements = [requirements];
  }
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

export function setupServiceWorker(baseUrl, targetOrigin, cacheCallback) {
  // register service worker for offline access
  if ("serviceWorker" in navigator) {
    baseUrl = baseUrl || "/";
    navigator.serviceWorker.register(baseUrl + "plugin-service-worker.js").then(
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
    targetOrigin = targetOrigin || "*";
    cacheCallback = cacheCallback || cacheRequirements;
    if (cacheCallback && typeof cacheCallback !== "function") {
      throw new Error("config.cache_requirements must be a function");
    }
    window.addEventListener("message", function(e) {
      if (targetOrigin === "*" || e.origin === targetOrigin) {
        const m = e.data;
        if (m.type === "cacheRequirements") {
          cacheCallback(m.requirements);
        }
      }
    });
  }
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

//#Source https://bit.ly/2neWfJ2
export function urlJoin(...args) {
  return args
    .join("/")
    .replace(/[\/]+/g, "/")
    .replace(/^(.+):\//, "$1://")
    .replace(/^file:/, "file:/")
    .replace(/\/(\?|&|#[^!])/g, "$1")
    .replace(/\?/g, "&")
    .replace("&", "?");
}

export function waitFor(prom, time, error) {
  let timer;
  return Promise.race([
    prom,
    new Promise(
      (_r, rej) =>
        (timer = setTimeout(() => {
          rej(error || "Timeout Error");
        }, time * 1000))
    )
  ]).finally(() => clearTimeout(timer));
}

export class MessageEmitter {
  constructor(debug) {
    this._event_handlers = {};
    this._once_handlers = {};
    this._debug = debug;
  }
  emit() {
    throw new Error("emit is not implemented");
  }
  on(event, handler) {
    if (!this._event_handlers[event]) {
      this._event_handlers[event] = [];
    }
    this._event_handlers[event].push(handler);
  }
  once(event, handler) {
    handler.___event_run_once = true;
    this.on(event, handler);
  }
  off(event, handler) {
    if (!event && !handler) {
      // remove all events handlers
      this._event_handlers = {};
    } else if (event && !handler) {
      // remove all hanlders for the event
      if (this._event_handlers[event]) this._event_handlers[event] = [];
    } else {
      // remove a specific handler
      if (this._event_handlers[event]) {
        const idx = this._event_handlers[event].indexOf(handler);
        if (idx >= 0) {
          this._event_handlers[event].splice(idx, 1);
        }
      }
    }
  }
  _fire(event, data) {
    if (this._event_handlers[event]) {
      var i = this._event_handlers[event].length;
      while (i--) {
        const handler = this._event_handlers[event][i];
        try {
          handler(data);
        } catch (e) {
          console.error(e);
        } finally {
          if (handler.___event_run_once) {
            this._event_handlers[event].splice(i, 1);
          }
        }
      }
    } else {
      if (this._debug) {
        console.warn("unhandled event", event, data);
      }
    }
  }
}
