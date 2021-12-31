"""Provide the connection."""
import asyncio
import gzip
import logging
import math
import sys
import time
import uuid

import msgpack

from imjoy_rpc.utils import MessageEmitter, dotdict

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("core-connection")
logger.setLevel(logging.WARNING)

all_connections = {}
CHUNK_SIZE = 1024 * 1000


def send_as_msgpack(msg, send, accept_encoding):
    """Send the message by using msgpack encoding."""
    encoded = {
        "type": "msgpack_data",
        "msg_type": msg.pop("type"),
    }
    if msg.get("peer_id"):
        encoded["peer_id"] = msg.pop("peer_id")
    if msg.get("plugin_id"):
        encoded["plugin_id"] = msg.pop("plugin_id")

    packed = msgpack.packb(msg, use_bin_type=True)
    total_size = len(packed)
    if total_size > CHUNK_SIZE and "gzip" in accept_encoding:
        compressed = gzip.compress(packed)
        # Only send the compressed version
        # if the compression ratio is > 80%;
        if len(compressed) <= total_size * 0.8:
            packed = compressed
            encoded["compression"] = "gzip"

    total_size = len(packed)
    if total_size <= CHUNK_SIZE:
        encoded["data"] = packed
        asyncio.ensure_future(send(encoded))
    else:

        async def send_chunks():
            # Try to use the peer_id as key so one peer can only have one chunk store
            object_id = msg.get("peer_id", str(uuid.uuid4()))
            chunk_num = int(math.ceil(float(total_size) / CHUNK_SIZE))
            # send chunk by chunk
            for idx in range(chunk_num):
                start_byte = idx * CHUNK_SIZE
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
                await send(chunk)

            # reference the chunked object
            encoded["chunked_object"] = object_id
            await send(encoded)

        asyncio.ensure_future(send_chunks())


def decode_msgpack(data, chunk_store):
    """Try to decode the data as msgpack."""
    dtype = data.get("type")
    if dtype == "msgpack_chunk":
        id_ = data["object_id"]
        # the chunk object does not exist or it's a starting chunk
        if id_ not in chunk_store or data["index"] == 0:
            chunk_store[id_] = []
        assert data["index"] == len(chunk_store[id_])
        chunk_store[id_].append(data["data"])
        return

    if dtype == "msgpack_data":
        if data.get("chunked_object"):
            object_id = data["chunked_object"]
            chunks = chunk_store[object_id]
            del chunk_store[object_id]
            data["data"] = b"".join(chunks)
        if data.get("compression"):
            if data["compression"] == "gzip":
                data["data"] = gzip.decompress(data["data"])
            else:
                raise Exception(f"Unsupported compression: {data['compression']}")
        decoded = msgpack.unpackb(data["data"], use_list=False, raw=False)
        if data.get("plugin_id"):
            decoded["plugin_id"] = data.get("plugin_id")
        if data.get("peer_id"):
            decoded["peer_id"] = data.get("peer_id")
        decoded["type"] = data["msg_type"]
        data = decoded
    elif data.get("peer_id") in chunk_store:
        # Clear chunk store for the peer if exists
        del chunk_store[data.get("peer_id")]

    return data


class BasicConnection(MessageEmitter):
    """Represent a base connection."""

    def __init__(self, send):
        """Set up instance."""
        super().__init__(logger)
        self.plugin_config = dotdict()
        self._access_token = None
        self._expires_in = None
        self._plugin_origin = "*"
        self._refresh_token = None
        self._send = send
        self.peer_id = None
        self.on("initialized", self._initialized)
        self._chunk_store = {}
        self.accept_encoding = []

    def _initialized(self, data):
        self.plugin_config = data["config"]
        # peer_id can only be set for once
        self.peer_id = data["peer_id"]
        self._plugin_origin = data.get("origin", "*")
        all_connections[self.peer_id] = self
        if self._plugin_origin != "*":
            logger.info(
                "Connection to the imjoy-rpc peer $%s is limited to origin %s.",
                self.peer_id,
                self._plugin_origin,
            )

        if not self.peer_id:
            raise Exception("Please provide a peer_id for the connection.")

        if self.plugin_config.get("auth"):
            if self._plugin_origin == "*":
                logger.error(
                    "Refuse to transmit the token without an explicit origin, "
                    "there is a security risk that you may leak the credential "
                    "to website from other origin. "
                    "Please specify the `origin` explicitly."
                )
                self._access_token = None
                self._refresh_token = None

            if self.plugin_config["auth"]["type"] != "jwt":
                logger.error(
                    "Unsupported authentication type: %s", self.plugin_config.auth.type
                )
            else:
                self._expires_in = self.plugin_config["auth"]["expires_in"]
                self._access_token = self.plugin_config["auth"]["access_token"]
                self._refresh_token = self.plugin_config["auth"]["refresh_token"]

    def handle_message(self, data):
        """Handle a message."""
        data = decode_msgpack(data, self._chunk_store)
        if data is None:
            return

        target_id = data.get("target_id")
        if target_id and self.peer_id and target_id != self.peer_id:
            conn = all_connections[target_id]
            if conn:
                conn._fire(data["type"], data)  # pylint: disable=protected-access
            else:
                logger.warning(
                    "Connection with target_id %s not found, discarding data: %s",
                    target_id,
                    data,
                )
        else:
            if data.get("type") == "initialized":
                self.accept_encoding = data.get("accept_encoding", [])
            self._fire(data["type"], data)

    def connect(self):
        """Connect."""
        self._fire("connected")

    async def execute(self, code):
        """Execute."""
        # pylint: disable=no-self-use
        raise PermissionError

    def emit(self, msg):
        """Send a message to the plugin site."""
        if self._access_token:
            if time.time() >= self._expires_in:
                # TODO: refresh access token
                raise Exception("Refresh token is not implemented.")

            msg["access_token"] = self._access_token
        msg["peer_id"] = msg.get("peer_id") or self.peer_id
        if msg.get("type") in ["initialize"] or "msgpack" not in self.accept_encoding:
            if msg.get("type") == "initialize":
                # Notify the plugin that the server supports msgpack decoding
                msg["accept_encoding"] = ["msgpack", "gzip"]
            asyncio.ensure_future(self._send(msg))
        else:
            send_as_msgpack(msg, self._send, self.accept_encoding)

    def disconnect(self):
        """Disconnect the plugin."""
        self.emit({"type": "disconnect"})
        if self.peer_id and self.peer_id in all_connections:
            del all_connections[self.peer_id]
