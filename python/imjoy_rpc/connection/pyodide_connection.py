import uuid
import sys
import logging
import asyncio
import traceback
import contextvars

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict


import js
from js import Array, Object

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("Pyodide Connection")

connection_id = contextvars.ContextVar("connection_id")

# TODO: this is too high, we need to find a better approach
# see here: https://github.com/iodide-project/pyodide/issues/917#issuecomment-751307819
sys.setrecursionlimit(1500)


class PyodideConnectionManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
        self.rpc_id = "pyodide_rpc"
        self.default_config["allow_execution"] = True

        loop = asyncio.get_event_loop()
        # This will not block, because we used setTimeout to execute it
        loop.run_forever()

    def get_ident(self):
        return connection_id.get(default=None)

    def set_interface(self, interface, config=None):
        config = config or self.default_config
        config = dotdict(config)
        config.id = self.rpc_id
        config.name = config.name or config.id
        config.allow_execution = config.allow_execution or False
        config.version = config.version or "0.1.0"
        config.api_version = config.api_version or "0.2.3"
        config.description = config.description or "[TODO: add description]"

        self.default_config = config
        self.interface = interface
        futures = []
        for k in self.clients:
            fut = self.clients[k].rpc.set_interface(interface, self.default_config)
            futures.append(fut)
        return asyncio.gather(*futures)

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

    def start(self, target="imjoy_rpc", on_ready_callback=None, on_error_callback=None):
        try:
            self._create_new_connection(target, on_ready_callback, on_error_callback)
        except Exception as ex:
            if on_error_callback:
                on_error_callback(ex)
            raise ex

    def init(self, config=None):
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def _create_new_connection(self, target, on_ready_callback, on_error_callback):
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
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                api = rpc.get_remote() or dotdict()
                api.init = self.init
                api.export = self.set_interface
                api.dispose = rpc.disconnect
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)

            if on_ready_callback:

                def ready(_):
                    on_ready_callback(rpc.get_remote())

                rpc.once("interfaceSetAsRemote", ready)
            if on_error_callback:
                rpc.once("disconnected", on_error_callback)
                rpc.on("error", on_error_callback)

            self.clients[client_id].rpc = rpc

        if on_error_callback:
            connection.once("disconnected", on_error_callback)
            connection.once("error", on_error_callback)
        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )


def decode_jsproxy(aobj):
    if isinstance(aobj, (int, float, bool, str, bytes)) or aobj is None:
        return aobj
    elif str(type(aobj)) == "<class 'JsProxy'>" and aobj.typeof == "object":
        isarray = Array.isArray(aobj)
        bobj = [] if isarray else {}

        for k in Object.keys(aobj):
            if isarray:
                bobj.append(decode_jsproxy(aobj[k]))
            else:
                bobj[k] = decode_jsproxy(aobj[k])
        return bobj
    elif str(type(aobj)) == "<class 'memoryview'>":
        return aobj.tobytes()
    else:
        logger.warn(
            "Skipping decoding object %s with type %s", str(aobj), str(type(aobj))
        )
        return aobj

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


# This script template is a temporary workaround for the recursion error
# see https://github.com/iodide-project/pyodide/issues/951
script_template = """
try{
    pyodide.runPython(`%s`);
} catch(e) {
    if(e instanceof RangeError){
        console.log('Trying again due to recursion error...')
        pyodide.runPython(`%s`);
    }
    else{
        throw e
    }
}
"""


class PyodideConnection(MessageEmitter):
    def __init__(self, config):
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}
        self.peer_id = str(uuid.uuid4())
        self.debug = True
        _is_web_worker = js.eval(
            "typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope"
        )
        if _is_web_worker:
            self._post_message = js.postMessage
        else:
            self._post_message = js.eval(
                "self._post_message = (msg)=>{parent.postMessage(msg, '*')}"
            )

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
                js.eval(script_template % (content, content))
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
        self._post_message(msg)
