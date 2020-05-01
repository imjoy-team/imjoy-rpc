import Ajv from "ajv";
const ajv = new Ajv();

export function randId() {
  return Math.random()
    .toString(36)
    .substr(2, 10);
}

export const dtypeToTypedArray = {
  int8: "Int8Array",
  int16: "Int16Array",
  int32: "Int32Array",
  uint8: "Uint8Array",
  uint16: "Uint16Array",
  uint32: "Uint32Array",
  float32: "Float32Array",
  float64: "Float64Array",
  array: "Array"
};
export const typedArrayToDtype = {
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

export const CONFIG_SCHEMA = ajv.compile({
  properties: {
    allow_execution: { type: "boolean" },
    api_version: { type: "string" },
    cover: { type: ["string", "array"] },
    dedicated_thread: { type: "boolean" },
    description: { type: "string", maxLength: 256 },
    flags: { type: "array" },
    icon: { type: "string" },
    id: { type: "string" },
    inputs: { type: ["object", "array"] },
    labels: { type: "array" },
    lang: { type: "string" },
    name: { type: "string" },
    outputs: { type: ["object", "array"] },
    tags: { type: "array" },
    token: { type: "string" },
    ui: { type: "string" },
    version: { type: "string" }
  },
  required: ["api_version", "allow_execution", "token", "id"]
});

export function compareVersions(v1, comparator, v2) {
  comparator = comparator == "=" ? "==" : comparator;
  if (
    ["==", "===", "<", "<=", ">", ">=", "!=", "!=="].indexOf(comparator) == -1
  ) {
    throw new Error("Invalid comparator. " + comparator);
  }
  var v1parts = v1.split("."),
    v2parts = v2.split(".");
  var maxLen = Math.max(v1parts.length, v2parts.length);
  var part1, part2;
  var cmp = 0;
  for (var i = 0; i < maxLen && !cmp; i++) {
    part1 = parseInt(v1parts[i], 10) || 0;
    part2 = parseInt(v2parts[i], 10) || 0;
    if (part1 < part2) cmp = 1;
    if (part1 > part2) cmp = -1;
  }
  return eval("0" + comparator + cmp);
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

export function setupServiceWorker(cacheCallback) {
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
    });
  }
}

/**
 * A special kind of event:
 *  - which can only be emitted once;
 *  - executes a set of subscribed handlers upon emission;
 *  - if a handler is subscribed after the event was emitted, it
 *    will be invoked immideately.
 *
 * Used for the events which only happen once (or do not happen at
 * all) during a single plugin lifecycle - connect, disconnect and
 * connection failure
 */
export const Whenable = function(multi_emit) {
  this._multi_emit = multi_emit;
  this._emitted = false;
  this._handlers = [];
};

/**
 * Emits the Whenable event, calls all the handlers already
 * subscribed, switches the object to the 'emitted' state (when
 * all future subscibed listeners will be immideately issued
 * instead of being stored)
 */
Whenable.prototype.emit = function(e) {
  if (this._multi_emit) {
    this._emitted = true;
    this._e = e;
    for (let handler of this._handlers) {
      setTimeout(handler.bind(null, e), 0);
    }
  } else if (!this._emitted) {
    this._emitted = true;
    this._e = e;
    var handler;
    while ((handler = this._handlers.pop())) {
      setTimeout(handler.bind(null, e), 0);
    }
  }
};

/**
 * Saves the provided function as a handler for the Whenable
 * event. This handler will then be called upon the event emission
 * (if it has not been emitted yet), or will be scheduled for
 * immediate issue (if the event has already been emmitted before)
 *
 * @param {Function} handler to subscribe for the event
 */
Whenable.prototype.whenEmitted = function(handler) {
  handler = this._checkHandler(handler);
  if (this._emitted) {
    setTimeout(handler.bind(null, this._e), 0);
  } else {
    this._handlers.push(handler);
  }
};

/**
 * Checks if the provided object is suitable for being subscribed
 * to the event (= is a function), throws an exception if not
 *
 * @param {Object} obj to check for being subscribable
 *
 * @throws {Exception} if object is not suitable for subscription
 *
 * @returns {Object} the provided object if yes
 */
Whenable.prototype._checkHandler = function(handler) {
  var type = typeof handler;
  if (type !== "function") {
    var msg =
      "A function may only be subsribed to the event, " +
      type +
      " was provided instead";
    throw new Error(msg);
  }

  return handler;
};
