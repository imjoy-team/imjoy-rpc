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

from .utils import (
    dotdict,
    format_traceback,
    ReferenceStore,
    FuturePromise,
    MessageEmitter,
)

API_VERSION = "0.2.1"

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("RPC")
logger.setLevel(logging.INFO)

try:
    import numpy as np

    NUMPY = np
except:
    NUMPY = False
    logger.warn("failed to import numpy, ndarray encoding/decoding will not work")


class RPC(MessageEmitter):
    def __init__(
        self, connection, rpc_context, export, config=None,
    ):
        self.manager_api = {}
        self.services = {}
        self._interface_store = {}
        self._local_api = None
        self._remote_set = False
        self._store = ReferenceStore()
        self.work_dir = os.getcwd()
        self.abort = threading.Event()

        if config is None:
            config = {}
        self.set_config(config)

        super().__init__(self.config.debug)

        self.loop = asyncio.get_event_loop()

        self.rpc_context = rpc_context
        self.export = export

        if connection is not None:
            self._connection = connection
            self._setup_handlers(connection)

    def init(self):
        self._connection.emit(
            {
                "type": "initialized",
                "config": dict(self.config),
                "peer_id": self._connection.peer_id,
            }
        )

    def start(self):
        self.run_forever()

    def register(self, plugin_path):
        service = Service(plugin_path)

    def disconnect(self, conn):
        local_manager.cleanup()

    def default_exit(self):
        """Exit default."""
        logger.info("Terminating plugin: %s", self.id)
        self.abort.set()
        # os._exit(0)  # pylint: disable=protected-access

    def set_config(self, config):
        if config is not None:
            config = dotdict(config)
        else:
            config = dotdict()
        self.id = config.id or str(uuid.uuid4())
        self.allow_execution = config.allow_execution or False
        self.config = dotdict(
            {
                "allow_execution": self.allow_execution,
                "api_version": API_VERSION,
                "dedicated_thread": True,
                "description": config.description or "[TODO]",
                "id": self.id,
                "lang": "python",
                "name": config.name or "ImJoy RPC Python",
                "type": "rpc-worker",
                "work_dir": self.work_dir,
                "version": config.version or "0.1.0",
            }
        )

    def set_interface(self, api, config=None):
        """Set interface."""
        self.set_config(config)
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
        self._local_api = api

        self._fire("interfaceAvailable")

    def send_interface(self):
        """Send interface."""
        if self._local_api is None:
            raise Exception("interface is not set.")
        self._local_api["_rid"] = "_rlocal"
        api = self._encode(self._local_api, True)
        self._connection.emit({"type": "setInterface", "api": api})

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
                self._connection.emit(call_func)

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
                self._connection.emit({"type": "log", "message": str(arguments)})

                def pfunc(resolve, reject):
                    resolve.__jailed_pairs__ = reject
                    reject.__jailed_pairs__ = resolve
                    self._connection.emit(
                        {
                            "type": "callback",
                            "id": id_,
                            "_rindex": arg_num,
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
                self._connection.emit(
                    {
                        "type": "callback",
                        "id": id_,
                        "_rindex": arg_num,
                        # 'pid'  : self.id,
                        "args": self.wrap(arguments),
                    }
                )

        return remote_callback

    def set_remote_interface(self, api):
        """Set remote."""
        _remote = self._decode(api, None, False)
        self._interface_store["_rremote"] = _remote
        self._fire("remoteReady")
        self._run_with_context(self._set_local_api, _remote)

    def export(self, interface):
        self.set_interface(interface)
        self.init()

    def _set_local_api(self, _remote):
        """Set local API."""
        self.rpc_context.api = _remote
        self.rpc_context.api.utils = dotdict()
        self.rpc_context.api.WORK_DIR = self.work_dir
        self.rpc_context.api.export = self.export

    def _call_method(self, method, *args, resolve=None, reject=None, method_name=None):
        try:
            result = method(*args)
            if result is not None and inspect.isawaitable(result):

                async def _wait(result):
                    try:
                        result = await result
                        if resolve is not None:
                            resolve(result)
                        elif result is not None:
                            logger.debug("returned value %s", result)
                    except Exception as ex:
                        traceback_error = traceback.format_exc()
                        logger.error("error in method %s", traceback_error)
                        self._connection.emit(
                            {"type": "error", "message": traceback_error}
                        )
                        if reject is not None:
                            reject(Exception(format_traceback(traceback_error)))

                asyncio.ensure_future(_wait(result))
            else:
                if reject is not None:
                    resolve(result)
        except Exception as e:
            traceback_error = traceback.format_exc()
            logger.error("error in method %s: %s", method_name, traceback_error)
            self._connection.emit({"type": "error", "message": traceback_error})
            if reject is not None:
                reject(Exception(format_traceback(traceback_error)))

    def _run_with_context(self, func, *args, **kwargs):
        self.rpc_context.run_with_context(self.id, func, *args, **kwargs)

    def _setup_handlers(self, connection):
        connection.on("init", self.init)
        connection.on("disconnected", self.disconnect)
        connection.on("execute", self._handle_execute)
        connection.on("method", self._handle_method)
        connection.on("callback", self._handle_callback)
        connection.on("disconnected", self._disconnected_hanlder)
        connection.on("getInterface", self._get_interface_handler)
        connection.on("setInterface", self._set_interface_handler)
        connection.on("interfaceSetAsRemote", self._remote_set_handler)

    def _disconnected_hanlder(self, data):
        self._connection.disconnect()

    def _get_interface_handler(self, data):
        if self._local_api is not None:
            self.send_interface()
        else:
            self.once("interfaceAvailable", self.send_interface)

    def _set_interface_handler(self, data):
        self.set_remote_interface(data["api"])
        self._connection.emit({"type": "interfaceSetAsRemote"})

    def _remote_set_handler(self, data):
        self._remote_set = True

    def _handle_execute(self, data):
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
                self._connection.emit({"type": "executed"})
            except Exception as e:
                traceback_error = traceback.format_exc()
                logger.error("error during execution: %s", traceback_error)
                self._connection.emit({"type": "executed", "error": traceback_error})
        else:
            self._connection.emit(
                {"type": "executed", "error": "execution is not allowed",}
            )
            logger.warn("execution is blocked due to allow_execution=False")

    def _handle_method(self, data):
        interface = self._interface_store[data["pid"]]
        if data["name"] in interface:
            if "promise" in data:
                resolve, reject = self.unwrap(data["promise"], False)
                method = interface[data["name"]]
                args = self.unwrap(data["args"], True)
                # args.append({'id': self.id})
                result = self._run_with_context(
                    self._call_method,
                    method,
                    *args,
                    resolve=resolve,
                    reject=reject,
                    method_name=data["name"]
                )
            else:
                method = interface[data["name"]]
                args = self.unwrap(data["args"], True)
                # args.append({'id': self.id})
                result = self._run_with_context(
                    self._call_method, method, *args, method_name=data["name"]
                )
        else:
            traceback_error = "method " + data["name"] + " is not found."
            self._connection.emit({"type": "error", "message": traceback_error})
            logger.error(
                "error in method %s: %s", data["name"], traceback_error,
            )

    def _handle_callback(self, data):
        if "promise" in data:
            resolve, reject = self.unwrap(data["promise"], False)
            method = self._store.fetch(data["_rindex"])
            if method is None:
                raise Exception(
                    "Callback function can only called once, "
                    "if you want to call a function for multiple times, "
                    "please make it as a plugin api function. "
                    "See https://imjoy.io/docs for more details."
                )
            args = self.unwrap(data["args"], True)
            result = self._run_with_context(
                self._call_method,
                method,
                *args,
                resolve=resolve,
                reject=reject,
                method_name=data["_rindex"]
            )

        else:
            method = self._store.fetch(data["_rindex"])
            if method is None:
                raise Exception(
                    "Callback function can only called once, "
                    "if you want to call a function for multiple times, "
                    "please make it as a plugin api function. "
                    "See https://imjoy.io/docs for more details."
                )
            args = self.unwrap(data["args"], True)
            result = self._run_with_context(
                self._call_method, method, *args, method_name=data["_rindex"]
            )

    def wrap(self, args):
        """Wrap arguments."""
        wrapped = self._encode(args)
        result = {"args": wrapped}
        return result

    def _encode_interface(self, a_object):
        encoded_interface = {}
        a_object["_rid"] = a_object["_rid"] or str(uuid.uuid4())
        isarray = isinstance(a_object, list)
        keys = range(len(a_object)) if isarray else a_object.keys()
        b_object = [] if iisarray else {}
        for key in keys:
            val = a_object[key]
            if key.startswith("_"):
                continue
            if callable(val):
                v_obj = {
                    "_rtype": "interface",
                    "_rid": a_object["_rid"],
                    "_rvalue": key,
                }
                encoded_interface[key] = val
            elif type(val) in (int, float, bool, str):
                v_obj = {"_rtype": "argument", "_rvalue": val}
                encoded_interface[key] = val
            elif isinstance(val, (dict, list)):
                v_obj = self._encode_interface(val)

            if isarray:
                b_object.append(v_obj)
            else:
                b_object[key] = v_obj

        self._interface_store[a_object["_rid"]] = encoded_interface

        # remove interface when closed
        if "on" in a_object and callable(a_object["on"]):

            def remove_interface():
                del self._interface_store[a_object["_rid"]]

            a_object["on"]("close", remove_interface)

    def _encode(self, a_object, as_interface=False):
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
            and "_rtype" in a_object
            and "_rvalue" in a_object
        ):
            return a_object

        # encode interfaces
        if (
            isinstance(a_object, dict)
            and "_rid" in a_object
            and "_rtype" in a_object
            and (a_object.get("_rintf") or as_interface)
        ):
            return self._encode_interface(a_object)

        if as_interface:
            a_object["_rid"] = a_object["_rid"] or str(uuid.uuid4)
            if a_object["_rid"] not in self._interface_store:
                self._interface_store[a_object["_rid"]] = [] if isarray else {}

        keys = range(len(a_object)) if isarray else a_object.keys()
        for key in keys:
            val = a_object[key]
            try:
                basestring
            except NameError:
                basestring = str
            if val is not None and callable(self._local_api.get("_rpc_encode")):
                encoded_obj = self._local_api["_rpc_encode"](val)
                if isinstance(encoded_obj, dict) and encoded_obj.get("_ctype"):
                    b_object[key] = {
                        "_rtype": "custom",
                        "_rvalue": encoded_obj,
                        "_rid": a_object["_rid"],
                    }
                    continue
                # if the returned object does not contain _rtype, assuming the object has been transformed
                elif encoded_obj is not None:
                    val = encoded_obj

            if callable(val):
                if as_interface:
                    encoded_interface = self._interface_store[a_object["_rid"]]
                    b_object[key] = {
                        "_rtype": "interface",
                        "_rid": a_object["_rid"],
                        "_rvalue": key,
                    }
                    encoded_interface[key] = val
                    continue

                interface_func_name = None
                for name in self._local_api:
                    if self._local_api[name] == val:
                        interface_func_name = name
                        break
                if interface_func_name is None:
                    cid = self._store.put(val)
                    v_obj = {
                        "_rtype": "callback",
                        "_rvalue": "f",
                        "_rindex": cid,
                    }
                else:
                    v_obj = {
                        "_rtype": "interface",
                        "_rvalue": interface_func_name,
                    }

            elif NUMPY and isinstance(val, (NUMPY.ndarray, NUMPY.generic)):
                v_bytes = val.tobytes()
                v_obj = {
                    "_rtype": "ndarray",
                    "_rvalue": v_bytes,
                    "_rshape": val.shape,
                    "_rdtype": str(val.dtype),
                }
            elif not isinstance(val, basestring) and isinstance(val, bytes):
                v_obj = val.decode()  # covert python3 bytes to str
            elif isinstance(val, Exception):
                v_obj = {"_rtype": "error", "_rvalue": str(val)}
            elif hasattr(val, "_rintf") and val._rintf == True:
                v_obj = self._encode(val, true)
            elif isinstance(val, dict):
                as_interface = as_interface or (
                    "_rintf" in val and val["_rintf"] == True
                )
                v_obj = self._encode(val, as_interface)
            elif isinstance(val, list):
                v_obj = self._encode(val, as_interface)
            else:
                v_obj = {"_rtype": "argument", "_rvalue": val}

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
        if "_rtype" in a_object and "_rvalue" in a_object:
            if a_object["_rtype"] == "custom":
                if a_object["_rvalue"] and callable(self._local_api.get("_rpc_decode")):
                    b_object = self._local_api["_rpc_decode"](a_object["_rvalue"])
                    if b_object is None:
                        b_object = a_object
                else:
                    b_object = a_object

            if a_object["_rtype"] == "callback":
                b_object = self._gen_remote_callback(
                    callback_id, a_object["_rindex"], with_promise
                )
            elif a_object["_rtype"] == "interface":
                name = a_object["_rvalue"]
                rid = a_object["_rid"]
                intfid = (
                    "_rrmote" if a_object["_rid"] == "_rlocal" else a_object["_rid"]
                )
                if intfid in self._interface_store:
                    b_object = self._interface_store[intfid][name]
                else:
                    b_object = self._gen_remote_method(name, rid)
            elif a_object["_rtype"] == "ndarray":
                # create build array/tensor if used in the plugin
                try:
                    if isinstance(a_object["_rvalue"], bytes):
                        a_object["_rvalue"] = a_object["_rvalue"]
                    elif isinstance(a_object["_rvalue"], (list, tuple)):
                        a_object["_rvalue"] = reduce(
                            (lambda x, y: x + y), a_object["_rvalue"]
                        )
                    else:
                        raise Exception(
                            "Unsupported data type: ",
                            type(a_object["_rvalue"]),
                            a_object["_rvalue"],
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
            elif a_object["_rtype"] == "error":
                b_object = Exception(a_object["_rvalue"])
            elif a_object["_rtype"] == "argument":
                b_object = a_object["_rvalue"]
            else:
                b_object = a_object["_rvalue"]
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
