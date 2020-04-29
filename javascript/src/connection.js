/**
 * Platform-dependent implementation of the BasicConnection
 * object, initializes the plugin site and provides the basic
 * messaging-based connection with it
 *
 * For the web-browser environment, the plugin is created as a
 * Worker in a sandbaxed frame
 */
import { Whenable } from "./utils.js";

class BasicConnection {
  constructor(id, type, config) {
    this._init = new Whenable(true);
    this._fail = new Whenable();
    this._disconnected = false;
    this.id = id;
    this.platformSpec = {};
    var iframe_container = config.iframe_container;
    var sample = document.createElement("iframe");
    this._disconnectHandler = () => {};
    sample.src = config.base_frame;
    sample.sandbox = "";
    sample.frameBorder = "0";
    sample.style.width = "100%";
    sample.style.height = "100%";
    sample.style.margin = "0";
    sample.style.padding = "0";
    sample.style.display = "none";

    var me = this;

    me._frame = sample.cloneNode(false);
    var perm = [
      "allow-scripts",
      "allow-forms",
      "allow-modals",
      "allow-popups",
      "allow-same-origin"
    ];
    var allows = "";
    if (config.permissions) {
      if (config.permissions.includes("midi") && !allows.includes("midi *;")) {
        allows += "midi *;";
      }
      if (
        config.permissions.includes("geolocation") &&
        !allows.includes("geolocation *;")
      ) {
        allows += "geolocation *;";
      }
      if (
        config.permissions.includes("microphone") &&
        !allows.includes("microphone *;")
      ) {
        allows += "microphone *;";
      }
      if (
        config.permissions.includes("camera") &&
        !allows.includes("camera *;")
      ) {
        allows += "camera *;";
      }
      if (
        config.permissions.includes("encrypted-media") &&
        !allows.includes("encrypted-media *;")
      ) {
        allows += "encrypted-media *;";
      }
      if (config.permissions.includes("full-screen")) {
        me._frame.allowfullscreen = "";
      }
      if (config.permissions.includes("payment-request")) {
        me._frame.allowpaymentrequest = "";
      }
    }
    me._frame.sandbox = perm.join(" ");
    me._frame.allow = allows;

    if (type !== "window") {
      me._frame.src =
        me._frame.src +
        (me._frame.src.includes("?") ? "&" : "?") +
        "_plugin_type=" +
        type;
    }

    me._frame.id = "iframe_" + id;
    if (
      type === "iframe" ||
      type === "window" ||
      type === "web-python-window"
    ) {
      if (typeof iframe_container === "string") {
        iframe_container = document.getElementById(iframe_container);
      }
      if (iframe_container) {
        me._frame.style.display = "block";
        iframe_container.appendChild(me._frame);
        me.iframe_container = iframe_container;
      } else {
        document.body.appendChild(me._frame);
        me.iframe_container = null;
      }
    } else {
      document.body.appendChild(me._frame);
    }
    window.addEventListener("message", function(e) {
      if (e.source === me._frame.contentWindow) {
        const m = e.data;
        if (m.type === "initialized") {
          me.platformSpec = m.spec;
          me._init.emit(me.platformSpec);
        } else {
          me._messageHandler(m);
        }
      }
    });
  }

  /**
   * Sets-up the handler to be called upon the BasicConnection
   * initialization is completed.
   *
   * For the web-browser environment, the handler is issued when
   * the plugin worker successfully imported and executed the
   * _pluginWebWorker.js or _pluginWebIframe.js, and replied to
   * the application site with the initImprotSuccess message.
   *
   * @param {Function} handler to be called upon connection init
   */
  whenInit(handler) {
    this._init.whenEmitted(handler);
  }

  /**
   * Sets-up the handler to be called upon the BasicConnection
   * failed.
   *
   * For the web-browser environment, the handler is issued when
   * the plugin worker successfully imported and executed the
   * _pluginWebWorker.js or _pluginWebIframe.js, and replied to
   * the application site with the initImprotSuccess message.
   *
   * @param {Function} handler to be called upon connection init
   */
  whenFailed(handler) {
    this._fail.whenEmitted(handler);
  }

  /**
   * Sends a message to the plugin site
   *
   * @param {Object} data to send
   */
  send(data, transferables) {
    this._frame.contentWindow &&
      this._frame.contentWindow.postMessage(data, "*", transferables);
  }

  /**
   * Adds a handler for a message received from the plugin site
   *
   * @param {Function} handler to call upon a message
   */
  onMessage(handler) {
    this._messageHandler = handler;
  }

  /**
   * Adds a handler for the event of plugin disconnection
   * (not used in case of Worker)
   *
   * @param {Function} handler to call upon a disconnect
   */
  onDisconnect(handler) {
    this._disconnectHandler = handler;
  }

  /**
   * Disconnects the plugin (= kills the frame)
   */
  disconnect() {
    if (!this._disconnected) {
      this._disconnected = true;
      if (typeof this._frame !== "undefined") {
        this._frame.parentNode.removeChild(this._frame);
      } // otherwise farme is not yet created
      this._disconnectHandler();
    }
  }
}

