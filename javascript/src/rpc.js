/**
 * Contains the RPC object used both by the application
 * site, and by each plugin
 */
import { randId, typedArrayToDtype, EventManager } from "./utils.js";

export const API_VERSION = "0.2.1";

const ArrayBufferView = Object.getPrototypeOf(
  Object.getPrototypeOf(new Uint8Array())
).constructor;

function _appendBuffer(buffer1, buffer2) {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
}

function getKeyByValue(object, value) {
  return Object.keys(object).find(key => object[key] === value);
}
/**
 * RPC object represents a single site in the
 * communication protocol between the application and the plugin
 *
 * @param {Object} connection a special object allowing to send
 * and receive messages from the opposite site (basically it
 * should only provide send() and onMessage() methods)
 */
export class RPC extends EventManager {
  constructor(connection, config) {
    super(config && config.debug);
    this._connection = connection;
    this.config = config || {};
    this._interface_store = {};
    this._local_api = null;
    // make sure there is an execute function
    const name = this.config.name;
    this._connection.execute =
      this._connection.execute ||
      function() {
        throw new Error(`connection.execute not implemented (in "${name}")`);
      };
    this._store = new ReferenceStore();
    this._method_refs = new ReferenceStore();
    this._method_refs.onReady(() => {
      this._fire("remoteIdle");
    });
    this._method_refs.onBusy(() => {
      this._fire("remoteBusy");
    });
    this._setupMessageHanlders();
  }

  init() {
    this._connection.emit({
      type: "initialized",
      success: true,
      config: this.config
    });
  }
  /**
   * Set a handler to be called when received a responce from the
   * remote site reporting that the previously provided interface
   * has been successfully set as remote for that site
   *
   * @param {Function} handler
   */

  getRemoteCallStack() {
    return this._method_refs.getStack();
  }

  /**
   * @returns {Object} set of remote interface methods
   */
  getRemote() {
    return this._interface_store["_rremote"];
  }

  /**
   * Sets the interface of this site making it available to the
   * remote site by sending a message with a set of methods names
   *
   * @param {Object} _interface to set
   */
  setInterface(_interface) {
    if (this.config.forwarding_functions) {
      for (let func_name of this.config.forwarding_functions) {
        const _remote = this._interface_store["_rremote"];
        if (_remote[func_name]) {
          if (_interface.constructor === Object) {
            if (!_interface[func_name]) {
              _interface[func_name] = (...args) => {
                _remote[func_name](...args);
              };
            }
          } else if (_interface.constructor.constructor === Function) {
            if (!_interface.constructor.prototype[func_name]) {
              _interface.constructor.prototype[func_name] = (...args) => {
                _remote[func_name](...args);
              };
            }
          }
        }
      }
    }
    this._local_api = _interface;
    this._fire("interfaceAvailable");
  }

  /**
   * Sends the actual interface to the remote site upon it was
   * updated or by a special request of the remote site
   */
  sendInterface() {
    if (!this._local_api) {
      throw new Error("interface is not set.");
    }
    this._local_api._rid = "_rlocal";
    const api = this._encode(this._local_api, true);
    this._connection.emit({ type: "setInterface", api: api });
  }

