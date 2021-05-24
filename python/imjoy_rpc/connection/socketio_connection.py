"""Provide a SocketIO connection."""
import asyncio
import contextvars
import logging
import sys
import uuid
from urllib.parse import urlparse

import socketio

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict

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
        config.id = str(uuid.uuid4())
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

    def start(
        self,
        url,
        token=None,
        on_ready_callback=None,
        on_error_callback=None,
    ):
        """Start."""
        sio = socketio.AsyncClient()
        self.url = url
        socketio_path = urlparse(url).path.rstrip("/") + "/socket.io"
        self.client_params = {
            "headers": {"Authorization": f"Bearer {token}"} if token else {},
            "socketio_path": socketio_path,
        }

        def registered(config):
            """Handle registration."""
            if config.get("success"):
                client_id = str(uuid.uuid4())
                self._create_new_connection(
                    sio,
                    config["plugin_id"],
                    client_id,
                    on_ready_callback,
                    on_error_callback,
                )
            else:
                logger.error(config.get("detail"))
                if on_error_callback:
                    on_error_callback(config.get("detail"))
                raise Exception(f"Failed to register plugin: {config.get('detail')}")

        @sio.event
        async def connect():
            """Handle connected."""
            logger.info("connected to the server")
            await sio.emit("register_plugin", self.default_config, callback=registered)

        self.sio = sio
        fut = asyncio.ensure_future(self.sio.connect(self.url, **self.client_params))

        def check_error(_):
            try:
                fut.result()
            except Exception as ex:
                if on_error_callback:
                    on_error_callback(ex)

        fut.add_done_callback(check_error)

    def _create_new_connection(
        self, sio, plugin_id, client_channel, on_ready_callback, on_error_callback
    ):
        connection_id.set(client_channel)
        connection = SocketioConnection(
            self.default_config, sio, plugin_id, client_channel
        )

        def initialize(data):
            """Initialize connection."""
            config = self.default_config.copy()
            cfg = self.default_config
            if cfg.get("credential_required") is not None:
                result = config["verify_credential"](cfg["credential"])
                cfg["auth"] = result["auth"]

            cfg["id"] = config.get("id")
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                """Patch api."""
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

            self.clients[client_channel] = dotdict()
            self.clients[client_channel].rpc = rpc

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
        logger.info("imjoyRPCReady (peer_id: %s)", connection.peer_id)


class SocketioConnection(MessageEmitter):
    """Represent a SocketIO connection."""

    def __init__(self, config, sio, plugin_id, client_channel):
        """Set up instance."""
        self.config = dotdict(config or {})
        super().__init__(logger)

        self.peer_id = client_channel
        self.client_channel = client_channel
        self.plugin_id = plugin_id

        self.sio = sio

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
            """Handle a connection error."""
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            """Handle disconnection."""
            self.disconnect()
            self._fire("disconnected")

    def connect(self):
        """Connect."""
        self._fire("connected")

    def disconnect(self):
        """Disconnect."""
        asyncio.ensure_future(self.sio.disconnect())

    def _msg_callback(self, data):
        if not data.get("success"):
            self._fire("error", data.get("detail"))

    def emit(self, msg):
        """Emit a message."""
        msg["plugin_id"] = self.plugin_id
        asyncio.ensure_future(
            self.sio.emit("plugin_message", msg, callback=self._msg_callback)
        )
