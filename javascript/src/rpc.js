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

export const API_VERSION = "0.2.3";

const ArrayBufferView = Object.getPrototypeOf(
  Object.getPrototypeOf(new Uint8Array())
).constructor;

function _appendBuffer(buffer1, buffer2) {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
}

function indexObject(obj, is) {
  if (!is) throw new Error("undefined index");
  if (typeof is === "string") return indexObject(obj, is.split("."));
  else if (is.length === 0) return obj;
  else return indexObject(obj[is[0]], is.slice(1));
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
  constructor(connection, config, codecs) {
    super(config && config.debug);
    this._connection = connection;
    this.config = config || {};
    this._codecs = codecs || {};
    this._object_store = {};
    this._method_weakmap = new WeakMap();
    this._object_weakmap = new WeakMap();
    this._local_api = null;
    this._remote_set = false;
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

  setConfig(config) {
    if (config)
      for (const k of Object.keys(config)) {
        this.config[k] = config[k];
      }
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
    if (!this._remote_set) this._fire("interfaceAvailable");
    else this.send_interface();
    return new Promise(resolve => {
      this.once("interfaceSetAsRemote", resolve);
    });
  }

  /**
   * Sends the actual interface to the remote site upon it was
   * updated or by a special request of the remote site
   */
  sendInterface() {
    if (!this._local_api) {
      throw new Error("interface is not set.");
    }
    this._encode(this._local_api, true).then(api => {
      this._connection.emit({ type: "setInterface", api: api });
    });
  }

  _disposeObject(objectId) {
    if (this._object_store[objectId]) {
      delete this._object_store[objectId];
    } else {
      throw new Error(`Object (id=${objectId}) not found.`);
    }
  }

  disposeObject(obj) {
    return new Promise((resolve, reject) => {
      if (this._object_weakmap.has(obj)) {
        const objectId = this._object_weakmap.get(obj);
        this._connection.once("disposed", data => {
          if (data.error) reject(new Error(data.error));
          else resolve();
        });
        this._connection.emit({
          type: "disposeObject",
          object_id: objectId
        });
      } else {
        throw new Error("Invalid object");
      }
    });
  }

  /**
   * Handles a message from the remote site
   */
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
            error: String(e)
          });
        });
    });

    this._connection.on("method", async data => {
      let resolve, reject, method, method_this, args, result;
      try {
        if (data.promise) {
          [resolve, reject] = await this._unwrap(data.promise, false);
        }
        const _interface = this._object_store[data.object_id];
        method = indexObject(_interface, data.name);
        if (data.name.includes(".")) {
          const tmp = data.name.split(".");
          const intf_index = tmp.slice(0, tmp.length - 1).join(".");
          method_this = indexObject(_interface, intf_index);
        } else {
          method_this = _interface;
        }
        args = await this._unwrap(data.args, true);
        if (data.promise) {
          result = method.apply(method_this, args);
          if (
            result instanceof Promise ||
            (method.constructor && method.constructor.name === "AsyncFunction")
          ) {
            result.then(resolve).catch(reject);
          } else {
            resolve(result);
          }
        } else {
          method.apply(method_this, args);
        }
      } catch (err) {
        console.error(this.config.name, err);
        if (reject) {
          reject(err);
        }
      }
    });

    this._connection.on("callback", async data => {
      let resolve, reject, method, args, result;
      try {
        if (data.promise) {
          [resolve, reject] = await this._unwrap(data.promise, false);
        }
        if (data.promise) {
          method = this._store.fetch(data.id);
          args = await this._unwrap(data.args, true);
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
        } else {
          method = this._store.fetch(data.id);
          args = await this._unwrap(data.args, true);
          if (!method) {
            throw new Error(
              "Please notice that callback function can only called once, if you want to call a function for multiple times, please make it as a plugin api function. See https://imjoy.io/docs for more details."
            );
          }
          method.apply(null, args);
        }
      } catch (err) {
        console.error(this.config.name, err);
        if (reject) {
          reject(err);
        }
      }
    });
    this._connection.on("disposeObject", data => {
      try {
        this._disposeObject(data.object_id);
        this._connection.emit({
          type: "disposed"
        });
      } catch (e) {
        console.error(e);
        this._connection.emit({
          type: "disposed",
          error: String(e)
        });
      }
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
      this._remote_set = true;
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
    const _dtype = typedArrayToDtype(typedArray);
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
    this._decode(api).then(intf => {
      // update existing interface instead of recreating it
      if (this._remote_interface) {
        Object.assign(this._remote_interface, intf);
      } else this._remote_interface = intf;
      this._fire("remoteReady");
      this._reportRemoteSet();
    });
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
  _genRemoteMethod(targetId, name, objectId) {
    const me = this;
    const remoteMethod = function() {
      return new Promise(async (resolve, reject) => {
        let id = null;
        try {
          id = me._method_refs.put(objectId ? objectId + "/" + name : name);
          const wrapped_resolve = function() {
            if (id !== null) me._method_refs.fetch(id);
            return resolve.apply(this, arguments);
          };
          const wrapped_reject = function() {
            if (id !== null) me._method_refs.fetch(id);
            return reject.apply(this, arguments);
          };

          const encodedPromise = await me._wrap([
            wrapped_resolve,
            wrapped_reject
          ]);

          // store the key id for removing them from the reference store together
          wrapped_resolve.__promise_pair = encodedPromise[1]._rvalue;
          wrapped_reject.__promise_pair = encodedPromise[0]._rvalue;

          let args = Array.prototype.slice.call(arguments);
          if (
            name === "register" ||
            name === "registerService" ||
            name === "export" ||
            name === "on"
          ) {
            args = await me._wrap(args, true);
          } else {
            args = await me._wrap(args);
          }
          const transferables = args.__transferables__;
          if (transferables) delete args.__transferables__;
          me._connection.emit(
            {
              type: "method",
              target_id: targetId,
              name: name,
              object_id: objectId,
              args: args,
              promise: encodedPromise
            },
            transferables
          );
        } catch (e) {
          if (id) me._method_refs.fetch(id);
          reject(
            `Failed to exectue remote method (interface: ${objectId ||
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
  async _encode(aObject, asInterface, objectId) {
    const aType = typeof aObject;
    if (
      aType === "number" ||
      aType === "string" ||
      aType === "boolean" ||
      aObject === null ||
      aObject === undefined ||
      aObject instanceof ArrayBuffer
    ) {
      return aObject;
    }

    let bObject;
    if (typeof aObject === "function") {
      if (asInterface) {
        if (!objectId) throw new Error("objectId is not specified.");
        bObject = {
          _rtype: "interface",
          _rtarget_id: this._connection.peer_id,
          _rintf: objectId,
          _rvalue: asInterface
        };
        this._method_weakmap.set(aObject, bObject);
      } else if (this._method_weakmap.has(aObject)) {
        bObject = this._method_weakmap.get(aObject);
      } else {
        const cid = this._store.put(aObject);
        bObject = {
          _rtype: "callback",
          _rtarget_id: this._connection.peer_id,
          _rname: (aObject.constructor && aObject.constructor.name) || cid,
          _rvalue: cid
        };
      }
      return bObject;
    }

    // skip if already encoded
    if (aObject.constructor instanceof Object && aObject._rtype) {
      // make sure the interface functions are encoded
      if (aObject._rintf) {
        const temp = aObject._rtype;
        delete aObject._rtype;

        bObject = await this._encode(aObject, asInterface, objectId);
        bObject._rtype = temp;
      } else {
        bObject = aObject;
      }
      return bObject;
    }

    const transferables = [];
    const _transfer = aObject._transfer;
    const isarray = Array.isArray(aObject);

    for (let tp of Object.keys(this._codecs)) {
      const codec = this._codecs[tp];
      if (codec.encoder && aObject instanceof codec.type) {
        // TODO: what if multiple encoders found
        let encodedObj = await Promise.resolve(codec.encoder(aObject));
        if (encodedObj && !encodedObj._rtype) encodedObj._rtype = codec.name;
        // encode the functions in the interface object
        if (encodedObj && encodedObj._rintf) {
          const temp = encodedObj._rtype;
          delete encodedObj._rtype;
          encodedObj = await this._encode(encodedObj, asInterface, objectId);
          encodedObj._rtype = temp;
        }
        bObject = encodedObj;
        return bObject;
      }
    }

    if (
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
      const dtype = typedArrayToDtype(aObject.selection.data);
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
      aObject instanceof ImageData ||
      (typeof FileList !== "undefined" && aObject instanceof FileList) ||
      (typeof FileSystemDirectoryHandle !== "undefined" &&
        aObject instanceof FileSystemDirectoryHandle) ||
      (typeof FileSystemFileHandle !== "undefined" &&
        aObject instanceof FileSystemFileHandle) ||
      (typeof FileSystemHandle !== "undefined" &&
        aObject instanceof FileSystemHandle) ||
      (typeof FileSystemWritableFileStream !== "undefined" &&
        aObject instanceof FileSystemWritableFileStream)
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
    } else if (aObject instanceof ArrayBufferView) {
      if (aObject._transfer || _transfer) {
        transferables.push(aObject.buffer);
        delete aObject._transfer;
      }
      const dtype = typedArrayToDtype(aObject);
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
        _rvalue: await this._encode(Array.from(aObject), asInterface)
      };
    } else if (aObject instanceof Map) {
      bObject = {
        _rtype: "orderedmap",
        _rvalue: await this._encode(Array.from(aObject), asInterface)
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
        asInterface = true;
      } else {
        throw Error("Unsupported interface type");
      }

      let hasFunction = false;
      // encode interfaces
      if (aObject._rintf || asInterface) {
        if (!objectId) {
          objectId = randId();
          this._object_store[objectId] = aObject;
        }
        for (let k of keys) {
          if (k === "constructor") continue;
          if (k.startsWith("_")) {
            continue;
          }
          bObject[k] = await this._encode(
            aObject[k],
            typeof asInterface === "string" ? asInterface + "." + k : k,
            objectId
          );
          if (typeof aObject[k] === "function") {
            hasFunction = true;
          }
        }
        // object id for dispose the object remotely
        if (hasFunction) bObject._rintf = objectId;
        // remove interface when closed
        if (aObject.on && typeof aObject.on === "function") {
          aObject.on("close", () => {
            delete this._object_store[objectId];
          });
        }
      } else {
        for (let k of keys) {
          if (["hasOwnProperty", "constructor"].includes(k)) continue;
          bObject[k] = await this._encode(aObject[k]);
        }
      }
      // for example, browserFS object
    } else if (typeof aObject === "object") {
      const keys = Object.getOwnPropertyNames(
        Object.getPrototypeOf(aObject)
      ).concat(Object.keys(aObject));
      const objectId = randId();

      for (let k of keys) {
        if (["hasOwnProperty", "constructor"].includes(k)) continue;
        // encode as interface
        bObject[k] = await this._encode(aObject[k], k, bObject);
      }
      // object id, used for dispose the object
      bObject._rintf = objectId;
    } else {
      throw "imjoy-rpc: Unsupported data type:" + aObject;
    }

    if (transferables.length > 0) {
      bObject.__transferables__ = transferables;
    }
    if (!bObject) {
      throw new Error("Failed to encode object");
    }
    return bObject;
  }

  async _decode(aObject, withPromise) {
    if (!aObject) {
      return aObject;
    }
    let bObject;
    if (aObject["_rtype"]) {
      if (
        this._codecs[aObject._rtype] &&
        this._codecs[aObject._rtype].decoder
      ) {
        if (aObject._rintf) {
          const temp = aObject._rtype;
          delete aObject._rtype;
          aObject = await this._decode(aObject, withPromise);
          aObject._rtype = temp;
        }
        bObject = await Promise.resolve(
          this._codecs[aObject._rtype].decoder(aObject)
        );
      } else if (aObject._rtype === "callback") {
        bObject = this._genRemoteCallback(
          aObject._rtarget_id,
          aObject._rvalue,
          withPromise
        );
      } else if (aObject._rtype === "interface") {
        bObject = this._genRemoteMethod(
          aObject._rtarget_id,
          aObject._rvalue,
          aObject._rintf
        );
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
          const arraytype = dtypeToTypedArray[aObject._rdtype];
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
      } else if (aObject._rtype === "typedarray") {
        const arraytype = dtypeToTypedArray[aObject._rdtype];
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
        bObject = new Map(await this._decode(aObject._rvalue, withPromise));
      } else if (aObject._rtype === "set") {
        bObject = new Set(await this._decode(aObject._rvalue, withPromise));
      } else {
        // make sure all the interface functions are decoded
        if (aObject._rintf) {
          const temp = aObject._rtype;
          delete aObject._rtype;
          bObject = await this._decode(aObject, withPromise);
          bObject._rtype = temp;
        } else bObject = aObject;
      }
    } else if (aObject.constructor === Object || Array.isArray(aObject)) {
      const isarray = Array.isArray(aObject);
      bObject = isarray ? [] : {};
      for (let k of Object.keys(aObject)) {
        if (isarray || aObject.hasOwnProperty(k)) {
          const v = aObject[k];
          bObject[k] = await this._decode(v, withPromise);
        }
      }
    } else {
      bObject = aObject;
    }
    if (bObject === undefined) {
      throw new Error("Failed to decode object");
    }
    // store the object id for dispose
    if (aObject._rintf) {
      this._object_weakmap.set(bObject, aObject._rintf);
    }
    return bObject;
  }

  async _wrap(args, asInterface) {
    return await this._encode(args, asInterface);
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
  async _unwrap(args, withPromise) {
    return await this._decode(args, withPromise);
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
  _genRemoteCallback(targetId, cid, withPromise) {
    const me = this;
    let remoteCallback;
    if (withPromise) {
      remoteCallback = function() {
        return new Promise(async (resolve, reject) => {
          const args = await me._wrap(Array.prototype.slice.call(arguments));
          const transferables = args.__transferables__;
          if (transferables) delete args.__transferables__;

          const encodedPromise = await me._wrap([resolve, reject]);
          // store the key id for removing them from the reference store together
          resolve.__promise_pair = encodedPromise[1]._rvalue;
          reject.__promise_pair = encodedPromise[0]._rvalue;
          try {
            me._connection.emit(
              {
                type: "callback",
                target_id: targetId,
                id: cid,
                args: args,
                promise: encodedPromise
              },
              transferables
            );
          } catch (e) {
            reject(`Failed to exectue remote callback ( id: ${cid}).`);
          }
        });
      };
      return remoteCallback;
    } else {
      remoteCallback = async function() {
        const args = await me._wrap(Array.prototype.slice.call(arguments));
        const transferables = args.__transferables__;
        if (transferables) delete args.__transferables__;
        return me._connection.emit(
          {
            type: "callback",
            target_id: targetId,
            id: cid,
            args: args
          },
          transferables
        );
      };
      return remoteCallback;
    }
  }

  reset() {
    this._event_handlers = {};
    this._once_handlers = {};
    this._remote_interface = null;
    this._object_store = {};
    this._method_weakmap = new WeakMap();
    this._object_weakmap = new WeakMap();
    this._local_api = null;
    this._store = new ReferenceStore();
    this._method_refs = new ReferenceStore();
  }

  /**
   * Sends the notification message and breaks the connection
   */
  disconnect() {
    this._connection.emit({ type: "disconnect" });
    this.reset();
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
    let id;
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
    for (let i = 0; i < this._indices.length; i++) {
      if (id < this._indices[i]) {
        this._indices.splice(i, 0, id);
        break;
      }
    }

    // cleaning-up the sequence tail
    for (let i = this._indices.length - 1; i >= 0; i--) {
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
    const id = this._genId();
    this._store[id] = obj;
    return id;
  }

  /**
   * Retrieves previously stored object and releases its reference
   *
   * @param {Number} id of an object to retrieve
   */
  fetch(id) {
    const obj = this._store[id];
    if (obj && !obj.__remote_method) {
      delete this._store[id];
      this._releaseId(id);
      if (this._readyHandler && Object.keys(this._store).length === 0) {
        this._readyHandler();
      }
    }
    if (obj && obj.__promise_pair) {
      this.fetch(obj.__promise_pair);
    }
    return obj;
  }
}