  /**
   * Handles a message from the remote site
   */
  // var callback_reg = new RegExp("onupdate|run$")
  _setupMessageHanlders() {
    this._connection.on("init", this.init);
    this._connection.on("authenticate", credential => {
      // TODO: check credential
      this._connection.emit({
        type: "authenticated",
        success: true,
        token: "123"
      });
    });
    this._connection.on("execute", data => {
      Promise.resolve(this._connection.execute(data.code))
        .then(() => {
          this._connection.emit({ type: "executed", success: true });
        })
        .catch(e => {
          console.error(e);
          this._connection.emit({
            type: "executed",
            success: false,
            error: e
          });
        });
    });

    this._connection.on("method", data => {
      let resolve, reject, method, args, result;
      let _interface = this._interface_store[data.pid];
      const _method_context = _interface.__this__ || _interface;
      if (!_interface) {
        if (data.promise) {
          [resolve, reject] = this._unwrap(data.promise, false);
          reject(
            `plugin api function is not avaialbe in "${data.pid}", the plugin maybe terminated.`
          );
        } else {
          console.error(
            `plugin api function is not avaialbe in ${data.pid}, the plugin maybe terminated.`
          );
        }
        return;
      }

      method = _interface[data.name];
      args = this._unwrap(data.args, true);
      if (data.promise) {
        [resolve, reject] = this._unwrap(data.promise, false);
        try {
          result = method.apply(_method_context, args);
          if (
            result instanceof Promise ||
            (method.constructor && method.constructor.name === "AsyncFunction")
          ) {
            result.then(resolve).catch(reject);
          } else {
            resolve(result);
          }
        } catch (e) {
          console.error(this.config.name, e, method);
          reject(e);
        }
      } else {
        try {
          method.apply(_method_context, args);
        } catch (e) {
          console.error(this.config.name, e, method, args);
        }
      }
    });

    this._connection.on("callback", data => {
      let resolve, reject, method, args, result;
      if (data.promise) {
        [resolve, reject] = this._unwrap(data.promise, false);
        try {
          method = this._store.fetch(data._rindex);
          args = this._unwrap(data.args, true);
          if (!method) {
            throw new Error(
              "Callback function can only called once, if you want to call a function for multiple times, please make it as a plugin api function. See https://imjoy.io/docs for more details."
            );
          }
          result = method.apply(null, args);
          if (
            result instanceof Promise ||
            (method.constructor && method.constructor.name === "AsyncFunction")
          ) {
            result.then(resolve).catch(reject);
          } else {
            resolve(result);
          }
        } catch (e) {
          console.error(this.config.name, e, method);
          reject(e);
        }
      } else {
        try {
          method = this._store.fetch(data._rindex);
          args = this._unwrap(data.args, true);
          if (!method) {
            throw new Error(
              "Please notice that callback function can only called once, if you want to call a function for multiple times, please make it as a plugin api function. See https://imjoy.io/docs for more details."
            );
          }
          method.apply(null, args);
        } catch (e) {
          console.error(this.config.name, e, method, args);
        }
      }
    });
    this._connection.on("setInterface", data => {
      this._setRemoteInterface(data.api);
    });
    this._connection.on("getInterface", () => {
      this._fire("getInterface");
      if (this._local_api) this.sendInterface();
      else this.once("interfaceAvailable", this.sendInterface);
    });
    this._connection.on("interfaceSetAsRemote", () => {
      this._fire("interfaceSetAsRemote");
    });
    this._connection.on("disconnect", () => {
      this._fire("beforeDisconnect");
      this._connection.disconnect();
      this._fire("disconnected");
    });
  }

  async authenticate(credential) {
    this.once("authenticated", result => {
      if (result.success) {
        resolve(result);
      } else {
        reject(result.error);
      }
    });
    this._connection.emit({ type: "authenticate", credential: credential });
  }

  /**
   * Sends a requests to the remote site asking it to provide its
   * current interface
   */
  requestRemote() {
    this._connection.emit({ type: "getInterface" });
  }

  _ndarray(typedArray, shape, dtype) {
    var _dtype = typedArrayToDtype[typedArray.constructor.name];
    if (dtype && dtype !== _dtype) {
      throw "dtype doesn't match the type of the array: " +
        _dtype +
        " != " +
        dtype;
    }
    shape = shape || [typedArray.length];
    return {
      _rtype: "ndarray",
      _rvalue: typedArray,
      _rshape: shape,
      _rdtype: _dtype
    };
  }

  /**
   * Sets the new remote interface provided by the other site
   *
   * @param {Array} names list of function names
   */
  _setRemoteInterface(api) {
    this._interface_store["_rremote"] = this._decode(api);
    this._fire("remoteReady");
    this._reportRemoteSet();
  }

  /**
   * Generates the wrapped function corresponding to a single remote
   * method. When the generated function is called, it will send the
   * corresponding message to the remote site asking it to execute
   * the particular method of its interface
   *
   * @param {String} name of the remote method
   *
   * @returns {Function} wrapped remote method
   */
  _genRemoteMethod(name, plugin_id) {
    var me = this;
    var remoteMethod = function() {
      return new Promise((resolve, reject) => {
        let id = null;
        try {
          id = me._method_refs.put(plugin_id ? plugin_id + "/" + name : name);
          var wrapped_resolve = function() {
            if (id !== null) me._method_refs.fetch(id);
            return resolve.apply(this, arguments);
          };
          var wrapped_reject = function() {
            if (id !== null) me._method_refs.fetch(id);
            return reject.apply(this, arguments);
          };

          wrapped_resolve.__jailed_pairs__ = wrapped_reject;
          wrapped_reject.__jailed_pairs__ = wrapped_resolve;

          var args = Array.prototype.slice.call(arguments);
          if (name === "register" || name === "export" || name === "on") {
            args = me._wrap(args, true);
          } else {
            args = me._wrap(args);
          }
          var transferables = args.args.__transferables__;
          if (transferables) delete args.args.__transferables__;
          me._connection.emit(
            {
              type: "method",
              name: name,
              pid: plugin_id,
              args: args,
              promise: me._wrap([wrapped_resolve, wrapped_reject])
            },
            transferables
          );
        } catch (e) {
          if (id) me._method_refs.fetch(id);
          reject(
            `Failed to exectue remote method (plugin: ${plugin_id ||
              me.id}, method: ${name}), error: ${e}`
          );
        }
      });
    };
    remoteMethod.__remote_method = true;
    return remoteMethod;
  }

