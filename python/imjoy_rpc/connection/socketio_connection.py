"""Provide a SocketIO connection."""
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
    """Represent a SocketIO manager."""

    def __init__(self, rpc_context):
        """Set up instance."""
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}

    def get_ident(self):
        """Return identity."""
        return connection_id.get(default=None)

    def set_interface(self, interface, config=None):
        """Set the interface."""
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
        """Register codec."""
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
        """Initialize the connection."""
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def start(self, url):
        """Start."""
        sio = socketio.AsyncClient()

        def registered(config):
            """Handle registration."""

            @sio.on(config["channel"] + "-new-client")
            def on_new_client(client_info):
                """Handle a new client."""
                self._create_new_connection(
                    sio, config["channel"], client_info["channel"]
                )

        @sio.event
        async def connect():
            """Connect."""
            await sio.emit("register_plugin", {"id": sio.sid}, callback=registered)

        self.sio = sio
        asyncio.ensure_future(self.sio.connect(url))

    def _create_new_connection(self, sio, plugin_channel, client_channel):
        """Create a new connection."""
        connection_id.set(client_channel)
        connection = SocketioConnection(
            self.default_config, sio, plugin_channel, client_channel
        )

        def initialize(data):
            """Initialize connection."""
            config = self.default_config.copy()
            cfg = self.default_config
            if cfg.get("credential_required") is not None:
                result = config.verify_credential(cfg["credential"])
                cfg["auth"] = result["auth"]
            cfg["id"] = config["id"]
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                """Patch api."""
                api = rpc.get_remote() or dotdict()
                api.init = self.init
                api.export = self.set_interface
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)
            self.clients[client_channel] = dotdict()
            self.clients[client_channel].rpc = rpc

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
    """Represent a SocketIO connection."""

    def __init__(self, config, sio, plugin_channel, client_channel):
        """Set up instance."""
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.sio = sio
        self.peer_id = client_channel
        self.client_channel = client_channel
        self.plugin_channel = plugin_channel

        @sio.on(plugin_channel)
        def on_message(data):
            """Handle a message."""
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
            """Handle a connection error."""
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            """Handle disconnection."""
            self._fire("disconnected")

    def connect(self):
        """Connect."""
        self._fire("connected")

    def disconnect(self):
        """Disconnect."""
        pass

    def emit(self, msg):
        """Emit a message."""
        asyncio.ensure_future(self.sio.emit(self.plugin_channel, msg))
