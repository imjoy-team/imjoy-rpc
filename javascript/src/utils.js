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

export function setupServiceWorker() {
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
