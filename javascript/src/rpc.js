/**
 * Contains the RPC object used both by the application
 * site, and by each plugin
 */
import {
  randId,
  typedArrayToDtype,
  dtypeToTypedArray,
  MessageEmitter
} from "./utils.js";

export const API_VERSION = "0.2.2";

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
export class RPC extends MessageEmitter {
  constructor(connection, config) {
    super(config && config.debug);
    this._connection = connection;
    this.config = config || {};
    this._object_store = {};
    this._method_weakmap = new WeakMap();
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
      config: this.config,
      peer_id: this._connection.peer_id
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
    return this._remote_interface;
  }

  /**
   * Sets the interface of this site making it available to the
   * remote site by sending a message with a set of methods names
   *
   * @param {Object} _interface to set
   */
  setInterface(_interface, config) {
    config = config || {};
    this.config.name = config.name || this.config.name;
    this.config.description = config.description || this.config.description;
    if (this.config.forwarding_functions) {
      for (let func_name of this.config.forwarding_functions) {
        const _remote = this._remote_interface;
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
    this._local_api._rintf = "_rlocal";
    const api = this._encode(this._local_api, true);
    this._connection.emit({ type: "setInterface", api: api });
  }

  _disposeObject(object_id) {
    if (this._object_store[object_id]) {
      delete this._object_store[object_id];
    }
  }

  disposeObject(proxyObj) {
    if (proxyObj._rintf) {
      this._connection.emit({
        type: "disposeObject",
        object_id: proxyObj._rintf
      });
    } else {
      throw new Error("Invalid object");
    }
  }

  /**
   * Handles a message from the remote site
   */
  // var callback_reg = new RegExp("onupdate|run$")
  _setupMessageHanlders() {
    this._connection.on("init", this.init);
    this._connection.on("execute", data => {
      Promise.resolve(this._connection.execute(data.code))
        .then(() => {
          this._connection.emit({ type: "executed" });
        })
        .catch(e => {
          console.error(e);
          this._connection.emit({
            type: "executed",
            error: e
          });
        });
    });

    this._connection.on("method", data => {
      let resolve, reject, method, args, result;
      let _interface = this._object_store[data.pid];
      const _method_context = _interface;
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
          method = this._store.fetch(data.index);
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
          method = this._store.fetch(data.index);
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
    this._connection.on("disposeObject", data => {
      this._disposeObject(data.object_id);
    });
    this._connection.on("setInterface", data => {
      this._setRemoteInterface(data.api);
    });
    this._connection.on("getInterface", () => {
      this._fire("getInterface");
      if (this._local_api) {
        this.sendInterface();
      } else {
        this.once("interfaceAvailable", () => {
          this.sendInterface();
        });
      }
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
      _rvalue: typedArray.buffer,
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
    this._remote_interface = this._decode(api);
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
  _genRemoteMethod(name, object_id) {
    var me = this;
    var remoteMethod = function() {
      return new Promise((resolve, reject) => {
        let id = null;
        try {
          id = me._method_refs.put(object_id ? object_id + "/" + name : name);
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
          var transferables = args.__transferables__;
          if (transferables) delete args.__transferables__;
          me._connection.emit(
            {
              type: "method",
              name: name,
              pid: object_id,
              args: args,
              promise: me._wrap([wrapped_resolve, wrapped_reject])
            },
            transferables
          );
        } catch (e) {
          if (id) me._method_refs.fetch(id);
          reject(
            `Failed to exectue remote method (interface: ${object_id ||
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
  _encode(aObject, as_interface, object_id) {
    const transferables = [];
    if (!aObject) {
      return aObject;
    }
    const _transfer = aObject._transfer;
    let bObject;
    const isarray = Array.isArray(aObject);
    //skip if already encoded
    if (typeof aObject === "object" && aObject._rtype && aObject._rvalue) {
      return aObject;
    }

    if (aObject && typeof this._local_api._rpc_encode === "function") {
      const encoded_obj = this._local_api._rpc_encode(aObject);
      if (encoded_obj && encoded_obj._ctype) {
        bObject = {
          _rtype: "custom",
          _rvalue: encoded_obj,
          _rid: aObject["_rid"]
        };
        return bObject;
      }
      // if the returned object does not contain _rtype, assuming the object has been transformed
      else if (encoded_obj !== undefined) {
        aObject = encoded_obj;
      }
    }
    if (typeof aObject === "function") {
      if (as_interface) {
        if (!object_id) throw new Error("object_id is not specified.");
        bObject = {
          _rtype: "interface",
          _rintf: object_id,
          _rvalue: as_interface
        };
        this._method_weakmap.set(aObject, bObject);
      } else if (this._method_weakmap.has(aObject)) {
        bObject = this._method_weakmap.get(aObject);
      } else {
        const cid = this._store.put(aObject);
        bObject = {
          _rtype: "callback",
          _rvalue: (aObject.constructor && aObject.constructor.name) || cid,
          _rindex: cid
        };
      }
    } else if (
      /*global tf*/
      typeof tf !== "undefined" &&
      tf.Tensor &&
      aObject instanceof tf.Tensor
    ) {
      const v_buffer = aObject.dataSync();
      if (aObject._transfer || _transfer) {
        transferables.push(v_buffer.buffer);
        delete aObject._transfer;
      }
      bObject = {
        _rtype: "ndarray",
        _rvalue: v_buffer.buffer,
        _rshape: aObject.shape,
        _rdtype: aObject.dtype
      };
    } else if (
      /*global nj*/
      typeof nj !== "undefined" &&
      nj.NdArray &&
      aObject instanceof nj.NdArray
    ) {
      var dtype = typedArrayToDtype[aObject.selection.data.constructor.name];
      if (aObject._transfer || _transfer) {
        transferables.push(aObject.selection.data.buffer);
        delete aObject._transfer;
      }
      bObject = {
        _rtype: "ndarray",
        _rvalue: aObject.selection.data.buffer,
        _rshape: aObject.shape,
        _rdtype: dtype
      };
    } else if (aObject instanceof ArrayBuffer) {
      if (aObject._transfer || _transfer) {
        transferables.push(aObject);
        delete aObject._transfer;
      }
      bObject = aObject;
    } else if (aObject instanceof Error) {
      console.error(aObject);
      bObject = { _rtype: "error", _rvalue: aObject.toString() };
    } else if (typeof File !== "undefined" && aObject instanceof File) {
      bObject = {
        _rtype: "file",
        _rvalue: aObject,
        _rpath: aObject._path || aObject.webkitRelativePath
      };
    }
    // send objects supported by structure clone algorithm
    // https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
    else if (
      aObject !== Object(aObject) ||
      aObject instanceof Boolean ||
      aObject instanceof String ||
      aObject instanceof Date ||
      aObject instanceof RegExp ||
      aObject instanceof Blob ||
      aObject instanceof ImageData ||
      (typeof FileList !== "undefined" && aObject instanceof FileList)
    ) {
      bObject = aObject;
      // TODO: avoid object such as DynamicPlugin instance.
    } else if (typeof File !== "undefined" && aObject instanceof File) {
      bObject = {
        _rtype: "file",
        _rname: aObject.name,
        _rmime: aObject.type,
        _rvalue: aObject,
        _rpath: aObject._path || aObject.webkitRelativePath
      };
    } else if (aObject instanceof Blob) {
      bObject = { _rtype: "blob", _rvalue: aObject };
    } else if (aObject instanceof ArrayBuffer) {
      if (aObject._transfer || _transfer) {
        transferables.push(aObject);
        delete aObject._transfer;
      }
      bObject = { _rtype: "bytes", _rvalue: aObject };
    } else if (aObject instanceof ArrayBufferView) {
      if (aObject._transfer || _transfer) {
        transferables.push(aObject.buffer);
        delete aObject._transfer;
      }
      const dtype = typedArrayToDtype[aObject.constructor.name];
      bObject = {
        _rtype: "typedarray",
        _rvalue: aObject.buffer,
        _rdtype: dtype
      };
    } else if (aObject instanceof DataView) {
      if (aObject._transfer || _transfer) {
        transferables.push(aObject.buffer);
        delete aObject._transfer;
      }
      bObject = { _rtype: "memoryview", _rvalue: aObject.buffer };
    } else if (aObject instanceof Set) {
      bObject = {
        _rtype: "set",
        _rvalue: this._encode(Array.from(aObject), as_interface)
      };
    } else if (aObject instanceof Map) {
      bObject = {
        _rtype: "orderedmap",
        _rvalue: this._encode(Array.from(aObject), as_interface)
      };
    } else if (
      aObject.constructor instanceof Object ||
      Array.isArray(aObject)
    ) {
      bObject = isarray ? [] : {};
      let keys;
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
        keys = Object.getOwnPropertyNames(
          Object.getPrototypeOf(aObject)
        ).concat(Object.keys(aObject));
        // TODO: use a proxy object to represent the actual object
        // always encode class instance as interface
        as_interface = true;
      } else {
        throw Error("Unsupported interface type");
      }
      // encode interfaces
      if (aObject._rintf || as_interface) {
        object_id = randId();
        for (let k of keys) {
          if (k === "constructor") continue;
          if (k.startsWith("_")) {
            continue;
          }
          // only encode primitive types, function, object, array
          if (
            typeof aObject[k] === "function" ||
            aObject.constructor instanceof Object ||
            Array.isArray(aObject)
          )
            bObject[k] = this._encode(aObject[k], k, object_id);
          else if (aObject !== Object(aObject)) {
            bObject[k] = aObject[k];
          }
        }
        // object id, used for dispose the object
        bObject._rintf = object_id;
        this._object_store[object_id] = aObject;
        // remove interface when closed
        if (aObject.on && typeof aObject.on === "function") {
          aObject.on("close", () => {
            delete this._object_store[object_id];
          });
        }
      } else {
        for (let k of keys) {
          if (["hasOwnProperty", "constructor"].includes(k)) continue;
          bObject[k] = this._encode(aObject[k]);
        }
      }
      // for example, browserFS object
    } else if (typeof aObject === "object") {
      const keys = Object.getOwnPropertyNames(
        Object.getPrototypeOf(aObject)
      ).concat(Object.keys(aObject));
      const object_id = randId();

      for (let k of keys) {
        if (["hasOwnProperty", "constructor"].includes(k)) continue;
        // encode as interface
        bObject[k] = this._encode(aObject[k], k, bObject);
      }
      // object id, used for dispose the object
      bObject._rintf = object_id;
    } else {
      throw "imjoy-rpc: Unsupported data type:" + aObject;
    }

    if (transferables.length > 0) {
      bObject.__transferables__ = transferables;
    }
    return bObject;
  }

  _decode(aObject, withPromise) {
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
        bObject = this._genRemoteCallback(aObject._rindex, withPromise);
      } else if (aObject._rtype === "interface") {
        bObject = this._genRemoteMethod(aObject._rvalue, aObject._rintf);
      } else if (aObject._rtype === "ndarray") {
        /*global nj tf*/
        //create build array/tensor if used in the plugin
        if (typeof nj !== "undefined" && nj.array) {
          if (Array.isArray(aObject._rvalue)) {
            aObject._rvalue = aObject._rvalue.reduce(_appendBuffer);
          }
          bObject = nj
            .array(new Uint8(aObject._rvalue), aObject._rdtype)
            .reshape(aObject._rshape);
        } else if (typeof tf !== "undefined" && tf.Tensor) {
          if (Array.isArray(aObject._rvalue)) {
            aObject._rvalue = aObject._rvalue.reduce(_appendBuffer);
          }
          const arraytype = eval(dtypeToTypedArray[aObject._rdtype]);
          bObject = tf.tensor(
            new arraytype(aObject._rvalue),
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
        if (aObject._rvalue instanceof File) {
          bObject = aObject._rvalue;
          //patch _path
          bObject._path = aObject._rpath;
        } else {
          bObject = new File([aObject._rvalue], aObject._rname, {
            type: aObject._rmime
          });
          bObject._path = aObject._rpath;
        }
      } else if (aObject._rtype === "bytes") {
        bObject = aObject._rvalue;
      } else if (aObject._rtype === "typedarray") {
        const arraytype = eval(dtypeToTypedArray[aObject._rdtype]);
        if (!arraytype)
          throw new Error("unsupported dtype: " + aObject._rdtype);
        bObject = new arraytype(aObject._rvalue);
      } else if (aObject._rtype === "memoryview") {
        bObject = new DataView(aObject._rvalue);
      } else if (aObject._rtype === "blob") {
        if (aObject._rvalue instanceof Blob) {
          bObject = aObject._rvalue;
        } else {
          bObject = new Blob([aObject._rvalue], { type: aObject._rmime });
        }
      } else if (aObject._rtype === "orderedmap") {
        bObject = new Map(this._decode(aObject._rvalue, withPromise));
      } else if (aObject._rtype === "set") {
        bObject = new Set(this._decode(aObject._rvalue, withPromise));
      } else {
        bObject = aObject;
      }
      return bObject;
    } else if (aObject.constructor === Object || Array.isArray(aObject)) {
      var isarray = Array.isArray(aObject);
      bObject = isarray ? [] : {};
      for (k in aObject) {
        if (isarray || aObject.hasOwnProperty(k)) {
          v = aObject[k];
          bObject[k] = this._decode(v, withPromise);
        }
      }
      return bObject;
    } else {
      return aObject;
    }
  }

  _wrap(args, as_interface) {
    var wrapped = this._encode(args, as_interface);
    return wrapped;
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
    var result = this._decode(args, withPromise);
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
  _genRemoteCallback(index, withPromise) {
    var me = this;
    var remoteCallback;
    if (withPromise) {
      remoteCallback = function() {
        return new Promise((resolve, reject) => {
          var args = me._wrap(Array.prototype.slice.call(arguments));
          var transferables = args.__transferables__;
          if (transferables) delete args.__transferables__;
          resolve.__jailed_pairs__ = reject;
          reject.__jailed_pairs__ = resolve;
          try {
            me._connection.emit(
              {
                type: "callback",
                index: index,
                args: args,
                // pid :  me.id,
                promise: me._wrap([resolve, reject])
              },
              transferables
            );
          } catch (e) {
            reject(`Failed to exectue remote callback ( index: ${index}).`);
          }
        });
      };
      return remoteCallback;
    } else {
      remoteCallback = function() {
        var args = me._wrap(Array.prototype.slice.call(arguments));
        var transferables = args.__transferables__;
        if (transferables) delete args.__transferables__;
        return me._connection.emit(
          {
            type: "callback",
            index: index,
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
