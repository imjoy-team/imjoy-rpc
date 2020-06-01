import asyncio
import inspect
import logging
import os
import io
import sys
import threading
import time
import traceback
import uuid
import weakref
from collections import OrderedDict

from werkzeug.local import Local

from .utils import (
    dotdict,
    format_traceback,
    ReferenceStore,
    FuturePromise,
    MessageEmitter,
)

API_VERSION = "0.2.3"

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("RPC")
logger.setLevel(logging.INFO)

try:
    import numpy as np

    NUMPY = np
except:
    NUMPY = False
    logger.warn("failed to import numpy, ndarray encoding/decoding will not work")


def index_object(obj, ids):
    if isinstance(ids, str):
        return index_object(obj, ids.split("."))
    elif len(ids) == 0:
        return obj
    else:
        if isinstance(obj, dict):
            _obj = obj[ids[0]]
        elif isinstance(obj, (list, tuple)):
            _obj = obj[int(ids[0])]
        else:
            _obj = getattr(obj, ids[0])
        return index_object(_obj, ids[1:])


class RPC(MessageEmitter):
    def __init__(
        self, connection, rpc_context, config=None, codecs=None,
    ):
        self.manager_api = {}
        self.services = {}
        self._object_store = {}
        self._method_weakmap = weakref.WeakKeyDictionary()
        self._object_weakmap = weakref.WeakKeyDictionary()
        self._local_api = None
        self._remote_set = False
        self._store = ReferenceStore()
        self._remote_interface = None
        self._codecs = codecs or {}
        self.work_dir = os.getcwd()
        self.abort = threading.Event()

        self.rpc_context = rpc_context

        if config is None:
            config = {}
        self.set_config(config)

        self._remote_logger = dotdict({"info": self._log, "error": self._error})
        super().__init__(self._remote_logger)

        self.loop = asyncio.get_event_loop()

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
        self.id = config.id or self.id or str(uuid.uuid4())
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

    def get_remote(self):
        return self._remote_interface

    def set_interface(self, api, config=None):
        """Set interface."""
        # TODO: setup forwarding_functions
        self.set_config(config)

        # store it in a docdict such that the methods are hashable
        self._local_api = dotdict(api) if isinstance(api, dict) else api

        self._fire("interfaceAvailable")

    def send_interface(self):
        """Send interface."""
        if self._local_api is None:
            raise Exception("interface is not set.")
        if isinstance(self._local_api, dict):
            api = {
                a: self._local_api[a]
                for a in self._local_api.keys()
                if not a.startswith("_")
            }
        elif inspect.isclass(type(self._local_api)):
            api = {
                a: getattr(self._local_api, a)
                for a in dir(self._local_api)
                if not a.startswith("_")
            }
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

        api = self._encode(api, True)
        self._connection.emit({"type": "setInterface", "api": api})

    def _dispose_object(self, object_id):
        if object_id in self._object_store:
            del self._object_store[object_id]
        else:
            raise Exception("Object (id={}) not found.".format(object_id))

    def dispose_object(self, obj):
        if obj in self._object_weakmap:
            object_id = self._object_weakmap[obj]
        else:
            raise Exception("Invalid object")

        def pfunc(resolve, reject):
            def handle_disposed(data):
                if "error" in data:
                    reject(data["error"])
                else:
                    resolve()

            self._connection.once("disposed", handle_disposed)
            self._connection.emit({"type": "disposeObject", "object_id": object_id})

        return FuturePromise(pfunc, self._remote_logger)

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
                    "object_id": plugin_id,
                    "args": self.wrap(arguments),
                    "promise": self.wrap([resolve, reject]),
                }
                self._connection.emit(call_func)

            return FuturePromise(pfunc, self._remote_logger)

        remote_method.__remote_method = True  # pylint: disable=protected-access
        return remote_method

    def _gen_remote_callback(self, cid, with_promise):
        """Return remote callback."""
        if with_promise:

            def remote_callback(*arguments, **kwargs):
                # wrap keywords to a dictionary and pass to the first argument
                if not arguments and kwargs:
                    arguments = [kwargs]

                def pfunc(resolve, reject):
                    resolve.__jailed_pairs__ = reject
                    reject.__jailed_pairs__ = resolve
                    self._connection.emit(
                        {
                            "type": "callback",
                            "id": cid,
                            # 'object_id'  : self.id,
                            "args": self.wrap(arguments),
                            "promise": self.wrap([resolve, reject]),
                        }
                    )

                return FuturePromise(pfunc, self._remote_logger)

        else:

            def remote_callback(*arguments, **kwargs):
                # wrap keywords to a dictionary and pass to the first argument
                if not arguments and kwargs:
                    arguments = [kwargs]
                self._connection.emit(
                    {
                        "type": "callback",
                        "id": cid,
                        # 'object_id'  : self.id,
                        "args": self.wrap(arguments),
                    }
                )

        return remote_callback

    def set_remote_interface(self, api):
        """Set remote."""
        _remote = self._decode(api, False)
        self._remote_interface = _remote
        self._fire("remoteReady")
        self._run_with_context(self._set_local_api, _remote)

    def _set_local_api(self, _remote):
        """Set local API."""
        self.rpc_context.api = _remote
        self.rpc_context.api.utils = dotdict()
        self.rpc_context.api.WORK_DIR = self.work_dir

    def _log(self, info):
        self._connection.emit({"type": "log", "message": info})

    def _error(self, error):
        self._connection.emit({"type": "error", "message": error})

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
                if resolve is not None:
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
        connection.on("disposeObject", self._dispose_object_handler)

    def _dispose_object_handler(self, data):
        try:
            self._dispose_object(data["object_id"])
            self._connection.emit({"type": "disposed"})
        except Exception as e:
            logger.error("failed to dispose object: %s", e)
            self._connection.emit({"type": "disposed", "error": str(e)})

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
        reject = None
        try:
            if "promise" in data:
                resolve, reject = self.unwrap(data["promise"], False)
            _interface = self._object_store[data["object_id"]]
            method = index_object(_interface, data["name"])
            if "promise" in data:
                args = self.unwrap(data["args"], True)
                # args.append({'id': self.id})
                self._run_with_context(
                    self._call_method,
                    method,
                    *args,
                    resolve=resolve,
                    reject=reject,
                    method_name=data["name"]
                )
            else:
                args = self.unwrap(data["args"], True)
                # args.append({'id': self.id})
                self._run_with_context(
                    self._call_method, method, *args, method_name=data["name"]
                )
        except Exception as e:
            traceback_error = traceback.format_exc()
            logger.error("error during calling method: %s", traceback_error)
            self._connection.emit({"type": "error", "message": traceback_error})
            if reject:
                reject(traceback_error)

    def _handle_callback(self, data):
        reject = None
        try:
            if "promise" in data:
                resolve, reject = self.unwrap(data["promise"], False)
                method = self._store.fetch(data["id"])
                if method is None:
                    raise Exception(
                        "Callback function can only called once, "
                        "if you want to call a function for multiple times, "
                        "please make it as a plugin api function. "
                        "See https://imjoy.io/docs for more details."
                    )
                args = self.unwrap(data["args"], True)
                self._run_with_context(
                    self._call_method,
                    method,
                    *args,
                    resolve=resolve,
                    reject=reject,
                    method_name=data["id"]
                )

            else:
                method = self._store.fetch(data["id"])
                if method is None:
                    raise Exception(
                        "Callback function can only called once, "
                        "if you want to call a function for multiple times, "
                        "please make it as a plugin api function. "
                        "See https://imjoy.io/docs for more details."
                    )
                args = self.unwrap(data["args"], True)
                self._run_with_context(
                    self._call_method, method, *args, method_name=data["id"]
                )
        except Exception as e:
            traceback_error = traceback.format_exc()
            logger.error("error when calling callback function: %s", traceback_error)
            self._connection.emit({"type": "error", "message": traceback_error})
            if reject:
                reject(traceback_error)

    def wrap(self, args):
        """Wrap arguments."""
        wrapped = self._encode(args)
        return wrapped

    def _encode(self, a_object, as_interface=False, object_id=None):
        """Encode object."""
        if isinstance(a_object, (int, float, bool, str, bytes)) or a_object is None:
            return a_object

        if callable(a_object):
            if as_interface:
                if not object_id:
                    raise Exception("object_id is not specified.")
                b_object = {
                    "_rtype": "interface",
                    "_rintf": object_id,
                    "_rvalue": as_interface,
                }
                try:
                    self._method_weakmap[a_object] = b_object
                except:
                    pass
            elif a_object in self._method_weakmap:
                b_object = self._method_weakmap[a_object]
            else:
                cid = self._store.put(a_object)
                b_object = {
                    "_rtype": "callback",
                    "_rvalue": cid,
                }
            return b_object

        if isinstance(a_object, tuple):
            a_object = list(a_object)
        # skip if already encoded
        if isinstance(a_object, dict) and "_rtype" in a_object:
            return a_object

        isarray = isinstance(a_object, list)
        b_object = None

        encoded_obj = None
        for tp in self._codecs:
            codec = self._codecs[tp]
            if codec.encoder and isinstance(a_object, codec.type):
                # TODO: what if multiple encoders found
                encoded_obj = codec.encoder(a_object)
                if isinstance(encoded_obj, dict) and "_rtype" not in encoded_obj:
                    encoded_obj["_rtype"] = codec.name
                elif (
                    isinstance(encoded_obj, dict)
                    and "_rtype" in encoded_obj
                    and encoded_obj["_rtype"] != codec.name
                ):
                    raise Exception(
                        "The encoded object cannot have a different _rtype({}) than the codec name({}).".format(
                            encoded_obj["_rtype"], codec.name
                        )
                    )
                b_object = encoded_obj
                return b_object

        if NUMPY and isinstance(a_object, (NUMPY.ndarray, NUMPY.generic)):
            v_bytes = a_object.tobytes()
            b_object = {
                "_rtype": "ndarray",
                "_rvalue": v_bytes,
                "_rshape": a_object.shape,
                "_rdtype": str(a_object.dtype),
            }
        elif isinstance(a_object, Exception):
            b_object = {"_rtype": "error", "_rvalue": str(a_object)}
        elif isinstance(a_object, memoryview):
            b_object = {"_rtype": "memoryview", "_rvalue": a_object.tobytes()}
        elif isinstance(
            a_object, (io.IOBase, io.TextIOBase, io.BufferedIOBase, io.RawIOBase)
        ):
            b_object = {
                "_rtype": "blob",
                "_rvalue": a_object.read(),
                "_rmime": "application/octet-stream",
            }
        # NOTE: "typedarray" is not used
        elif isinstance(a_object, OrderedDict):
            b_object = {
                "_rtype": "orderedmap",
                "_rvalue": self._encode(list(a_object), as_interface),
            }
        elif isinstance(a_object, set):
            b_object = {
                "_rtype": "set",
                "_rvalue": self._encode(list(a_object), as_interface),
            }
        elif hasattr(a_object, "_rintf") and a_object._rintf == True:
            b_object = self._encode(a_object, true)
        elif isinstance(a_object, (list, dict, dotdict)) or inspect.isclass(
            type(a_object)
        ):
            b_object = [] if isarray else {}
            if not isinstance(a_object, (list, dict, dotdict)) and inspect.isclass(
                type(a_object)
            ):
                a_object_norm = {
                    a: getattr(a_object, a)
                    for a in dir(a_object)
                    if not a.startswith("_")
                }
                # always encode class instance as interface
                as_interface = True
            else:
                a_object_norm = a_object

            keys = range(len(a_object_norm)) if isarray else a_object_norm.keys()
            # encode interfaces
            if (not isarray and a_object_norm.get("_rintf")) or as_interface:
                if object_id is None:
                    object_id = str(uuid.uuid4())
                    self._object_store[object_id] = a_object

                for key in keys:
                    if isinstance(key, str) and key.startswith("_"):
                        continue
                    encoded = self._encode(
                        a_object_norm[key],
                        as_interface + "." + str(key)
                        if isinstance(as_interface, str)
                        else key,
                        object_id,
                    )
                    if isarray:
                        b_object.append(encoded)
                    else:
                        b_object[key] = encoded
                # TODO: how to despose list object? create a wrapper for list?
                if not isarray:
                    b_object["_rintf"] = object_id
                # remove interface when closed
                if "on" in a_object_norm and callable(a_object_norm["on"]):

                    def remove_interface():
                        del self._object_store[object_id]

                    a_object_norm["on"]("close", remove_interface)
            else:
                for key in keys:
                    if isarray:
                        b_object.append(self._encode(a_object_norm[key]))
                    else:
                        b_object[key] = self._encode(a_object_norm[key])
        else:
            raise Exception("imjoy-rpc: Unsupported data type:" + str(aObject))

        return b_object

    def unwrap(self, args, with_promise):
        """Unwrap arguments."""
        # wraps each callback so that the only one could be called
        result = self._decode(args, with_promise)
        return result

    def _decode(self, a_object, with_promise):
        """Decode object."""
        if a_object is None:
            return a_object
        if isinstance(a_object, dict) and "_rtype" in a_object:
            b_object = None
            if (
                self._codecs.get(a_object["_rtype"])
                and self._codecs[a_object["_rtype"]].decoder
            ):
                b_object = self._codecs[a_object["_rtype"]].decoder(a_object)
            elif a_object["_rtype"] == "callback":
                b_object = self._gen_remote_callback(a_object["_rvalue"], with_promise)
            elif a_object["_rtype"] == "interface":
                b_object = self._gen_remote_method(
                    a_object["_rvalue"], a_object["_rintf"]
                )
            elif a_object["_rtype"] == "ndarray":
                # create build array/tensor if used in the plugin
                try:
                    if isinstance(a_object["_rvalue"], (list, tuple)):
                        a_object["_rvalue"] = reduce(
                            (lambda x, y: x + y), a_object["_rvalue"]
                        )
                    elif not isinstance(a_object["_rvalue"], bytes):
                        raise Exception(
                            "Unsupported data type: " + str(type(a_object["_rvalue"]))
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
            elif a_object["_rtype"] == "memoryview":
                b_object = memoryview(a_object["_rvalue"])
            elif a_object["_rtype"] == "blob":
                if isinstance(a_object["_rvalue"], str):
                    b_object = io.StringIO(a_object["_rvalue"])
                elif isinstance(a_object["_rvalue"], bytes):
                    b_object = io.BytesIO(a_object["_rvalue"])
                else:
                    raise Exception(
                        "Unsupported blob value type: " + str(type(a_object["_rvalue"]))
                    )
            elif a_object["_rtype"] == "typedarray":
                if NUMPY:
                    b_object = NUMPY.frombuffer(
                        a_object["_rvalue"], dtype=a_object["_rdtype"]
                    )
                else:
                    b_object = a_object["_rvalue"]
            elif a_object["_rtype"] == "orderedmap":
                b_object = OrderedDict(self._decode(a_object["_rvalue"], with_promise))
            elif a_object["_rtype"] == "set":
                b_object = set(self._decode(a_object["_rvalue"], with_promise))
            elif a_object["_rtype"] == "error":
                b_object = Exception(a_object["_rvalue"])
            else:
                b_object = a_object
        elif isinstance(a_object, (dict, list, tuple)):
            if isinstance(a_object, tuple):
                a_object = list(a_object)
            isarray = isinstance(a_object, list)
            b_object = [] if isarray else dotdict()
            keys = range(len(a_object)) if isarray else a_object.keys()
            for key in keys:
                val = a_object[key]
                if isarray:
                    b_object.append(self._decode(val, with_promise))
                else:
                    b_object[key] = self._decode(val, with_promise)
        else:
            b_object = a_object

        # object id, used for dispose the object
        if isinstance(a_object, dict) and a_object.get("_rintf"):
            # make the dict hashable
            if isinstance(b_object, dict) and not isinstance(b_object, dotdict):
                b_object = dotdict(b_object)
            self._object_weakmap[b_object] = a_object.get("_rintf")
        return b_object
