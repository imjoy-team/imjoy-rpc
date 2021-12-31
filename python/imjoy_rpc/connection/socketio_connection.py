"""Provide a SocketIO connection."""
import asyncio
import contextvars
import gzip
import logging
import math
import sys
import uuid
from urllib.parse import urlparse

import msgpack
import socketio

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("SocketIOConnection")

connection_id = contextvars.ContextVar("connection_id")
CHUNK_SIZE = 1024 * 512


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
        self.is_reconnect = False
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
            if not self.is_reconnect:
                logger.info("connected to the server")
                await sio.emit(
                    "register_plugin", self.default_config, callback=registered
                )
                self.is_reconnect = True
            else:
                logger.info("Skipping reconnect to the server")

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
                api.register_codec = self.register_codec
                api.dispose_object = rpc.dispose_object
                api._rpc = rpc

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
        self._chunk_store = {}
        self.accept_encoding = []

        self.sio = sio

        @sio.event
        def plugin_message(data):
            dtype = data.get("type")
            if dtype == "msgpack_chunk":
                id_ = data["object_id"]
                if id_ not in self._chunk_store:
                    self._chunk_store[id_] = []
                assert data["index"] == len(self._chunk_store[id_])
                self._chunk_store[id_].append(data["data"])
                return

            if dtype == "msgpack_data":
                if data.get("chunked_object"):
                    object_id = data["chunked_object"]
                    chunks = self._chunk_store[object_id]
                    del self._chunk_store[object_id]
                    data["data"] = b"".join(chunks)
                if data.get("compression"):
                    if data["compression"] == "gzip":
                        data["data"] = gzip.decompress(data["data"])
                    else:
                        raise Exception(
                            f"Unsupported compression: {data['compression']}"
                        )
                decoded = msgpack.unpackb(data["data"], use_list=False, raw=False)
                decoded["peer_id"] = data["peer_id"]
                decoded["type"] = data["msg_type"]
                data = decoded

            if data.get("peer_id") == self.peer_id or data.get("type") == "initialize":
                if data.get("type") == "initialize":
                    self.accept_encoding = data.get("accept_encoding", [])
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
            raise Exception("disconnected")
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
        if (
            msg.get("type") in ["initialized", "imjoyRPCReady"]
            or "msgpack" not in self.accept_encoding
        ):
            # Notify the server that the plugin supports msgpack decoding
            if msg.get("type") == "initialized":
                msg["accept_encoding"] = ["msgpack", "gzip"]
            asyncio.ensure_future(
                self.sio.emit("plugin_message", msg, callback=self._msg_callback)
            )
        else:
            encoded = {
                "type": "msgpack_data",
                "msg_type": msg.pop("type"),
                "plugin_id": msg.pop("plugin_id"),
            }
            packed = msgpack.packb(msg, use_bin_type=True)

            total_size = len(packed)
            if total_size > CHUNK_SIZE and "gzip" in self.accept_encoding:
                compressed = gzip.compress(packed)
                # Only send the compressed version
                # if the compression ratio is > 80%;
                if len(compressed) <= total_size * 0.8:
                    packed = compressed
                    encoded["compression"] = "gzip"

            total_size = len(packed)
            if total_size <= CHUNK_SIZE:
                encoded["data"] = packed
                asyncio.ensure_future(
                    self.sio.emit(
                        "plugin_message", encoded, callback=self._msg_callback
                    )
                )
            else:

                async def send_chunks():
                    object_id = str(uuid.uuid4())
                    chunk_num = int(math.ceil(float(total_size) / CHUNK_SIZE))
                    loop = asyncio.get_event_loop()
                    # send chunk by chunk
                    for idx in range(chunk_num):
                        start_byte = idx * CHUNK_SIZE
                        fut = loop.create_future()
                        chunk = {
                            "type": "msgpack_chunk",
                            "object_id": object_id,
                            "data": packed[start_byte : start_byte + CHUNK_SIZE],
                            "index": idx,
                            "total": chunk_num,
                        }
                        logger.info(
                            "Sending chunk %d/%d (%d bytes)",
                            idx + 1,
                            chunk_num,
                            total_size,
                        )
                        await self.sio.emit(
                            "plugin_message", chunk, callback=fut.set_result
                        )
                        ret = await fut
                        if not ret.get("success"):
                            self._fire("error", ret.get("detail"))
                            return
                    # reference the chunked object
                    encoded["chunked_object"] = object_id
                    await self.sio.emit(
                        "plugin_message", encoded, callback=self._msg_callback
                    )

                asyncio.ensure_future(send_chunks())
