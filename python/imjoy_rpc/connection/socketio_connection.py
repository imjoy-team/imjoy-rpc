import uuid
import sys
import asyncio
import socketio
import logging
from imjoy_rpc.utils import MessageEmitter, dotdict
from imjoy_rpc.rpc import RPC
import contextvars

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("SocketIOConnection")
logger.setLevel(logging.INFO)

connection_id = contextvars.ContextVar("connection_id")


class SocketIOManager:
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
        config.name = config.name or "ImJoy Plugin"
        config.allow_execution = config.allow_execution or False
        config.version = config.version or "0.1.0"
        config.api_version = config.api_version or "0.2.3"
        config.description = config.description or "[TODO: add description]"
        config.id = str(uuid.uuid4())
        self.default_config = config
        self.interface = interface
        for k in self.clients:
            self.clients[k].rpc.set_interface(interface, self.default_config)

        if config.plugin_server:
            asyncio.ensure_future(self.sio.connect(config.plugin_server))

    def register_codec(self, config):
        assert "name" in config
        assert "encoder" in config or "decoder" in config
        if "type" in config:
            for tp in list(self._codecs.keys()):
                codec = self._codecs[tp]
                if codec.type == config["type"] or tp == config["name"]:
                    logger.warn("Removing duplicated codec: " + tp)
                    del self._codecs[tp]

        self._codecs[config["name"]] = dotdict(config)

    def start(self, channel):
        sio = socketio.AsyncClient()

        @sio.on("join_rpc_channel")
        def join_rpc_channel(data):
            self._create_new_connection(sio, data["sid"])

        @sio.event
        async def connect():
            await sio.emit("register_plugin", {"id": sio.sid}, callback=registered)

        self.sio = sio
        print("plugin started.")
        loop.run_until_complete(sio.wait())

        if url:
            logger.info("connecting to %s", url)
            asyncio.ensure_future(sio.connect(url))

        if wait:
            loop = asyncio.get_event_loop()
            loop.run_until_complete(sio.wait())

    def _create_new_connection(self, sio, plugin_channel, client_channel):
        connection_id.set(client_channel)
        connection = SocketioConnection(sio, plugin_channel, client_channel)

        def initialize(data):
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
            self.clients[sid] = dotdict()
            self.clients[sid].rpc = rpc

        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )
        logger.info("imjoyRPCReady (peer_id: %s)", connection.peer_id)


# TODO: support SocketioConnection
class SocketioConnection(MessageEmitter):
    def __init__(self, config, sio):
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.sio = sio
        self.peer_id = str(uuid.uuid4())

        @sio.on("imjoy_rpc")
        def on_message(data):
            if data.get("peer_id") == self.peer_id or data.get("type") == "initialize":
                if "type" in data:
                    self._fire(data["type"], data)
            else:
                logger.warn(
                    "connection peer id mismatch {} != {}".format(
                        data.get("peer_id"), self.peer_id
                    )
                )

        @sio.event
        def connect_error():
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            self._fire("disconnected")

    def connect(self):
        self._fire("connected")

    def disconnect(self):
        pass

    def emit(self, msg):
        asyncio.ensure_future(self.sio.emit("imjoy_rpc", msg))
