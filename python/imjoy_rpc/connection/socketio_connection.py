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

connection_id = contextvars.ContextVar("connection_id")


class SocketIOManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
        self._on_ready_callback = None

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

    def init(self, config=None):
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def start(self, url, token=None, on_ready_callback=None):
        sio = socketio.AsyncClient()
        self.url = url
        self.client_params = {
            "headers": {"Authorization": f"Bearer {token}"} if token else {},
            "socketio_path": "/rtc/socket.io/",
        }
        self._on_ready_callback = on_ready_callback

        def registered(config):
            client_id = str(uuid.uuid4())
            self._create_new_connection(sio, config["plugin_id"], client_id)

        @sio.event
        async def connect():
            logger.info('connected to the server')
            await sio.emit("register_plugin", self.default_config, callback=registered)

        self.sio = sio
        asyncio.ensure_future(self.sio.connect(self.url, **self.client_params))

    def _create_new_connection(self, sio, plugin_id, client_channel):
        connection_id.set(client_channel)
        connection = SocketioConnection(
            self.default_config, sio, plugin_id, client_channel
        )

        def initialize(data):
            config = self.default_config.copy()
            cfg = self.default_config
            if cfg.get("credential_required") is not None:
                result = config["verify_credential"](cfg["credential"])
                cfg["auth"] = result["auth"]
            cfg["id"] = config.get("id")
            rpc = RPC(
                connection,
                self.rpc_context,
                config=cfg,
                codecs=self._codecs,
            )
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                api = rpc.get_remote() or dotdict()
                api.init = self.init
                api.export = self.set_interface
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)
            
            if self._on_ready_callback:
                def ready(_):
                    self._on_ready_callback(None)
                def error(detail):
                    self._on_ready_callback(detail or 'Error')
                rpc.once("interfaceSetAsRemote", ready)
                rpc.once("disconnected", error)
                rpc.on("error", error)

            self.clients[client_channel] = dotdict()
            self.clients[client_channel].rpc = rpc

        if self._on_ready_callback:
            def error(detail):
                self._on_ready_callback(detail or 'Error')
            connection.once("disconnected", error)
            connection.once("error", error)

        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )
        logger.info("imjoyRPCReady (peer_id: %s)", connection.peer_id)


class SocketioConnection(MessageEmitter):
    def __init__(self, config, sio, plugin_id, client_channel):
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.sio = sio
        self.peer_id = client_channel
        self.client_channel = client_channel
        self.plugin_id = plugin_id

        @sio.event
        def plugin_message(data):
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

    def _msg_callback(self, data):
        if not data.get('success'):
            self._fire('error', data.get('detail'))

    def emit(self, msg):
        msg['plugin_id'] = self.plugin_id
        asyncio.ensure_future(self.sio.emit("plugin_message", msg, callback=self._msg_callback))
