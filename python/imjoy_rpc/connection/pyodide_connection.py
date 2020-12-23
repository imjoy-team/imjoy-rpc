import uuid
import sys
import logging
import re
import heapq
import asyncio
import time
import traceback

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict
import contextvars

import js

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("Pyodide Connection")

connection_id = contextvars.ContextVar("connection_id")


class EventSimulator(asyncio.AbstractEventLoop):
    """A simple event-driven simulator, using async/await
    Adapted from the Gist made by @damonjw
    https://gist.github.com/damonjw/35aac361ca5d313ee9bf79e00261f4ea
    """

    def __init__(self, debug=False):
        self._running = False
        self._immediate = []
        self._scheduled = []
        self._futures = []
        self._exc = None
        self._setup_timeout_promise()
        self._next_handle = None
        self._debug = debug

    def _setup_timeout_promise(self):
        js.eval(
            """
        // check if in a web-worker
        if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
            self._timeoutPromise = function(time){return new Promise((resolve)=>{setTimeout(resolve, time);});}
        } else {
            window._timeoutPromise = function(time){return new Promise((resolve)=>{setTimeout(resolve, time);});}
        }
        """
        )
        self.timeout_promise = js._timeoutPromise

    def get_debug(self):
        return self._debug

    def time(self):
        return time.time()

    def run_forever(self):
        self._running = True
        try:
            self._do_tasks()
            # execute for every 10ms (or longer)
            self.timeout_promise(10).then(lambda x: self.run_forever())
        except Exception as exp:
            self._running = False
            raise exp

    def run_until_complete(self, future):
        asyncio.ensure_future(future)
        if self._running:
            return
        self._do_tasks(until_complete=True)

    def _do_tasks(self, until_complete=False):
        while len(self._immediate) > 0:
            h = self._immediate[0]
            self._immediate = self._immediate[1:]
            if not h._cancelled:
                h._run()
            if self._exc is not None:
                raise self._exc

        if self._next_handle is not None:
            if self._next_handle._cancelled:
                self._next_handle = None

        if self._scheduled and self._next_handle is None:
            h = heapq.heappop(self._scheduled)
            h._scheduled = True
            self._next_handle = h

        if self._next_handle is not None and self._next_handle._when <= self.time():
            h = self._next_handle
            self._next_handle = None
            self._immediate.append(h)

        if until_complete and (
            self._immediate or self._scheduled or self._next_handle or self._futures
        ):
            self.timeout_promise(10).then(lambda x: self._do_tasks(until_complete))

    def _timer_handle_cancelled(self, handle):
        pass

    def is_running(self):
        return self._running

    def is_closed(self):
        return not self._running

    def stop(self):
        self._running = False

    def close(self):
        self._running = False

    def shutdown_asyncgens(self):
        pass

    def call_exception_handler(self, context):
        self._exc = context.get("exception", None)

    def call_soon(self, callback, *args, **kwargs):
        h = asyncio.Handle(callback, args, self)
        self._immediate.append(h)
        return h

    def call_later(self, delay, callback, *args):
        if delay < 0:
            raise Exception("Can't schedule in the past")
        return self.call_at(self.time() + delay, callback, *args)

    def call_at(self, when, callback, *args):
        if when < self.time():
            raise Exception("Can't schedule in the past")
        h = asyncio.TimerHandle(when, callback, args, self)
        heapq.heappush(self._scheduled, h)
        h._scheduled = True  # perhaps just for debugging in asyncio.TimerHandle?
        return h

    def create_task(self, coro):
        async def wrapper():
            try:
                await coro
            except Exception as e:
                print("Wrapped exception")
                self._exc = e

        return asyncio.Task(wrapper(), loop=self)

    def create_future(self):
        fut = asyncio.Future(loop=self)

        def remove_fut(*args):
            self._futures.remove(fut)

        fut.add_done_callback(remove_fut)
        self._futures.append(fut)
        return fut


class PyodideConnectionManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
        self.rpc_id = "pyodide_rpc"
        self.default_config["allow_execution"] = True

        # Set the event loop for RPC
        # This is needed because Pyodide does not support the default loop of asyncio
        loop = EventSimulator()
        asyncio.set_event_loop(loop)
        # This will not block, because we used setTimeout to execute it
        loop.run_forever()

    def get_ident(self):
        return connection_id.get(default=None)

    def set_interface(self, interface, config=None):
        config = config or self.default_config
        config = dotdict(config)
        config.name = config.name or "Pyodide"
        config.allow_execution = config.allow_execution or False
        config.version = config.version or "0.1.0"
        config.api_version = config.api_version or "0.2.3"
        config.description = config.description or "[TODO: add description]"
        config.id = self.rpc_id
        self.default_config = config
        self.interface = interface
        for k in self.clients:
            self.clients[k].rpc.set_interface(interface, self.default_config)

    def register_codec(self, config):
        assert "name" in config
        assert "encoder" in config or "decoder" in config
        if "type" in config:
            for tp in list(self._codecs.keys()):
                codec = self._codecs[tp]
                if codec.type == config["type"] or tp == config["name"]:
                    logger.info("Removing duplicated codec: " + tp)
                    del self._codecs[tp]

        self._codecs[config["name"]] = dotdict(config)

    def start(self, target="imjoy_rpc"):
        self._create_new_connection(target)

    def init(self, config=None):
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def _create_new_connection(self, target):
        client_id = str(uuid.uuid4())
        connection_id.set(client_id)
        connection = PyodideConnection(self.default_config)

        def initialize(data):
            self.clients[client_id] = dotdict()
            config = self.default_config.copy()
            cfg = data["config"]
            if cfg.get("credential_required") is not None:
                result = config.verify_credential(cfg["credential"])
                cfg["auth"] = result["auth"]
            cfg["id"] = self.rpc_id
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs,)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                api = rpc.get_remote() or dotdict()
                api.init = self.init
                api.export = self.set_interface
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)

            self.clients[client_id].rpc = rpc

        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )


def decode_jsproxy(obj):
    isarray = js.Array.isArray(obj)
    bobj = [] if isarray else {}
    for k in js.Object.keys(obj):
        if isinstance(obj[k], (int, float, bool, str, bytes)) or obj[k] is None:
            if isarray:
                bobj.append(obj[k])
            else:
                bobj[k] = obj[k]
        elif str(type(obj[k])) == "<class 'JsProxy'>":
            if isarray:
                bobj.append(decode_jsproxy(obj[k]))
            else:
                bobj[k] = decode_jsproxy(obj[k])
        elif str(type(obj[k])) == "<class 'memoryview'>":
            if isarray:
                bobj.append(obj[k].tobytes())
            else:
                bobj[k] = obj[k].tobytes()
        else:
            logger.warn(
                "Skipping decoding object %s with type %s",
                str(obj[k]),
                str(type(obj[k])),
            )

    return bobj


def wrap_promise(promise):
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    promise.then(fut.set_result).catch(fut.set_exception)
    return fut


def install_requirements(requirements, resolve, reject):
    import micropip

    promises = []
    for r in requirements:
        p = micropip.install(r)
        promises.append(p)
    js.Promise.all(promises).then(resolve).catch(reject)


class PyodideConnection(MessageEmitter):
    def __init__(self, config):
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}
        self.peer_id = str(uuid.uuid4())
        self.debug = True

        def msg_cb(msg):
            data = decode_jsproxy(msg.data)
            # TODO: remove the exception for "initialize"
            if data.get("peer_id") == self.peer_id or data.get("type") == "initialize":
                if "type" in data:
                    if data["type"] == "execute":
                        self.execute(data)
                        return
                    self._fire(data["type"], data)
            else:
                logger.warn(
                    "connection peer id mismatch {} != {}".format(
                        data.get("peer_id"), self.peer_id
                    )
                )

        js.self.addEventListener("message", msg_cb)

    def execute(self, data):
        try:
            t = data["code"]["type"]
            if t == "script":
                content = data["code"]["content"]
                js.pyodide.runPython(content)
                self.emit({"type": "executed"})
            elif t == "requirements":

                def success(result):
                    self.emit({"type": "executed"})

                def fail(error):
                    self.emit({"type": "executed", "error": str(error)})

                install_requirements(data["code"]["requirements"], success, fail)
            else:
                raise Exception("unsupported type")
        except Exception as e:
            traceback_error = traceback.format_exc()
            logger.error("error during execution: %s", traceback_error)
            self.emit({"type": "executed", "error": traceback_error})

    def connect(self):
        pass

    def disconnect(self):
        pass

    def emit(self, msg):
        js.self.postMessage(msg)