  /**
   * Sends a responce reporting that interface just provided by the
   * remote site was successfully set by this site as remote
   */
  _reportRemoteSet() {
    this._connection.emit({ type: "interfaceSetAsRemote" });
  }

  /**
   * Prepares the provided set of remote method arguments for
   * sending to the remote site, replaces all the callbacks with
   * identifiers
   *
   * @param {Array} args to wrap
   *
   * @returns {Array} wrapped arguments
   */

  _encodeInterface(aObject) {
    let v, k, keys;
    const encoded_interface = {};
    aObject["_rid"] = aObject["_rid"] || randId();
    // an object/array
    if (aObject.constructor === Object || Array.isArray(aObject)) {
      keys = Object.keys(aObject);
    }
    // a class
    else if (aObject.constructor === Function) {
      throw new Error("Please instantiate the class before exportting it.");
    }
    // instance of a class
    else if (aObject.constructor.constructor === Function) {
      keys = Object.getOwnPropertyNames(Object.getPrototypeOf(aObject)).concat(
        Object.keys(aObject)
      );
    } else {
      throw Error("Unsupported interface type");
    }

    const bObject = Array.isArray(aObject) ? [] : {};

    for (k of keys) {
      if (["hasOwnProperty", "constructor"].includes(k)) continue;

      if (k.startsWith("_")) {
        continue;
      }
      v = aObject[k];

      if (typeof v === "function") {
        bObject[k] = {
          _rtype: "interface",
          _rid: aObject["_rid"],
          _rvalue: k
        };
        encoded_interface[k] = v;
      } else if (Object(v) !== v) {
        bObject[k] = { _rtype: "argument", _rvalue: v };
        encoded_interface[k] = v;
      } else if (typeof v === "object") {
        bObject[k] = this._encodeInterface(v);
      }
    }
    this._interface_store[aObject["_rid"]] = encoded_interface;

    // remove interface when closed
    if (aObject.on && typeof aObject.on === "function") {
      aObject.on("close", () => {
        delete this._interface_store[aObject["_rid"]];
      });
    }
    return bObject;
  }

