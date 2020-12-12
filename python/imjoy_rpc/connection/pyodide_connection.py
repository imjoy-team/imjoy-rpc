import uuid
import sys
import logging
import re

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict
import contextvars

try:
    from js import self as jsGlobal
except:
    from js import window as jsGlobal

from js import Array, Object

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("Pyodide Connection")

connection_id = contextvars.ContextVar("connection_id")


class PyodideConnectionManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}

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
        config.id = str(uuid.uuid4())
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
            cfg["id"] = config["id"]
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs,)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                api = rpc.get_remote() or dotdict()
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
    isarray = Array.isArray(obj)
    bobj = [] if isarray else {}
    for k in Object.keys(obj):
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
                    self._fire(data["type"], data)
            else:
                logger.warn(
                    "connection peer id mismatch {} != {}".format(
                        data.get("peer_id"), self.peer_id
                    )
                )

        jsGlobal.addEventListener("message", msg_cb)

    def connect(self):
        pass

    def disconnect(self):
        pass

    def emit(self, msg):
        jsGlobal.postMessage(msg)
