import asyncio
import inspect
import logging
import os
import sys
import threading
import time
import traceback
import uuid

from werkzeug.local import Local

from .utils import dotdict, format_traceback, ReferenceStore, FuturePromise

API_VERSION = "0.2.0"

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("RPC")
logger.setLevel(logging.INFO)

try:
    import numpy as np

    NUMPY = np
except:
    NUMPY = False
    logger.warn("failed to import numpy, ndarray encoding/decoding will not work")


class RPC:
    def __init__(
        self, transport, local_context=None, config=None,
    ):
        self.manager_api = {}
        self.services = {}
        self._plugin_interfaces = {}
        self._remote_set = False
        self._store = ReferenceStore()
        self.work_dir = os.getcwd()
        self.abort = threading.Event()

        if config is None:
            config = dotdict()
        else:
            config = dotdict(config)
        self.id = config.id or str(uuid.uuid4())
        self.token = config.token or str(uuid.uuid4())
        self.allow_execution = config.allow_execution or False
        self.config = {
            "allow_execution": self.allow_execution,
            "api_version": API_VERSION,
            "dedicated_thread": True,
            "description": config.description or "[TODO]",
            "id": self.id,
            "lang": "python",
            "name": config.name or "imjoy_rpc_python",
            "token": self.token,
            "type": "rpc-worker",
            "work_dir": self.work_dir,
        }

        self.loop = config.loop or asyncio.get_event_loop()

        if local_context is None:
            local_context = Local()
            local_context.api = dotdict()
        self.local_context = local_context
        self.export = self.local_context.api.export

        if transport is not None:

            def process_message(msg):
                self.loop.create_task(self.processMessage(msg))

            self.transport = transport
            self.transport.on(process_message)

    def init(self):
        self.emit(
            {"type": "initialized", "config": self.config,}
        )

    def start(self):
        self.run_forever()

    def emit(self, msg):
        self.transport.emit(msg)

    def register(self, plugin_path):
        service = Service(plugin_path)

    def on_close(self, conn):
        local_manager.cleanup()

    def default_exit(self):
        """Exit default."""
        logger.info("Terminating plugin: %s", self.id)
        self.abort.set()
        os._exit(0)  # pylint: disable=protected-access

    def set_interface(self, api):
        """Set interface."""
        if isinstance(api, dict):
            api = {a: api[a] for a in api.keys() if not a.startswith("_")}
        elif inspect.isclass(type(api)):
            api = {a: getattr(api, a) for a in dir(api) if not a.startswith("_")}
        else:
            raise Exception("unsupported api export")

        if "exit" in api:
            ext = api["exit"]

            def exit_wrapper():
                try:
                    ext()
                finally:
                    self.default_exit()

            api["exit"] = exit_wrapper
        else:
            api["exit"] = self.default_exit
        self.interface = api

    def send_interface(self):
        """Send interface."""
        names = []
        for name in self.interface:
            if callable(self.interface[name]):
                names.append({"name": name, "data": None})
            else:
                data = self.interface[name]
                if data is not None and isinstance(data, dict):
                    data2 = {}
                    for k in data:
                        if callable(data[k]):
                            data2[k] = "rpc_method::" + k
                        else:
                            data2[k] = data[k]
                    names.append({"name": name, "data": data2})
                elif isinstance(data, (str, int, float, bool)):
                    names.append({"name": name, "data": data})
        self.emit({"type": "setInterface", "api": names})

    def _gen_remote_method(self, name, plugin_id=None):
        """Return remote method."""

        def remote_method(*arguments, **kwargs):
            """Run remote method."""
            # wrap keywords to a dictionary and pass to the first argument
            if not arguments and kwargs:
                arguments = [kwargs]

            def pfunc(resolve, reject):
                resolve.__jailed_pairs__ = reject
                reject.__jailed_pairs__ = resolve
                call_func = {
                    "type": "method",
                    "name": name,
                    "pid": plugin_id,
                    "args": self.wrap(arguments),
                    "promise": self.wrap([resolve, reject]),
                }
                self.emit(call_func)

            return FuturePromise(pfunc, self.loop)

        remote_method.__remote_method = True  # pylint: disable=protected-access
        return remote_method

    def _gen_remote_callback(self, id_, arg_num, with_promise):
        """Return remote callback."""
        if with_promise:

            def remote_callback(*arguments, **kwargs):
                # wrap keywords to a dictionary and pass to the first argument
                if not arguments and kwargs:
                    arguments = [kwargs]
                self.emit({"type": "log", "message": str(arguments)})

                def pfunc(resolve, reject):
                    resolve.__jailed_pairs__ = reject
                    reject.__jailed_pairs__ = resolve
                    self.emit(
                        {
                            "type": "callback",
                            "id": id_,
                            "num": arg_num,
                            # 'pid'  : self.id,
                            "args": self.wrap(arguments),
                            "promise": self.wrap([resolve, reject]),
                        }
                    )

                return FuturePromise(pfunc, self.loop)

        else:

            def remote_callback(*arguments, **kwargs):
                # wrap keywords to a dictionary and pass to the first argument
                if not arguments and kwargs:
                    arguments = [kwargs]
                self.emit(
                    {
                        "type": "callback",
                        "id": id_,
                        "num": arg_num,
                        # 'pid'  : self.id,
                        "args": self.wrap(arguments),
                    }
                )

        return remote_callback

    def set_remote(self, api):
        """Set remote."""
        _remote = dotdict()
        for i, _ in enumerate(api):
            if isinstance(api[i], dict) and "name" in api[i]:
                name = api[i]["name"]
                data = api[i].get("data", None)
                if data is not None:
                    if isinstance(data, dict):
                        data2 = dotdict()
                        for key in data:
                            if key in data:
                                if data[key] == "rpc_method::" + key:
                                    data2[key] = self._gen_remote_method(
                                        name + "." + key
                                    )
                                else:
                                    data2[key] = data[key]
                        _remote[name] = data2
                    else:
                        _remote[name] = data
                else:
                    _remote[name] = self._gen_remote_method(name)

        self._set_local_api(_remote)
        return _remote

    def export(self, interface):
        self.set_interface(interface)
        self.init()

    def _set_local_api(self, _remote):
        """Set local API."""
        _remote["export"] = self.export
        _remote["utils"] = dotdict()
        _remote["WORK_DIR"] = self.work_dir

        self.local_context.api = _remote
        self.local_context.api.export = self.export

    async def processMessage(self, data):
        try:
            await self._processMessage(data)
        except Exception:
            traceback_error = traceback.format_exc()
            self.emit({"type": "error", "message": traceback_error})

    async def _processMessage(self, data):
        if data["type"] == "disconnect":
            conn.abort.set()
            try:
                if "exit" in conn.interface and callable(conn.interface["exit"]):
                    conn.interface["exit"]()
            except Exception as exc:  # pylint: disable=broad-except
                logger.error("Error when exiting: %s", exc)
        elif data["type"] == "getInterface":
            self.send_interface()
        elif data["type"] == "setInterface":
            self.set_remote(data["api"])
            self.emit({"type": "interfaceSetAsRemote"})
        elif data["type"] == "interfaceSetAsRemote":
            self._remote_set = True
        elif data["type"] == "getConfig":
            self.emit(
                {"type": "config", "config": self.config,}
            )
        elif data["type"] == "execute":
            if self.allow_execution:
                try:
                    t = data["code"]["type"]
                    if t == "script":
                        content = data["code"]["content"]
                        exec(content, self._local)
                    elif t == "requirements":
                        pass
                    else:
                        raise Exception("unsupported type")
                    self.emit({"type": "executeSuccess"})
                except Exception as e:
                    traceback_error = traceback.format_exc()
                    logger.error("error during execution: %s", traceback_error)
                    self.emit({"type": "executeFailure", "error": traceback_error})
            else:
                self.emit(
                    {"type": "executeFailure", "error": "execution is not allowed"}
                )
                logger.warn("execution is blocked due to allow_execution=False")

        elif data["type"] == "method":
            interface = self.interface
            if "pid" in data and data["pid"] is not None:
                interface = self._plugin_interfaces[data["pid"]]
            if data["name"] in interface:
                if "promise" in data:
                    resolve, reject = self.unwrap(data["promise"], False)
                    try:
                        method = interface[data["name"]]
                        args = self.unwrap(data["args"], True)
                        # args.append({'id': self.id})
                        result = method(*args)
                        if result is not None and inspect.isawaitable(result):
                            result = await result
                        resolve(result)
                    except Exception as e:
                        traceback_error = traceback.format_exc()
                        logger.error(
                            "error in method %s: %s", data["name"], traceback_error
                        )
                        self.emit({"type": "error", "message": traceback_error})
                        reject(Exception(format_traceback(traceback_error)))
                else:
                    try:
                        method = interface[data["name"]]
                        args = self.unwrap(data["args"], True)
                        # args.append({'id': self.id})
                        result = method(*args)
                        if result is not None and inspect.isawaitable(result):
                            await result
                    except Exception:
                        traceback_error = traceback.format_exc()
                        self.emit({"type": "error", "message": traceback_error})
                        logger.error(
                            "error in method %s: %s", data["name"], traceback_error,
                        )
            else:
                traceback_error = "method " + data["name"] + " is not found."
                self.emit({"type": "error", "message": traceback_error})
                logger.error(
                    "error in method %s: %s", data["name"], traceback_error,
                )

        elif data["type"] == "callback":
            if "promise" in data:
                resolve, reject = self.unwrap(data["promise"], False)
                try:
                    method = self._store.fetch(data["num"])
                    if method is None:
                        raise Exception(
                            "Callback function can only called once, "
                            "if you want to call a function for multiple times, "
                            "please make it as a plugin api function. "
                            "See https://imjoy.io/docs for more details."
                        )
                    args = self.unwrap(data["args"], True)
                    result = method(*args)
                    if result is not None and inspect.isawaitable(result):
                        result = await result
                    resolve(result)
                except Exception as e:
                    traceback_error = traceback.format_exc()
                    logger.error("error in method %s: %s", data["num"], traceback_error)
                    reject(Exception(format_traceback(traceback_error)))
                    self.emit({"type": "error", "message": traceback_error})
            else:
                try:
                    method = self._store.fetch(data["num"])
                    self.emit({"type": "log", "message": "running callback"})
                    if method is None:
                        raise Exception(
                            "Callback function can only called once, "
                            "if you want to call a function for multiple times, "
                            "please make it as a plugin api function. "
                            "See https://imjoy.io/docs for more details."
                        )
                    args = self.unwrap(data["args"], True)
                    result = method(*args)
                    if result is not None and inspect.isawaitable(result):
                        await result
                except Exception:
                    traceback_error = traceback.format_exc()
                    logger.error("error in method %s: %s", data["num"], traceback_error)
                    self.emit({"type": "error", "message": traceback_error})

    def wrap(self, args):
        """Wrap arguments."""
        wrapped = self._encode(args)
        result = {"args": wrapped}
        return result

    def _encode(self, a_object):
        """Encode object."""
        if a_object is None:
            return a_object
        if isinstance(a_object, tuple):
            a_object = list(a_object)
        isarray = isinstance(a_object, list)
        b_object = [] if isarray else {}
        # skip if already encoded
        if (
            isinstance(a_object, dict)
            and "__jailed_type__" in a_object
            and "__value__" in a_object
        ):
            return a_object

        # encode interfaces
        if (
            isinstance(a_object, dict)
            and "__id__" in a_object
            and "__jailed_type__" in a_object
            and a_object["__jailed_type__"] == "plugin_api"
        ):
            encoded_interface = {}
            for key, val in a_object.items():
                if callable(val):
                    b_object[key] = {
                        "__jailed_type__": "plugin_interface",
                        "__plugin_id__": a_object["__id__"],
                        "__value__": key,
                        "num": None,
                    }
                    encoded_interface[key] = val
            self.plugin_interfaces[a_object["__id__"]] = encoded_interface
            return b_object

        keys = range(len(a_object)) if isarray else a_object.keys()
        for key in keys:
            val = a_object[key]
            try:
                basestring
            except NameError:
                basestring = str
            if callable(val):
                interface_func_name = None
                for name in self.interface:
                    if self.interface[name] == val:
                        interface_func_name = name
                        break
                if interface_func_name is None:
                    cid = self._store.put(val)
                    v_obj = {
                        "__jailed_type__": "callback",
                        "__value__": "f",
                        "num": cid,
                    }
                else:
                    v_obj = {
                        "__jailed_type__": "interface",
                        "__value__": interface_func_name,
                    }

            # send objects supported by structure clone algorithm
            # https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
            # if (
            #   v !== Object(v) ||
            #   v instanceof Boolean ||
            #   v instanceof String ||
            #   v instanceof Date ||
            #   v instanceof RegExp ||
            #   v instanceof Blob ||
            #   v instanceof File ||
            #   v instanceof FileList ||
            #   v instanceof ArrayBuffer ||
            #   v instanceof ArrayBufferView ||
            #   v instanceof ImageData
            # ) {
            # }
            elif NUMPY and isinstance(val, (NUMPY.ndarray, NUMPY.generic)):
                v_bytes = val.tobytes()
                v_obj = {
                    "__jailed_type__": "ndarray",
                    "__value__": v_bytes,
                    "__shape__": val.shape,
                    "__dtype__": str(val.dtype),
                }
            elif isinstance(val, (dict, list)):
                v_obj = self._encode(val)
            elif not isinstance(val, basestring) and isinstance(val, bytes):
                v_obj = val.decode()  # covert python3 bytes to str
            elif isinstance(val, Exception):
                v_obj = {"__jailed_type__": "error", "__value__": str(val)}
            else:
                v_obj = {"__jailed_type__": "argument", "__value__": val}

            if isarray:
                b_object.append(v_obj)
            else:
                b_object[key] = v_obj

        return b_object

    def unwrap(self, args, with_promise):
        """Unwrap arguments."""
        if "callbackId" not in args:
            args["callbackId"] = None
        # wraps each callback so that the only one could be called
        result = self._decode(args["args"], args["callbackId"], with_promise)
        return result

    def _decode(self, a_object, callback_id, with_promise):
        """Decode object."""
        if a_object is None:
            return a_object
        if "__jailed_type__" in a_object and "__value__" in a_object:
            if a_object["__jailed_type__"] == "callback":
                b_object = self._gen_remote_callback(
                    callback_id, a_object["num"], with_promise
                )
            elif a_object["__jailed_type__"] == "interface":
                name = a_object["__value__"]
                if name in self._remote:
                    b_object = self._remote[name]
                else:
                    b_object = self._gen_remote_method(name)
            elif a_object["__jailed_type__"] == "plugin_interface":
                b_object = self._gen_remote_method(
                    a_object["__value__"], a_object["__plugin_id__"]
                )
            elif a_object["__jailed_type__"] == "ndarray":
                # create build array/tensor if used in the plugin
                try:
                    np = self.local_context.np  # pylint: disable=invalid-name
                    if isinstance(a_object["__value__"], bytes):
                        a_object["__value__"] = a_object["__value__"]
                    elif isinstance(a_object["__value__"], (list, tuple)):
                        a_object["__value__"] = reduce(
                            (lambda x, y: x + y), a_object["__value__"]
                        )
                    else:
                        raise Exception(
                            "Unsupported data type: ",
                            type(a_object["__value__"]),
                            a_object["__value__"],
                        )
                    if NUMPY:
                        b_object = NUMPY.frombuffer(
                            a_object["__value__"], dtype=a_object["__dtype__"]
                        ).reshape(tuple(a_object["__shape__"]))
                    else:
                        b_object = a_object
                        logger.warn("numpy is not available, failed to decode ndarray")

                except Exception as exc:
                    logger.debug("Error in converting: %s", exc)
                    b_object = a_object
                    raise exc
            elif a_object["__jailed_type__"] == "error":
                b_object = Exception(a_object["__value__"])
            elif a_object["__jailed_type__"] == "argument":
                b_object = a_object["__value__"]
            else:
                b_object = a_object["__value__"]
            return b_object

        if isinstance(a_object, tuple):
            a_object = list(a_object)
        isarray = isinstance(a_object, list)
        b_object = [] if isarray else dotdict()
        keys = range(len(a_object)) if isarray else a_object.keys()
        for key in keys:
            if isarray or key in a_object:
                val = a_object[key]
                if isinstance(val, (dict, list)):
                    if isarray:
                        b_object.append(self._decode(val, callback_id, with_promise))
                    else:
                        b_object[key] = self._decode(val, callback_id, with_promise)
        return b_object