  _encode(aObject, as_interface) {
    const transferables = [];
    if (!aObject) {
      return aObject;
    }
    const _transfer = aObject._transfer;
    let bObject, v, k;
    const isarray = Array.isArray(aObject);
    //skip if already encoded
    if (typeof aObject === "object" && aObject._rtype && aObject._rvalue) {
      return aObject;
    }

    //encode interfaces
    if (
      typeof aObject === "object" &&
      !Array.isArray(aObject) &&
      (aObject._rintf || as_interface)
    ) {
      return this._encodeInterface(aObject);
    }

    if (as_interface) {
      aObject["_rid"] = aObject["_rid"] || randId();
      this._interface_store[aObject["_rid"]] =
        this._interface_store[aObject["_rid"]] || (isarray ? [] : {});
    }

    bObject = isarray ? [] : {};
    for (k in aObject) {
      if (["hasOwnProperty", "constructor"].includes(k)) continue;
      if (isarray || aObject.hasOwnProperty(k)) {
        v = aObject[k];
        if (v && typeof this._local_api._rpc_encode === "function") {
          const encoded_obj = this._local_api._rpc_encode(v);
          if (encoded_obj && encoded_obj._ctype) {
            bObject[k] = {
              _rtype: "custom",
              _rvalue: encoded_obj,
              _rid: aObject["_rid"]
            };
            continue;
          }
          // if the returned object does not contain _rtype, assuming the object has been transformed
          else if (encoded_obj !== undefined) {
            v = encoded_obj;
          }
        }
        if (typeof v === "function") {
          if (as_interface) {
            const encoded_interface = this._interface_store[aObject["_rid"]];
            bObject[k] = {
              _rtype: "interface",
              _rid: aObject["_rid"],
              _rvalue: k
            };
            encoded_interface[k] = v;
            continue;
          }
          let interfaceFuncName = null;
          for (var name in this._local_api) {
            if (this._local_api.hasOwnProperty(name)) {
              if (name.startsWith("_")) continue;
              if (this._local_api[name] === v) {
                interfaceFuncName = name;
                break;
              }
            }
          }
          // search for prototypes
          var functions = Object.getOwnPropertyNames(
            Object.getPrototypeOf(this._local_api)
          );
          for (var i = 0; i < functions.length; i++) {
            var name_ = functions[i];
            if (name_.startsWith("_")) continue;
            if (this._local_api[name_] === v) {
              interfaceFuncName = name_;
              break;
            }
          }
          if (!interfaceFuncName) {
            var id = this._store.put(v);
            bObject[k] = {
              _rtype: "callback",
              _rvalue: (v.constructor && v.constructor.name) || id,
              _rindex: id
            };
          } else {
            bObject[k] = {
              _rtype: "interface",
              _rvalue: interfaceFuncName,
              _rid: "_rlocal"
            };
          }
        } else if (
          /*global tf*/
          typeof tf !== "undefined" &&
          tf.Tensor &&
          v instanceof tf.Tensor
        ) {
          const v_buffer = v.dataSync();
          if (v._transfer || _transfer) {
            transferables.push(v_buffer.buffer);
            delete v._transfer;
          }
          bObject[k] = {
            _rtype: "ndarray",
            _rvalue: v_buffer,
            _rshape: v.shape,
            _rdtype: v.dtype
          };
        } else if (
          /*global nj*/
          typeof nj !== "undefined" &&
          nj.NdArray &&
          v instanceof nj.NdArray
        ) {
          var dtype = typedArrayToDtype[v.selection.data.constructor.name];
          if (v._transfer || _transfer) {
            transferables.push(v.selection.data.buffer);
            delete v._transfer;
          }
          bObject[k] = {
            _rtype: "ndarray",
            _rvalue: v.selection.data,
            _rshape: v.shape,
            _rdtype: dtype
          };
        } else if (v instanceof Error) {
          console.error(v);
          bObject[k] = { _rtype: "error", _rvalue: v.toString() };
        } else if (typeof File !== "undefined" && v instanceof File) {
          bObject[k] = {
            _rtype: "file",
            _rvalue: v,
            _rrelative_path: v.relativePath || v.webkitRelativePath
          };
        }
        // send objects supported by structure clone algorithm
        // https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
        else if (
          v !== Object(v) ||
          v instanceof Boolean ||
          v instanceof String ||
          v instanceof Date ||
          v instanceof RegExp ||
          v instanceof Blob ||
          v instanceof ImageData ||
          (typeof FileList !== "undefined" && v instanceof FileList)
        ) {
          bObject[k] = { _rtype: "argument", _rvalue: v };
        } else if (v instanceof ArrayBuffer) {
          if (v._transfer || _transfer) {
            transferables.push(v);
            delete v._transfer;
          }
          bObject[k] = { _rtype: "argument", _rvalue: v };
        } else if (v instanceof ArrayBufferView) {
          if (v._transfer || _transfer) {
            transferables.push(v.buffer);
            delete v._transfer;
          }
          bObject[k] = { _rtype: "argument", _rvalue: v };
        }
        // TODO: support also Map and Set
        // TODO: avoid object such as DynamicPlugin instance.
        else if (v._rintf) {
          bObject[k] = this._encode(v, true);
        } else if (typeof v === "object") {
          bObject[k] = this._encode(v, as_interface);
          // move transferables to the top level object
          if (bObject[k].__transferables__) {
            for (var t = 0; t < bObject[k].__transferables__.length; t++) {
              transferables.push(bObject[k].__transferables__[t]);
            }
            delete bObject[k].__transferables__;
          }
        } else {
          throw "Unsupported data type for transferring between the plugin and the main app: " +
            k +
            "," +
            v;
        }
      }
    }
    if (transferables.length > 0) {
      bObject.__transferables__ = transferables;
    }
    return bObject;
  }