/**
 * Application-site Connection object constructon, reuses the
 * platform-dependent BasicConnection declared above in order to
 * communicate with the plugin environment, implements the
 * application-site protocol of the interraction: provides some
 * methods for loading scripts and executing the given code in the
 * plugin
 */
export function Connection(id, type, config) {
  this._platformConnection = new BasicConnection(id, type, config);
  this._importCallbacks = {};
  this._executeSCb = function() {};
  this._executeFCb = function() {};
  this._messageHandler = function() {};

  var me = this;
  this.whenInit = function(cb) {
    me._platformConnection.whenInit(cb);
  };

  this.whenFailed = function(cb) {
    me._platformConnection.whenFailed(cb);
  };

  this._platformConnection.onMessage(function(m) {
    switch (m && m.type) {
      case "importSuccess":
        me._handleImportSuccess(m.url);
        break;
      case "importFailure":
        me._handleImportFailure(m.url, m.error);
        break;
      case "executeSuccess":
        me._executeSCb();
        break;
      case "executeFailure":
        me._executeFCb(m.error);
        break;
      default:
        me._messageHandler(m);
    }
  });
}

/**
 * @returns {Boolean} true if a connection obtained a dedicated
 * thread (subprocess in Node.js or a subworker in browser) and
 * therefore will not hang up on the infinite loop in the
 * untrusted code
 */
Connection.prototype.hasDedicatedThread = function() {
  return this._platformConnection.platformSpec.dedicatedThread;
};

/**
 * @returns {Boolean} true if a connection obtained a dedicated
 * thread (subprocess in Node.js or a subworker in browser) and
 * therefore will not hang up on the infinite loop in the
 * untrusted code
 */
Connection.prototype.checkAllowExecution = function() {
  return this._platformConnection.platformSpec.allowExecution;
};

/**
 * Tells the plugin to load a script with the given path, and to
 * execute it. Callbacks executed upon the corresponding responce
 * message from the plugin site
 *
 * @param {String} path of a script to load
 * @param {Function} sCb to call upon success
 * @param {Function} fCb to call upon failure
 */
Connection.prototype.importScript = function(path, sCb, fCb) {
  var f = function() {};
  this._importCallbacks[path] = { sCb: sCb || f, fCb: fCb || f };
  this._platformConnection.send({ type: "import", url: path });
};

/**
 * Tells the plugin to load a script with the given path, and to
 * execute it in the JAILED environment. Callbacks executed upon
 * the corresponding responce message from the plugin site
 *
 * @param {String} path of a script to load
 * @param {Function} sCb to call upon success
 * @param {Function} fCb to call upon failure
 */
Connection.prototype.importJailedScript = function(path, sCb, fCb) {
  var f = function() {};
  this._importCallbacks[path] = { sCb: sCb || f, fCb: fCb || f };
  this._platformConnection.send({ type: "importJailed", url: path });
};

/**
 * Sends the code to the plugin site in order to have it executed
 * in the JAILED enviroment. Assuming the execution may only be
 * requested once by the Plugin object, which means a single set
 * of callbacks is enough (unlike importing additional scripts)
 *
 * @param {String} code code to execute
 * @param {Function} sCb to call upon success
 * @param {Function} fCb to call upon failure
 */
Connection.prototype.execute = function(code) {
  return new Promise((resolve, reject) => {
    this._executeSCb = resolve;
    this._executeFCb = reject;
    if (this._platformConnection.platformSpec.allowExecution) {
      this._platformConnection.send({ type: "execute", code: code });
    } else {
      reject("Connection does not allow execution");
    }
  });
};

/**
 * Adds a handler for a message received from the plugin site
 *
 * @param {Function} handler to call upon a message
 */
Connection.prototype.onMessage = function(handler) {
  this._messageHandler = handler;
};

/**
 * Adds a handler for a disconnect message received from the
 * plugin site
 *
 * @param {Function} handler to call upon disconnect
 */
Connection.prototype.onDisconnect = function(handler) {
  this._platformConnection.onDisconnect(handler);
};

/**
 * Sends a message to the plugin
 *
 * @param {Object} data of the message to send
 */
Connection.prototype.send = function(data, transferables) {
  this._platformConnection.send(data, transferables);
};

/**
 * Handles import succeeded message from the plugin
 *
 * @param {String} url of a script loaded by the plugin
 */
Connection.prototype._handleImportSuccess = function(url) {
  var sCb = this._importCallbacks[url].sCb;
  this._importCallbacks[url] = null;
  delete this._importCallbacks[url];
  sCb();
};

/**
 * Handles import failure message from the plugin
 *
 * @param {String} url of a script loaded by the plugin
 */
Connection.prototype._handleImportFailure = function(url, error) {
  var fCb = this._importCallbacks[url].fCb;
  this._importCallbacks[url] = null;
  delete this._importCallbacks[url];
  fCb(error);
};

/**
 * Disconnects the plugin when it is not needed anymore
 */
Connection.prototype.disconnect = function() {
  if (this._platformConnection) {
    this._platformConnection.disconnect();
  }
};
