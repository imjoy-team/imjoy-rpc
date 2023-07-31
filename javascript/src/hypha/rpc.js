/**
 * Contains the RPC object used both by the application
 * site, and by each plugin
 */
import {
  randId,
  typedArrayToDtype,
  dtypeToTypedArray,
  MessageEmitter,
  assert,
  waitFor
} from "./utils.js";

import { encode as msgpack_packb, decodeMulti } from "@msgpack/msgpack";

export const API_VERSION = "0.3.0";
const CHUNK_SIZE = 1024 * 500;

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
function getFunctionInfo(func) {
  const funcString = func.toString();

  // Extract function name
  const nameMatch = funcString.match(/function\s*(\w*)/);
  const name = (nameMatch && nameMatch[1]) || "";

  // Extract function parameters, excluding comments
  const paramsMatch = funcString.match(/\(([^)]*)\)/);
  let params = "";
  if (paramsMatch) {
    params = paramsMatch[1]
      .split(",")
      .map(p =>
        p
          .replace(/\/\*.*?\*\//g, "") // Remove block comments
          .replace(/\/\/.*$/g, "")
      ) // Remove line comments
      .filter(p => p.trim().length > 0) // Remove empty strings after removing comments
      .map(p => p.trim()) // Trim remaining whitespace
      .join(", ");
  }

  // Extract function docstring (block comment)
  let docMatch = funcString.match(/\)\s*\{\s*\/\*([\s\S]*?)\*\//);
  const docstringBlock = (docMatch && docMatch[1].trim()) || "";

  // Extract function docstring (line comment)
  docMatch = funcString.match(/\)\s*\{\s*(\/\/[\s\S]*?)\n\s*[^\s\/]/);
  const docstringLine =
    (docMatch &&
      docMatch[1]
        .split("\n")
        .map(s => s.replace(/^\/\/\s*/, "").trim())
        .join("\n")) ||
    "";

  const docstring = docstringBlock || docstringLine;
  return (
    name &&
    params.length > 0 && {
      name: name,
      sig: params,
      doc: docstring
    }
  );
}

function concatArrayBuffers(buffers) {
  var buffersLengths = buffers.map(function(b) {
      return b.byteLength;
    }),
    totalBufferlength = buffersLengths.reduce(function(p, c) {
      return p + c;
    }, 0),
    unit8Arr = new Uint8Array(totalBufferlength);
  buffersLengths.reduce(function(p, c, i) {
    unit8Arr.set(new Uint8Array(buffers[i]), p);
    return p + c;
  }, 0);
  return unit8Arr.buffer;
}

class Timer {
  constructor(timeout, callback, args, label) {
    this._timeout = timeout;
    this._callback = callback;
    this._args = args;
    this._label = label || "timer";
    this._task = null;
    this.started = false;
  }

  start() {
    if (this.started) {
      this.reset();
    } else {
      this._task = setTimeout(() => {
        this._callback.apply(this, this._args);
      }, this._timeout * 1000);
      this.started = true;
    }
  }

  clear() {
    if (this._task) {
      clearTimeout(this._task);
      this._task = null;
      this.started = false;
    } else {
      console.warn(`Clearing a timer (${this._label}) which is not started`);
    }
  }

  reset() {
    if (this._task) {
      clearTimeout(this._task);
    }
    this._task = setTimeout(() => {
      this._callback.apply(this, this._args);
    }, this._timeout * 1000);
    this.started = true;
  }
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
  constructor(
    connection,
    {
      client_id = null,
      manager_id = null,
      default_context = null,
      name = null,
      codecs = null,
      method_timeout = null,
      max_message_buffer_size = 0,
      debug = false,
      workspace = null
    }
  ) {
    super(debug);
    this._codecs = codecs || {};
    assert(client_id && typeof client_id === "string");
    assert(client_id, "client_id is required");
    this._client_id = client_id;
    this._name = name;
    this._connection_info = null;
    this._workspace = null;
    this._local_workspace = workspace;
    this.manager_id = manager_id;
    this.default_context = default_context || {};
    this._method_annotations = new WeakMap();
    this._manager_service = null;
    this._max_message_buffer_size = max_message_buffer_size;
    this._chunk_store = {};
    this._method_timeout = method_timeout || 30;

    // make sure there is an execute function
    this._services = {};
    this._object_store = {
      services: this._services
    };

    if (connection) {
      this.add_service({
        id: "built-in",
        type: "built-in",
        name: "RPC built-in services",
        config: { require_context: true, visibility: "public" },
        ping: this._ping.bind(this),
        get_service: this.get_local_service.bind(this),
        register_service: this.register_service.bind(this),
        message_cache: {
          create: this._create_message.bind(this),
          append: this._append_message.bind(this),
          process: this._process_message.bind(this),
          remove: this._remove_message.bind(this)
        }
      });
      this.on("method", this._handle_method.bind(this));

      assert(connection.emit_message && connection.on_message);
      this._emit_message = connection.emit_message.bind(connection);
      connection.on_message(this._on_message.bind(this));
      this._connection = connection;
      // Update the server and obtain client info
      this._get_connection_info();
    } else {
      this._emit_message = function() {
        console.log("No connection to emit message");
      };
    }
  }

  async _get_connection_info() {
    if (this.manager_id) {
      // try to get the root service
      try {
        await this.get_manager_service(30.0);
        assert(this._manager_service);
        this._connection_info = await this._manager_service.get_connection_info();
        if (
          this._connection_info.reconnection_token &&
          this._connection.set_reconnection_token
        ) {
          this._connection.set_reconnection_token(
            this._connection_info.reconnection_token
          );
          const reconnection_expires_in =
            this._connection_info.reconnection_expires_in * 0.8;
          // console.info(
          //   `Reconnection token obtained: ${this._connection_info.reconnection_token}, will be refreshed in ${reconnection_expires_in} seconds`
          // );
          this._get_connection_info_task = setTimeout(
            this._get_connection_info.bind(this),
            reconnection_expires_in * 1000
          );
        }
      } catch (exp) {
        console.warn("Failed to fetch user info from ", this.manager_id, exp);
      }
    }
  }

  register_codec(config) {
    if (!config["name"] || (!config["encoder"] && !config["decoder"])) {
      throw new Error(
        "Invalid codec format, please make sure you provide a name, type, encoder and decoder."
      );
    } else {
      if (config.type) {
        for (let k of Object.keys(this._codecs)) {
          if (this._codecs[k].type === config.type || k === config.name) {
            delete this._codecs[k];
            console.warn("Remove duplicated codec: " + k);
          }
        }
      }
      this._codecs[config["name"]] = config;
    }
  }

  async _ping(msg, context) {
    assert(msg == "ping");
    return "pong";
  }

  async ping(client_id, timeout) {
    let method = this._generate_remote_method({
      _rtarget: client_id,
      _rmethod: "services.built-in.ping",
      _rpromise: true,
      _rdoc: "Ping a remote client",
      _rsig: "ping(msg)"
    });
    assert((await method("ping", timeout)) == "pong");
  }

  _create_message(key, heartbeat, overwrite, context) {
    if (heartbeat) {
      if (!this._object_store[key]) {
        throw new Error(`session does not exist anymore: ${key}`);
      }
      this._object_store[key]["timer"].reset();
    }

    if (!this._object_store["message_cache"]) {
      this._object_store["message_cache"] = {};
    }
    if (!overwrite && this._object_store["message_cache"][key]) {
      throw new Error(
        `Message with the same key (${key}) already exists in the cache store, please use overwrite=true or remove it first.`
      );
    }

    this._object_store["message_cache"][key] = [];
  }

  _append_message(key, data, heartbeat, context) {
    if (heartbeat) {
      if (!this._object_store[key]) {
        throw new Error(`session does not exist anymore: ${key}`);
      }
      this._object_store[key]["timer"].reset();
    }
    const cache = this._object_store["message_cache"];
    if (!cache[key]) {
      throw new Error(`Message with key ${key} does not exists.`);
    }
    assert(data instanceof ArrayBufferView);
    cache[key].push(data);
  }

  _remove_message(key, context) {
    const cache = this._object_store["message_cache"];
    if (!cache[key]) {
      throw new Error(`Message with key ${key} does not exists.`);
    }
    delete cache[key];
  }

  _process_message(key, heartbeat, context) {
    if (heartbeat) {
      if (!this._object_store[key]) {
        throw new Error(`session does not exist anymore: ${key}`);
      }
      this._object_store[key]["timer"].reset();
    }
    const cache = this._object_store["message_cache"];
    assert(!!context, "Context is required");
    if (!cache[key]) {
      throw new Error(`Message with key ${key} does not exists.`);
    }
    cache[key] = concatArrayBuffers(cache[key]);
    console.debug(`Processing message ${key} (size=${cache[key].length})`);
    let unpacker = decodeMulti(cache[key]);
    const { done, value } = unpacker.next();
    const main = value;
    // Make sure the fields are from trusted source
    Object.assign(main, {
      from: context.from,
      to: context.to,
      user: context.user
    });
    main["ctx"] = JSON.parse(JSON.stringify(main));
    Object.assign(main["ctx"], this.default_context);
    if (!done) {
      let extra = unpacker.next();
      Object.assign(main, extra.value);
    }
    this._fire(main["type"], main);
    delete cache[key];
  }

  _on_message(message) {
    try {
      assert(message instanceof ArrayBuffer);
      let unpacker = decodeMulti(message);
      const { done, value } = unpacker.next();
      const main = value;
      // Add trusted context to the method call
      main["ctx"] = JSON.parse(JSON.stringify(main));
      Object.assign(main["ctx"], this.default_context);
      if (!done) {
        let extra = unpacker.next();
        Object.assign(main, extra.value);
      }
      this._fire(main["type"], main);
    } catch (error) {
      console.error(e);
    }
  }

  reset() {
    this._event_handlers = {};
    this._services = {};
  }

  async disconnect() {
    if (this._get_connection_info_task) {
      clearTimeout(this._get_connection_info_task);
      this._get_connection_info_task = null;
    }
    this._fire("disconnect");
  }

  async get_manager_service(timeout) {
    if (this.manager_id && !this._manager_service) {
      this._manager_service = await this.get_remote_service(
        `${this.manager_id}:default`,
        timeout
      );
    }
  }

  get_all_local_services() {
    return this._services;
  }
  get_local_service(service_id, context) {
    assert(service_id);
    const [ws, client_id] = context["to"].split("/");
    assert(
      client_id === this._client_id,
      "Services can only be accessed locally"
    );

    const service = this._services[service_id];
    if (!service) {
      throw new Error("Service not found: " + service_id);
    }

    // allow access for the same workspace
    if (service.config.visibility == "public") {
      return service;
    }

    // allow access for the same workspace
    if (context["from"].startsWith(ws + "/")) {
      return service;
    }

    throw new Error("Permission denied for service: " + service_id);
  }
  async get_remote_service(service_uri, timeout) {
    timeout = timeout === undefined ? this._method_timeout : timeout;
    if (!service_uri && this.manager_id) {
      service_uri = this.manager_id;
    } else if (!service_uri.includes(":")) {
      service_uri = this._client_id + ":" + service_uri;
    }
    const provider = service_uri.split(":")[0];
    assert(provider);
    try {
      const method = this._generate_remote_method({
        _rtarget: provider,
        _rmethod: "services.built-in.get_service",
        _rpromise: true,
        _rdoc: "Get a remote service",
        _rsig: "get_service(service_id)"
      });
      const svc = await waitFor(
        method(service_uri.split(":")[1]),
        timeout,
        "Timeout Error: Failed to get remote service: " + service_uri
      );
      svc.id = service_uri;
      return svc;
    } catch (e) {
      console.error("Failed to get remote service: " + service_uri, e);
      throw e;
    }
  }
  _annotate_service_methods(
    aObject,
    object_id,
    require_context,
    run_in_executor,
    visibility
  ) {
    if (typeof aObject === "function") {
      // mark the method as a remote method that requires context
      let method_name = object_id.split(".")[1];
      this._method_annotations.set(aObject, {
        require_context: Array.isArray(require_context)
          ? require_context.includes(method_name)
          : !!require_context,
        run_in_executor: run_in_executor,
        method_id: "services." + object_id,
        visibility: visibility
      });
    } else if (aObject instanceof Array || aObject instanceof Object) {
      for (let key of Object.keys(aObject)) {
        let val = aObject[key];
        if (typeof val === "function" && val.__rpc_object__) {
          let client_id = val.__rpc_object__._rtarget;
          if (client_id.includes("/")) {
            client_id = client_id.split("/")[1];
          }
          if (this._client_id === client_id) {
            if (aObject instanceof Array) {
              aObject = aObject.slice();
            }
            // recover local method
            aObject[key] = indexObject(
              this._object_store,
              val.__rpc_object__._rmethod
            );
            val = aObject[key]; // make sure it's annotated later
          } else {
            throw new Error(
              `Local method not found: ${val.__rpc_object__._rmethod}, client id mismatch ${this._client_id} != ${client_id}`
            );
          }
        }
        this._annotate_service_methods(
          val,
          object_id + "." + key,
          require_context,
          run_in_executor,
          visibility
        );
      }
    }
  }
  add_service(api, overwrite) {
    if (!api || Array.isArray(api)) throw new Error("Invalid service object");
    if (api.constructor === Object) {
      api = Object.assign({}, api);
    } else {
      const normApi = {};
      const props = Object.getOwnPropertyNames(api).concat(
        Object.getOwnPropertyNames(Object.getPrototypeOf(api))
      );
      for (let k of props) {
        if (k !== "constructor") {
          if (typeof api[k] === "function") normApi[k] = api[k].bind(api);
          else normApi[k] = api[k];
        }
      }
      // For class instance, we need set a default id
      api.id = api.id || "default";
      api = normApi;
    }
    assert(
      api.id && typeof api.id === "string",
      `Service id not found: ${api}`
    );
    if (!api.name) {
      api.name = api.id;
    }
    if (!api.config) {
      api.config = {};
    }
    if (!api.type) {
      api.type = "generic";
    }
    // require_context only applies to the top-level functions
    let require_context = false,
      run_in_executor = false;
    if (api.config.require_context)
      require_context = api.config.require_context;
    if (api.config.run_in_executor) run_in_executor = true;
    const visibility = api.config.visibility || "protected";
    assert(["protected", "public"].includes(visibility));
    this._annotate_service_methods(
      api,
      api["id"],
      require_context,
      run_in_executor,
      visibility
    );

    if (this._services[api.id]) {
      if (overwrite) {
        delete this._services[api.id];
      } else {
        throw new Error(
          `Service already exists: ${api.id}, please specify a different id (not ${api.id}) or overwrite=true`
        );
      }
    }
    this._services[api.id] = api;
    return api;
  }

  async register_service(api, overwrite, notify, context) {
    if (notify === undefined) notify = true;
    if (context) {
      // If this function is called from remote, we need to make sure
      const [workspace, client_id] = context["to"].split("/");
      assert(client_id === this._client_id);
      assert(
        workspace === context["from"].split("/")[0],
        "Services can only be registered from the same workspace"
      );
    }
    const service = this.add_service(api, overwrite);
    if (notify) {
      this._fire("service-updated", {
        service_id: service["id"],
        api: service,
        type: "add"
      });
      await this._notify_service_update();
    }
    return {
      id: `${this._client_id}:${service["id"]}`,
      type: service["type"],
      name: service["name"],
      description: service["description"] || "",
      config: service["config"]
    };
  }
  async unregister_service(service, notify) {
    if (service instanceof Object) {
      service = service.id;
    }
    if (!this._services[service]) {
      throw new Error(`Service not found: ${service}`);
    }
    const api = this._services[service];
    delete this._services[service];
    this._fire("service-updated", {
      service_id: service,
      api: api,
      type: "remove"
    });
    await this._notify_service_update();
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

  _encode_callback(
    name,
    callback,
    session_id,
    clear_after_called,
    timer,
    local_workspace
  ) {
    let method_id = `${session_id}.${name}`;
    let encoded = {
      _rtype: "method",
      _rtarget: local_workspace
        ? `${local_workspace}/${this._client_id}`
        : this._client_id,
      _rmethod: method_id,
      _rpromise: false
    };

    const self = this;
    let wrapped_callback = function() {
      try {
        callback.apply(null, Array.prototype.slice.call(arguments));
      } catch (error) {
        console.error("Error in callback:", method_id, error);
      } finally {
        if (clear_after_called && self._object_store[session_id]) {
          // console.log("Deleting session", session_id, "from", self._client_id);
          delete self._object_store[session_id];
        }
        if (timer && timer.started) {
          timer.clear();
        }
      }
    };

    return [encoded, wrapped_callback];
  }

  async _encode_promise(
    resolve,
    reject,
    session_id,
    clear_after_called,
    timer,
    local_workspace
  ) {
    let store = this._get_session_store(session_id, true);
    assert(
      store,
      `Failed to create session store ${session_id} due to invalid parent`
    );
    let encoded = {};

    if (timer && reject && this._method_timeout) {
      encoded.heartbeat = await this._encode(
        timer.reset.bind(timer),
        session_id,
        local_workspace
      );
      encoded.interval = this._method_timeout / 2;
      store.timer = timer;
    } else {
      timer = null;
    }

    [encoded.resolve, store.resolve] = this._encode_callback(
      "resolve",
      resolve,
      session_id,
      clear_after_called,
      timer,
      local_workspace
    );
    [encoded.reject, store.reject] = this._encode_callback(
      "reject",
      reject,
      session_id,
      clear_after_called,
      timer,
      local_workspace
    );
    return encoded;
  }

  async _send_chunks(data, target_id, session_id) {
    let remote_services = await this.get_remote_service(
      `${target_id}:built-in`
    );
    assert(
      remote_services.message_cache,
      "Remote client does not support message caching for long message."
    );
    let message_cache = remote_services.message_cache;
    let message_id = session_id || randId();
    await message_cache.create(message_id, !!session_id);
    let total_size = data.length;
    let chunk_num = Math.ceil(total_size / CHUNK_SIZE);
    for (let idx = 0; idx < chunk_num; idx++) {
      let start_byte = idx * CHUNK_SIZE;
      await message_cache.append(
        message_id,
        data.slice(start_byte, start_byte + CHUNK_SIZE),
        !!session_id
      );
      // console.log(
      //   `Sending chunk ${idx + 1}/${chunk_num} (${total_size} bytes)`
      // );
    }
    // console.log(`All chunks sent (${chunk_num})`);
    await message_cache.process(message_id, !!session_id);
  }

  _generate_remote_method(
    encoded_method,
    remote_parent,
    local_parent,
    remote_workspace,
    local_workspace
  ) {
    let target_id = encoded_method._rtarget;
    if (remote_workspace && !target_id.includes("/")) {
      target_id = remote_workspace + "/" + target_id;
      // Fix the target id to be an absolute id
      encoded_method._rtarget = target_id;
    }
    let method_id = encoded_method._rmethod;
    let with_promise = encoded_method._rpromise;
    const self = this;

    function remote_method() {
      return new Promise(async (resolve, reject) => {
        let local_session_id = randId();
        if (local_parent) {
          // Store the children session under the parent
          local_session_id = local_parent + "." + local_session_id;
        }
        let store = self._get_session_store(local_session_id, true);
        if (!store) {
          reject(
            new Error(
              `Runtime Error: Failed to get session store ${local_session_id}`
            )
          );
          return;
        }
        store["target_id"] = target_id;
        const args = await self._encode(
          Array.prototype.slice.call(arguments),
          local_session_id,
          local_workspace
        );
        const argLength = args.length;
        // if the last argument is an object, mark it as kwargs
        const withKwargs =
          argLength > 0 &&
          typeof args[argLength - 1] === "object" &&
          args[argLength - 1] !== null &&
          args[argLength - 1]._rkwargs;
        if (withKwargs) delete args[argLength - 1]._rkwargs;
        let main_message = {
          type: "method",
          from: self._local_workspace
            ? self._local_workspace + "/" + self._client_id
            : self._client_id,
          to: target_id,
          method: method_id
        };
        let extra_data = {};
        if (args) {
          extra_data["args"] = args;
        }
        if (withKwargs) {
          extra_data["with_kwargs"] = withKwargs;
        }

        // console.log(
        //   `Calling remote method ${target_id}:${method_id}, session: ${local_session_id}`
        // );
        if (remote_parent) {
          // Set the parent session
          // Note: It's a session id for the remote, not the current client
          main_message["parent"] = remote_parent;
        }

        let timer = null;
        if (with_promise) {
          // Only pass the current session id to the remote
          // if we want to received the result
          // I.e. the session id won't be passed for promises themselves
          main_message["session"] = local_session_id;
          let method_name = `${target_id}:${method_id}`;
          timer = new Timer(
            self._method_timeout,
            reject,
            [`Method call time out: ${method_name}`],
            method_name
          );
          extra_data["promise"] = await self._encode_promise(
            resolve,
            reject,
            local_session_id,
            true,
            timer,
            local_workspace
          );
        }
        // The message consists of two segments, the main message and extra data
        let message_package = msgpack_packb(main_message);
        if (extra_data) {
          const extra = msgpack_packb(extra_data);
          message_package = new Uint8Array([...message_package, ...extra]);
        }
        let total_size = message_package.length;
        if (total_size <= CHUNK_SIZE + 1024) {
          self._emit_message(message_package).then(function() {
            if (timer) {
              // console.log(`Start watchdog timer.`);
              // Only start the timer after we send the message successfully
              timer.start();
            }
          });
        } else {
          // send chunk by chunk
          self
            ._send_chunks(message_package, target_id, remote_parent)
            .then(function() {
              if (timer) {
                // console.log(`Start watchdog timer.`);
                // Only start the timer after we send the message successfully
                timer.start();
              }
            });
        }
      });
    }

    // Generate debugging information for the method
    remote_method.__rpc_object__ = encoded_method;
    const parts = method_id.split(".");
    remote_method.__name__ = parts[parts.length - 1];
    remote_method.__doc__ = encoded_method._rdoc;
    remote_method.__sig__ = encoded_method._rsig;
    return remote_method;
  }

  async _notify_service_update() {
    if (this.manager_id) {
      // try to get the root service
      try {
        await this.get_manager_service(30.0);
        assert(this._manager_service);
        await this._manager_service.update_client_info(this.get_client_info());
      } catch (exp) {
        // pylint: disable=broad-except
        console.warn(
          "Failed to notify service update to",
          this.manager_id,
          exp
        );
      }
    }
  }

  get_client_info() {
    const services = [];
    for (let service of Object.values(this._services)) {
      services.push({
        id: `${this._client_id}:${service["id"]}`,
        type: service["type"],
        name: service["name"],
        description: service["description"] || "",
        config: service["config"]
      });
    }

    return {
      id: this._client_id,
      services: services
    };
  }

  async _handle_method(data) {
    let reject = null;
    let heartbeat_task = null;
    try {
      assert(data["method"] && data["ctx"] && data["from"]);
      const method_name = data.from + ":" + data.method;
      const remote_workspace = data.from.split("/")[0];
      // Make sure the target id is an absolute id
      data["to"] = data["to"].includes("/")
        ? data["to"]
        : remote_workspace + "/" + data["to"];
      data["ctx"]["to"] = data["to"];
      const local_workspace = data.to.split("/")[0];
      const local_parent = data.parent;

      let resolve, reject;
      if (data.promise) {
        // Decode the promise with the remote session id
        // Such that the session id will be passed to the remote as a parent session id
        const promise = await this._decode(
          data.promise,
          data.session,
          local_parent,
          remote_workspace,
          local_workspace
        );
        resolve = promise.resolve;
        reject = promise.reject;
        if (promise.heartbeat && promise.interval) {
          async function heartbeat() {
            try {
              // console.log("Reset heartbeat timer: " + data.method);
              await promise.heartbeat();
            } catch (err) {
              console.error(err);
            }
          }
          heartbeat_task = setInterval(heartbeat, promise.interval * 1000);
        }
      }

      let method;

      try {
        method = indexObject(this._object_store, data["method"]);
      } catch (e) {
        console.debug("Failed to find method", method_name, e);
        throw new Error(`Method not found: ${method_name}`);
      }

      assert(
        method && typeof method === "function",
        "Invalid method: " + method_name
      );

      // Check permission
      if (this._method_annotations.has(method)) {
        // For services, it should not be protected
        if (this._method_annotations.get(method).visibility === "protected") {
          if (local_workspace !== remote_workspace) {
            throw new Error(
              "Permission denied for protected method " +
                method_name +
                ", workspace mismatch: " +
                local_workspace +
                " != " +
                remote_workspace
            );
          }
        }
      } else {
        // For sessions, the target_id should match exactly
        let session_target_id = this._object_store[data.method.split(".")[0]]
          .target_id;
        if (
          local_workspace === remote_workspace &&
          session_target_id &&
          session_target_id.indexOf("/") === -1
        ) {
          session_target_id = local_workspace + "/" + session_target_id;
        }
        if (session_target_id !== data.from) {
          throw new Error(
            "Access denied for method call (" +
              method_name +
              ") from " +
              data.from
          );
        }
      }

      // Make sure the parent session is still open
      if (local_parent) {
        // The parent session should be a session that generate the current method call
        assert(
          this._get_session_store(local_parent, true) !== null,
          "Parent session was closed: " + local_parent
        );
      }
      let args;
      if (data.args) {
        args = await this._decode(
          data.args,
          data.session,
          null,
          remote_workspace,
          null
        );
      } else {
        args = [];
      }
      if (
        this._method_annotations.has(method) &&
        this._method_annotations.get(method).require_context
      ) {
        args.push(data.ctx);
      }
      // console.log("Executing method: " + method_name);
      if (data.promise) {
        const result = method.apply(null, args);
        if (result instanceof Promise) {
          result
            .then(result => {
              resolve(result);
              clearInterval(heartbeat_task);
            })
            .catch(err => {
              reject(err);
              clearInterval(heartbeat_task);
            });
        } else {
          resolve(result);
          clearInterval(heartbeat_task);
        }
      } else {
        method.apply(null, args);
        clearInterval(heartbeat_task);
      }
    } catch (err) {
      if (reject) {
        reject(err);
        console.debug("Error during calling method: ", err);
      } else {
        console.error("Error during calling method: ", err);
      }
      // make sure we clear the heartbeat timer
      clearInterval(heartbeat_task);
    }
  }

  encode(aObject, session_id) {
    return this._encode(aObject, session_id);
  }

  _get_session_store(session_id, create) {
    let store = this._object_store;
    const levels = session_id.split(".");
    if (create) {
      const last_index = levels.length - 1;
      for (let level of levels.slice(0, last_index)) {
        if (!store[level]) {
          return null;
        }
        store = store[level];
      }
      // Create the last level
      if (!store[levels[last_index]]) {
        store[levels[last_index]] = {};
      }
      return store[levels[last_index]];
    } else {
      for (let level of levels) {
        if (!store[level]) {
          return null;
        }
        store = store[level];
      }
      return store;
    }
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
  async _encode(aObject, session_id, local_workspace) {
    const aType = typeof aObject;
    if (
      aType === "number" ||
      aType === "string" ||
      aType === "boolean" ||
      aObject === null ||
      aObject === undefined ||
      aObject instanceof Uint8Array
    ) {
      return aObject;
    }
    if (aObject instanceof ArrayBuffer) {
      return {
        _rtype: "memoryview",
        _rvalue: new Uint8Array(aObject)
      };
    }
    // Reuse the remote object
    if (aObject.__rpc_object__) {
      return aObject.__rpc_object__;
    }

    let bObject;

    // skip if already encoded
    if (aObject.constructor instanceof Object && aObject._rtype) {
      // make sure the interface functions are encoded
      const temp = aObject._rtype;
      delete aObject._rtype;
      bObject = await this._encode(aObject, session_id, local_workspace);
      bObject._rtype = temp;
      return bObject;
    }

    if (typeof aObject === "function") {
      if (this._method_annotations.has(aObject)) {
        let annotation = this._method_annotations.get(aObject);
        bObject = {
          _rtype: "method",
          _rtarget: this._client_id,
          _rmethod: annotation.method_id,
          _rpromise: true
        };
      } else {
        assert(typeof session_id === "string");
        let object_id;
        if (aObject.__name__) {
          object_id = `${randId()}-${aObject.__name__}`;
        } else {
          object_id = randId();
        }
        bObject = {
          _rtype: "method",
          _rtarget: this._client_id,
          _rmethod: `${session_id}.${object_id}`,
          _rpromise: true
        };
        let store = this._get_session_store(session_id, true);
        assert(
          store !== null,
          `Failed to create session store ${session_id} due to invalid parent`
        );
        store[object_id] = aObject;
      }
      bObject._rdoc = aObject.__doc__;
      bObject._rsig = aObject.__sig__;
      if (!bObject._rdoc || !bObject._rsig) {
        try {
          const funcInfo = getFunctionInfo(aObject);
          if (funcInfo && !bObject._rdoc) {
            bObject._rdoc = `${funcInfo.doc}`;
          }
          if (funcInfo && !bObject._rsig) {
            bObject._rsig = `${funcInfo.name}(${funcInfo.sig})`;
          }
        } catch (e) {
          console.error("Failed to extract function docstring:", aObject);
        }
      }

      return bObject;
    }
    const isarray = Array.isArray(aObject);

    for (let tp of Object.keys(this._codecs)) {
      const codec = this._codecs[tp];
      if (codec.encoder && aObject instanceof codec.type) {
        // TODO: what if multiple encoders found
        let encodedObj = await Promise.resolve(codec.encoder(aObject));
        if (encodedObj && !encodedObj._rtype) encodedObj._rtype = codec.name;
        // encode the functions in the interface object
        if (typeof encodedObj === "object") {
          const temp = encodedObj._rtype;
          delete encodedObj._rtype;
          encodedObj = await this._encode(
            encodedObj,
            session_id,
            local_workspace
          );
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
      bObject = {
        _rtype: "ndarray",
        _rvalue: new Uint8Array(v_buffer.buffer),
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
      bObject = {
        _rtype: "ndarray",
        _rvalue: new Uint8Array(aObject.selection.data.buffer),
        _rshape: aObject.shape,
        _rdtype: dtype
      };
    } else if (aObject instanceof Error) {
      console.error(aObject);
      bObject = { _rtype: "error", _rvalue: aObject.toString() };
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
    } else if (aObject instanceof Blob) {
      let _current_pos = 0;
      async function read(length) {
        let blob;
        if (length) {
          blob = aObject.slice(_current_pos, _current_pos + length);
        } else {
          blob = aObject.slice(_current_pos);
        }
        const ret = new Uint8Array(await blob.arrayBuffer());
        _current_pos = _current_pos + ret.byteLength;
        return ret;
      }
      function seek(pos) {
        _current_pos = pos;
      }
      bObject = {
        _rtype: "iostream",
        _rnative: "js:blob",
        type: aObject.type,
        name: aObject.name,
        size: aObject.size,
        path: aObject._path || aObject.webkitRelativePath,
        read: await this._encode(read, session_id, local_workspace),
        seek: await this._encode(seek, session_id, local_workspace)
      };
    } else if (aObject instanceof ArrayBufferView) {
      const dtype = typedArrayToDtype(aObject);
      bObject = {
        _rtype: "typedarray",
        _rvalue: new Uint8Array(aObject.buffer),
        _rdtype: dtype
      };
    } else if (aObject instanceof DataView) {
      bObject = {
        _rtype: "memoryview",
        _rvalue: new Uint8Array(aObject.buffer)
      };
    } else if (aObject instanceof Set) {
      bObject = {
        _rtype: "set",
        _rvalue: await this._encode(
          Array.from(aObject),
          session_id,
          local_workspace
        )
      };
    } else if (aObject instanceof Map) {
      bObject = {
        _rtype: "orderedmap",
        _rvalue: await this._encode(
          Array.from(aObject),
          session_id,
          local_workspace
        )
      };
    } else if (
      aObject.constructor instanceof Object ||
      Array.isArray(aObject)
    ) {
      bObject = isarray ? [] : {};
      const keys = Object.keys(aObject);
      for (let k of keys) {
        bObject[k] = await this._encode(
          aObject[k],
          session_id,
          local_workspace
        );
      }
    } else {
      throw `imjoy-rpc: Unsupported data type: ${aObject}, you can register a custom codec to encode/decode the object.`;
    }

    if (!bObject) {
      throw new Error("Failed to encode object");
    }
    return bObject;
  }

  async decode(aObject) {
    return await this._decode(aObject);
  }

  async _decode(
    aObject,
    remote_parent,
    local_parent,
    remote_workspace,
    local_workspace
  ) {
    if (!aObject) {
      return aObject;
    }
    let bObject;
    if (aObject._rtype) {
      if (
        this._codecs[aObject._rtype] &&
        this._codecs[aObject._rtype].decoder
      ) {
        const temp = aObject._rtype;
        delete aObject._rtype;
        aObject = await this._decode(
          aObject,
          remote_parent,
          local_parent,
          remote_workspace,
          local_workspace
        );
        aObject._rtype = temp;

        bObject = await Promise.resolve(
          this._codecs[aObject._rtype].decoder(aObject)
        );
      } else if (aObject._rtype === "method") {
        bObject = this._generate_remote_method(
          aObject,
          remote_parent,
          local_parent,
          remote_workspace,
          local_workspace
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
      } else if (aObject._rtype === "typedarray") {
        const arraytype = dtypeToTypedArray[aObject._rdtype];
        if (!arraytype)
          throw new Error("unsupported dtype: " + aObject._rdtype);
        const buffer = aObject._rvalue.buffer.slice(
          aObject._rvalue.byteOffset,
          aObject._rvalue.byteOffset + aObject._rvalue.byteLength
        );
        bObject = new arraytype(buffer);
      } else if (aObject._rtype === "memoryview") {
        bObject = aObject._rvalue.buffer.slice(
          aObject._rvalue.byteOffset,
          aObject._rvalue.byteOffset + aObject._rvalue.byteLength
        ); // ArrayBuffer
      } else if (aObject._rtype === "iostream") {
        if (aObject._rnative === "js:blob") {
          const read = await this._generate_remote_method(
            aObject.read,
            remote_parent,
            local_parent,
            remote_workspace,
            local_workspace
          );
          const bytes = await read();
          bObject = new Blob([bytes], {
            type: aObject.type,
            name: aObject.name
          });
        } else {
          bObject = {};
          for (let k of Object.keys(aObject)) {
            if (!k.startsWith("_")) {
              bObject[k] = await this._decode(
                aObject[k],
                remote_parent,
                local_parent,
                remote_workspace,
                local_workspace
              );
            }
          }
        }
        bObject["__rpc_object__"] = aObject;
      } else if (aObject._rtype === "orderedmap") {
        bObject = new Map(
          await this._decode(
            aObject._rvalue,
            remote_parent,
            local_parent,
            remote_workspace,
            local_workspace
          )
        );
      } else if (aObject._rtype === "set") {
        bObject = new Set(
          await this._decode(
            aObject._rvalue,
            remote_parent,
            local_parent,
            remote_workspace,
            local_workspace
          )
        );
      } else {
        const temp = aObject._rtype;
        delete aObject._rtype;
        bObject = await this._decode(
          aObject,
          remote_parent,
          local_parent,
          remote_workspace,
          local_workspace
        );
        bObject._rtype = temp;
      }
    } else if (aObject.constructor === Object || Array.isArray(aObject)) {
      const isarray = Array.isArray(aObject);
      bObject = isarray ? [] : {};
      for (let k of Object.keys(aObject)) {
        if (isarray || aObject.hasOwnProperty(k)) {
          const v = aObject[k];
          bObject[k] = await this._decode(
            v,
            remote_parent,
            local_parent,
            remote_workspace,
            local_workspace
          );
        }
      }
    } else {
      bObject = aObject;
    }
    if (bObject === undefined) {
      throw new Error("Failed to decode object");
    }
    return bObject;
  }
}
