"""Provide a webrtc client."""
import asyncio
import inspect
import logging
from functools import partial

import shortuuid
from imjoy_rpc.hypha import RPC

logger = logging.getLogger("rtc-client")
try:
    from aiortc import (
        RTCConfiguration,
        RTCIceServer,
        RTCPeerConnection,
        RTCSessionDescription,
    )

    AIORTC_AVAILABLE = True
except ImportError:
    AIORTC_AVAILABLE = False
    logger.info("aiortc is not installed, please install it to use webrtc client.")


class WebRTCConnection:
    """
    A class representing a webrtc RPC connection.

    Attributes:
    ----------
    _data_channel: Object
        An instance of data channel.

    _handle_message: Function
        The function to handle incoming messages.

    _logger: Object
        Logger object to log info, warnings and errors.

    _timeout: Int
        The timeout for the connection.
    """

    def __init__(self, data_channel, logger=None):
        """Initialize WebRTCConnection."""
        self._data_channel = data_channel
        self._handle_message = None
        self._logger = logger
        self._data_channel.on("message", self.handle_message)
        self._data_channel.on("close", self.closed)

    def handle_message(self, data):
        """Register a message handler."""
        if self._handle_message is not None:
            self._handle_message(data)

    def closed(self):
        """Handle closed event."""
        if self._logger:
            self._logger.info("websocket closed")
        self._data_channel = None

    def on_message(self, handler):
        """Register a message handler."""
        self._handle_message = handler
        self._is_async = inspect.iscoroutinefunction(handler)

    async def emit_message(self, data):
        """Emit a message."""
        if self._handle_message is None:
            raise Exception("No handler for message")

        try:
            self._data_channel.send(data)
        except Exception as exp:
            if self._logger:
                self._logger.error("Failed to send data, error: %s", exp)
            raise

    async def disconnect(self, reason=None):
        """Disconnect."""
        self._data_channel = None
        if self._logger:
            self._logger.info("Data channel connection disconnected (%s)", reason)


async def _setup_rpc(config):
    """Setup the RPC connection."""
    assert config.get("channel"), "No channel provided"
    assert config.get("workspace"), "No workspace provided"
    channel = config["channel"]
    client_id = config.get("client_id", shortuuid.uuid())
    connection = WebRTCConnection(
        channel,
        logger=config.get("logger"),
    )
    config["context"] = config.get("context") or {}
    config["context"]["connection_type"] = "webrtc"
    rpc = RPC(
        connection,
        client_id=client_id,
        manager_id=None,
        default_context=config["context"],
        name=config.get("name"),
        method_timeout=config.get("method_timeout", 10.0),
        loop=config.get("loop"),
        workspace=config["workspace"],
    )
    return rpc


async def _create_offer(params, server=None, config=None, on_init=None, context=None):
    """Create RTC offer."""
    config = config or {}
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    if config.get("ice_servers"):
        iceServers = [RTCIceServer(**server) for server in config["ice_servers"]]
    else:
        iceServers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
    pc = RTCPeerConnection(
        configuration=RTCConfiguration(
            iceServers=iceServers,
        )
    )
    if server:

        @pc.on("datachannel")
        async def on_datachannel(channel):
            ctx = None
            if context:
                ctx = {"user": context["user"]}
            rpc = await _setup_rpc(
                {
                    "channel": channel,
                    "client_id": channel.label,
                    "workspace": server.config["workspace"],
                    "context": ctx,
                }
            )
            # Map all the local services to the webrtc client
            rpc._services = server.rpc._services

    if on_init:
        await on_init(pc)
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
        "workspace": server.config["workspace"],
    }


async def get_rtc_service(server, service_id, config=None):
    """Get RTC service."""
    assert AIORTC_AVAILABLE, (
        "aiortc is not installed, please install it via "
        "`pip install aiortc` to use webrtc services."
    )
    config = config or {}
    config["peer_id"] = config.get("peer_id", shortuuid.uuid())
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    try:
        svc = await server.get_service(service_id)
        if config.get("ice_servers"):
            iceServers = [RTCIceServer(**server) for server in config["ice_servers"]]
        else:
            iceServers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
        pc = RTCPeerConnection(
            configuration=RTCConfiguration(
                iceServers=iceServers,
            )
        )
        dc = pc.createDataChannel(config["peer_id"])

        @dc.on("close")
        def on_close():
            logger.info("Data channel closed")
            if fut.done():
                return
            fut.set_exception(Exception("data channel closed"))

        @dc.on("open")
        async def on_open():
            config["channel"] = dc
            config["workspace"] = server.config["workspace"]
            rpc = await _setup_rpc(config)
            pc.rpc = rpc

            async def get_service(name):
                return await rpc.get_remote_service(config["peer_id"] + ":" + name)

            async def disconnect():
                await rpc.disconnect()
                await pc.close()

            pc.get_service = get_service
            pc.getService = get_service
            pc.disconnect = disconnect
            pc.register_codec = rpc.register_codec
            pc.registerCodec = rpc.register_codec
            fut.set_result(pc)
            logger.info("Webrtc-based RPC connection established")

        @pc.on("connectionstatechange")
        def on_connectionstatechange():
            if pc.connectionState == "failed":
                logger.error("Connection failed")
                pc.close()

        if config.get("on_init"):
            await config["on_init"](pc)
            del config["on_init"]

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        answer = await svc.offer(
            {
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type,
            }
        )
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
        )
    except Exception as e:
        fut.set_exception(e)
    return await fut


async def register_rtc_service(server, service_id, config=None):
    """Register RTC service."""
    assert AIORTC_AVAILABLE, (
        "aiortc is not installed, please install it via "
        "`pip install aiortc` to use webrtc services."
    )
    config = config or {
        "visibility": "protected",
        "require_context": True,
    }
    on_init = config.get("on_init")
    if on_init:
        del config["on_init"]
    await server.register_service(
        {
            "id": service_id,
            "config": config,
            "offer": partial(
                _create_offer, config=config, server=server, on_init=on_init
            ),
        }
    )
