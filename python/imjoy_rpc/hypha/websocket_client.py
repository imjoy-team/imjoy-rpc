"""Provide a websocket client."""
import asyncio
import inspect
import logging
import sys

import msgpack
import shortuuid

from .rpc import RPC

try:
    import js  # noqa: F401
    import pyodide  # noqa: F401

    from .pyodide_websocket import PyodideWebsocketRPCConnection

    def custom_exception_handler(loop, context):
        """Handle exceptions."""
        pass

    # Patch the exception handler to avoid the default one
    asyncio.get_event_loop().set_exception_handler(custom_exception_handler)

    IS_PYODIDE = True
except ImportError:
    import websockets

    IS_PYODIDE = False

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("websocket-client")
logger.setLevel(logging.WARNING)

MAX_RETRY = 10000


class WebsocketRPCConnection:
    """Represent a websocket connection."""

    def __init__(self, server_url, client_id, workspace=None, token=None, timeout=5):
        """Set up instance."""
        self._websocket = None
        self._handle_message = None
        assert server_url and client_id
        server_url = server_url + f"?client_id={client_id}"
        if workspace is not None:
            server_url += f"&workspace={workspace}"
        if token:
            server_url += f"&token={token}"
        self._server_url = server_url
        self._reconnection_token = None
        self._listen_task = None
        self._timeout = timeout
        self._opening = False
        self._retry_count = 0
        self._closing = False

    def on_message(self, handler):
        """Handle message."""
        self._handle_message = handler
        self._is_async = inspect.iscoroutinefunction(handler)

    def set_reconnection_token(self, token):
        """Set reconnect token."""
        self._reconnection_token = token

    async def open(self):
        """Open the connection."""
        try:
            if self._opening:
                return await self._opening

            self._opening = asyncio.get_running_loop().create_future()
            server_url = (
                (self._server_url + f"&reconnection_token={self._reconnection_token}")
                if self._reconnection_token
                else self._server_url
            )
            logger.info("Creating a new connection to %s", server_url.split("?")[0])
            self._websocket = await asyncio.wait_for(
                websockets.connect(server_url), self._timeout
            )
            self._listen_task = asyncio.ensure_future(self._listen())
            self._opening.set_result(True)
            self._retry_count = 0
        except Exception as exp:
            if hasattr(exp, "status_code") and exp.status_code == 403:
                self._opening.set_exception(
                    PermissionError(f"Permission denied for {server_url}, error: {exp}")
                )
                # stop retrying
                self._retry_count = MAX_RETRY
            else:
                self._retry_count += 1
                self._opening.set_exception(
                    Exception(
                        f"Failed to connect to {server_url.split('?')[0]} (retry {self._retry_count}/{MAX_RETRY}): {exp}"
                    )
                )
        finally:
            if self._opening:
                await self._opening
                self._opening = None

    async def emit_message(self, data):
        """Emit a message."""
        assert self._handle_message is not None, "No handler for message"
        if not self._websocket or self._websocket.closed:
            await self.open()
        try:
            await self._websocket.send(data)
        except Exception:
            data = msgpack.unpackb(data)
            logger.exception(f"Failed to send data to {data['to']}")
            raise

    async def _listen(self):
        """Listen to the connection."""
        while True:
            if self._closing:
                break
            try:
                ws = self._websocket
                while not ws.closed:
                    data = await ws.recv()
                    if self._is_async:
                        await self._handle_message(data)
                    else:
                        self._handle_message(data)
            except (
                websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosedOK,
                ConnectionAbortedError,
                ConnectionResetError,
            ):
                if not self._closing:
                    logger.warning("Connection is broken, reopening a new connection.")
                    await self.open()
                    if self._retry_count >= MAX_RETRY:
                        logger.error(
                            "Failed to connect to %s, max retry reached.",
                            self._server_url.split("?")[0],
                        )
                        break
                    await asyncio.sleep(3)  # Retry in 3 second
                else:
                    logger.info("Websocket connection closed normally")

    async def disconnect(self, reason=None):
        """Disconnect."""
        self._closing = True
        if self._websocket and not self._websocket.closed:
            await self._websocket.close(code=1000)
        if self._listen_task:
            self._listen_task.cancel()
            self._listen_task = None
        logger.info("Websocket connection disconnected (%s)", reason)