  _decode(aObject, callbackId, withPromise) {
    if (!aObject) {
      return aObject;
    }
    var bObject, v, k;
    if (aObject.hasOwnProperty("_rtype") && aObject.hasOwnProperty("_rvalue")) {
      if (aObject._rtype === "custom") {
        if (
          aObject._rvalue &&
          typeof this._local_api._rpc_decode === "function"
        ) {
          bObject = this._local_api._rpc_decode(aObject._rvalue);
          if (bObject === undefined) {
            bObject = aObject;
          }
        } else {
          bObject = aObject;
        }
      } else if (aObject._rtype === "callback") {
        bObject = this._genRemoteCallback(
          callbackId,
          aObject._rindex,
          withPromise
        );
      } else if (aObject._rtype === "interface") {
        const intfid = aObject._rid === "_rlocal" ? "_rrmote" : aObject._rid;
        bObject =
          (this._interface_store[intfid] &&
            this._interface_store[intfid][aObject._rvalue]) ||
          this._genRemoteMethod(aObject._rvalue, aObject._rid);
      } else if (aObject._rtype === "ndarray") {
        /*global nj tf*/
        //create build array/tensor if used in the plugin
        if (this.id === "__plugin__" && typeof nj !== "undefined" && nj.array) {
          if (Array.isArray(aObject._rvalue)) {
            aObject._rvalue = aObject._rvalue.reduce(_appendBuffer);
          }
          bObject = nj
            .array(aObject._rvalue, aObject._rdtype)
            .reshape(aObject._rshape);
        } else if (
          this.id === "__plugin__" &&
          typeof tf !== "undefined" &&
          tf.Tensor
        ) {
          if (Array.isArray(aObject._rvalue)) {
            aObject._rvalue = aObject._rvalue.reduce(_appendBuffer);
          }
          bObject = tf.tensor(
            aObject._rvalue,
            aObject._rshape,
            aObject._rdtype
          );
        } else {
          //keep it as regular if transfered to the main app
          bObject = aObject;
        }
      } else if (aObject._rtype === "error") {
        bObject = new Error(aObject._rvalue);
      } else if (aObject._rtype === "file") {
        bObject = aObject._rvalue;
        //patch relativePath
        bObject.relativePath = aObject._rrelative_path;
      } else if (aObject._rtype === "argument") {
        bObject = aObject._rvalue;
      }
      return bObject;
    } else {
      var isarray = Array.isArray(aObject);
      bObject = isarray ? [] : {};
      for (k in aObject) {
        if (isarray || aObject.hasOwnProperty(k)) {
          v = aObject[k];
          if (typeof v === "object" || Array.isArray(v)) {
            bObject[k] = this._decode(v, callbackId, withPromise);
          }
        }
      }
      return bObject;
    }
  }

  _wrap(args, as_interface) {
    var wrapped = this._encode(args, as_interface);
    var result = { args: wrapped };
    return result;
  }

  /**
   * Unwraps the set of arguments delivered from the remote site,
   * replaces all callback identifiers with a function which will
   * initiate sending that callback identifier back to other site
   *
   * @param {Object} args to unwrap
   *
   * @param {Boolean} withPromise is true means this the callback should contain a promise
   *
   * @returns {Array} unwrapped args
   */
  _unwrap(args, withPromise) {
    // var called = false;

    // wraps each callback so that the only one could be called
    // var once(cb) {
    //     return function() {
    //         if (!called) {
    //             called = true;
    //             return cb.apply(this, arguments);
    //         } else {
    //             var msg =
    //               'A callback from this set has already been executed';
    //             throw new Error(msg);
    //         }
    //     };
    // }
    var result = this._decode(args.args, args.callbackId, withPromise);
    return result;
  }