def normalize_server_url(server_url):
    """Normalize the server url."""
    if not server_url:
        raise ValueError("server_url is required")

    if server_url.startswith("http://"):
        server_url = server_url.replace("http://", "ws://").rstrip("/") + "/ws"
    elif server_url.startswith("https://"):
        server_url = server_url.replace("https://", "wss://").rstrip("/") + "/ws"

    return server_url


async def login(config):
    """Login to the hypha server."""
    server_url = normalize_server_url(config.get("server_url"))
    service_id = config.get("login_service_id", "public/*:hypha-login")
    timeout = config.get("login_timeout", 60)
    callback = config.get("login_callback")

    server = await connect_to_server(
        {"name": "initial login client", "server_url": server_url}
    )
    try:
        svc = await server.get_service(service_id)
        context = await svc.start()
        if callback:
            await callback(context)
        else:
            print(f"Please open your browser and login at {context['login_url']}")

        return await svc.check(context["key"], timeout)
    except Exception as error:
        raise error
    finally:
        await server.disconnect()


async def connect_to_server(config):
    """Connect to RPC via a hypha server."""
    client_id = config.get("client_id")
    if client_id is None:
        client_id = shortuuid.uuid()

    server_url = normalize_server_url(config["server_url"])

    if IS_PYODIDE:
        Connection = PyodideWebsocketRPCConnection
    else:
        Connection = WebsocketRPCConnection

    connection = Connection(
        server_url,
        client_id,
        workspace=config.get("workspace"),
        token=config.get("token"),
        timeout=config.get("method_timeout", 5),
    )
    await connection.open()
    rpc = RPC(
        connection,
        client_id=client_id,
        manager_id="workspace-manager",
        default_context={"connection_type": "websocket"},
        name=config.get("name"),
        method_timeout=config.get("method_timeout"),
        loop=config.get("loop"),
    )
    wm = await rpc.get_remote_service("workspace-manager:default")
    wm.rpc = rpc

    def export(api):
        """Export the api."""
        # Convert class instance to a dict
        if not isinstance(api, dict) and inspect.isclass(type(api)):
            api = {a: getattr(api, a) for a in dir(api)}
        api["id"] = "default"
        api["name"] = config.get("name", "default")
        return asyncio.ensure_future(rpc.register_service(api, overwrite=True))

    async def get_plugin(query):
        """Get a plugin."""
        return await wm.get_service(query + ":default")

    async def disconnect():
        """Disconnect the rpc and server connection."""
        await rpc.disconnect()
        await connection.disconnect()

    wm.export = export
    wm.get_plugin = get_plugin
    wm.list_plugins = wm.list_services
    wm.disconnect = disconnect
    wm.register_codec = rpc.register_codec

    if config.get("webrtc", False):
        from .webrtc_client import AIORTC_AVAILABLE, register_rtc_service

        if not AIORTC_AVAILABLE:
            raise Exception("aiortc is not available, please install it first.")
        await register_rtc_service(wm, client_id + "-rtc")

    if "get_service" in wm or "getService" in wm:
        _get_service = wm.get_service or wm.getService

        async def get_service(query, webrtc=None):
            assert webrtc in [
                None,
                True,
                False,
                "auto",
            ], "webrtc must be true, false or 'auto'"
            svc = await _get_service(query)
            if webrtc in [True, "auto"]:
                from .webrtc_client import AIORTC_AVAILABLE, get_rtc_service

                if ":" in svc.id and "/" in svc.id and AIORTC_AVAILABLE:
                    client = svc.id.split(":")[0]
                    try:
                        # Assuming that the client registered a webrtc service with the client_id + "-rtc"
                        peer = await get_rtc_service(
                            wm, client + ":" + client.split("/")[1] + "-rtc"
                        )
                        return await peer.get_service(svc.id.split(":")[1])
                    except Exception:
                        logger.warning(
                            "Failed to get webrtc service, using websocket connection"
                        )
                if webrtc is True:
                    if not AIORTC_AVAILABLE:
                        raise Exception(
                            "aiortc is not available, please install it first."
                        )
                    raise Exception("Failed to get the service via webrtc")
            return svc

        wm["get_service"] = get_service
        wm["getService"] = get_service
    return wm