  /**
   * Generates the wrapped function corresponding to a single remote
   * callback. When the generated function is called, it will send
   * the corresponding message to the remote site asking it to
   * execute the particular callback previously saved during a call
   * by the remote site a method from the interface of this site
   *
   * @param {Number} id of the remote callback to execute
   * @param {Number} argNum argument index of the callback
   * @param {Boolean} withPromise is true means this the callback should contain a promise
   *
   * @returns {Function} wrapped remote callback
   */
  _genRemoteCallback(id, argNum, withPromise) {
    var me = this;
    var remoteCallback;
    if (withPromise) {
      remoteCallback = function() {
        return new Promise((resolve, reject) => {
          var args = me._wrap(Array.prototype.slice.call(arguments));
          var transferables = args.args.__transferables__;
          if (transferables) delete args.args.__transferables__;
          resolve.__jailed_pairs__ = reject;
          reject.__jailed_pairs__ = resolve;
          try {
            me._connection.emit(
              {
                type: "callback",
                id: id,
                _rindex: argNum,
                args: args,
                // pid :  me.id,
                promise: me._wrap([resolve, reject])
              },
              transferables
            );
          } catch (e) {
            reject(
              `Failed to exectue remote callback (id: ${id}, argNum: ${argNum}).`
            );
          }
        });
      };
      return remoteCallback;
    } else {
      remoteCallback = function() {
        var args = me._wrap(Array.prototype.slice.call(arguments));
        var transferables = args.args.__transferables__;
        if (transferables) delete args.args.__transferables__;
        return me._connection.emit(
          {
            type: "callback",
            id: id,
            _rindex: argNum,
            args: args
            // pid :  me.id
          },
          transferables
        );
      };
      return remoteCallback;
    }
  }

  /**
   * Sends the notification message and breaks the connection
   */
  disconnect() {
    this._connection.emit({ type: "disconnect" });
    setTimeout(() => {
      this._connection.disconnect();
    }, 2000);
  }
}

/**
 * ReferenceStore is a special object which stores other objects
 * and provides the references (number) instead. This reference
 * may then be sent over a json-based communication channel (IPC
 * to another Node.js process or a message to the Worker). Other
 * site may then provide the reference in the responce message
 * implying the given object should be activated.
 *
 * Primary usage for the ReferenceStore is a storage for the
 * callbacks, which therefore makes it possible to initiate a
 * callback execution by the opposite site (which normally cannot
 * directly execute functions over the communication channel).
 *
 * Each stored object can only be fetched once and is not
 * available for the second time. Each stored object must be
 * fetched, since otherwise it will remain stored forever and
 * consume memory.
 *
 * Stored object indeces are simply the numbers, which are however
 * released along with the objects, and are later reused again (in
 * order to postpone the overflow, which should not likely happen,
 * but anyway).
 */
class ReferenceStore {
  constructor() {
    this._store = {}; // stored object
    this._indices = [0]; // smallest available indices
    this._readyHandler = function() {};
    this._busyHandler = function() {};
    this._readyHandler();
  }

  /**
   * call handler when the store is empty
   *
   * @param {FUNCTION} id of a handler
   */
  onReady(readyHandler) {
    this._readyHandler = readyHandler || function() {};
  }

  /**
   * call handler when the store is not empty
   *
   * @param {FUNCTION} id of a handler
   */
  onBusy(busyHandler) {
    this._busyHandler = busyHandler || function() {};
  }

  /**
   * get the length of the store
   *
   */
  getStack() {
    return Object.keys(this._store).length;
  }

  /**
   * @function _genId() generates the new reference id
   *
   * @returns {Number} smallest available id and reserves it
   */
  _genId() {
    var id;
    if (this._indices.length === 1) {
      id = this._indices[0]++;
    } else {
      id = this._indices.shift();
    }

    return id;
  }

  /**
   * Releases the given reference id so that it will be available by
   * another object stored
   *
   * @param {Number} id to release
   */
  _releaseId(id) {
    for (var i = 0; i < this._indices.length; i++) {
      if (id < this._indices[i]) {
        this._indices.splice(i, 0, id);
        break;
      }
    }

    // cleaning-up the sequence tail
    for (i = this._indices.length - 1; i >= 0; i--) {
      if (this._indices[i] - 1 === this._indices[i - 1]) {
        this._indices.pop();
      } else {
        break;
      }
    }
  }

  /**
   * Stores the given object and returns the refernce id instead
   *
   * @param {Object} obj to store
   *
   * @returns {Number} reference id of the stored object
   */
  put(obj) {
    if (this._busyHandler && Object.keys(this._store).length === 0) {
      this._busyHandler();
    }
    var id = this._genId();
    this._store[id] = obj;
    return id;
  }

  /**
   * Retrieves previously stored object and releases its reference
   *
   * @param {Number} id of an object to retrieve
   */
  fetch(id) {
    var obj = this._store[id];
    if (obj && !obj.__remote_method) {
      delete this._store[id];
      this._releaseId(id);
      if (this._readyHandler && Object.keys(this._store).length === 0) {
        this._readyHandler();
      }
    }
    if (obj && obj.__jailed_pairs__) {
      const _id = getKeyByValue(this._store, obj.__jailed_pairs__);
      this.fetch(_id);
    }
    return obj;
  }
}
