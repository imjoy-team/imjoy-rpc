"""Provide a websocket client."""
import asyncio
import inspect
import logging
import sys
import json

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


class WebsocketRPCConnection:
    """Represent a websocket connection."""

    def __init__(self, server_url, client_id, workspace=None, token=None, timeout=60):
        """Set up instance."""
        self._websocket = None
        self._handle_message = None
        self._disconnect_handler = None  # Disconnection handler
        self._on_open = None  # Connection open handler
        assert server_url and client_id
        self._server_url = server_url
        self._client_id = client_id
        self._workspace = workspace
        self._token = token
        self._reconnection_token = None
        self._timeout = timeout
        self._closing = False
        self._opening = False
        self._legacy_auth = None

    def on_message(self, handler):
        """Handle message."""
        self._handle_message = handler
        self._is_async = inspect.iscoroutinefunction(handler)

    def set_reconnection_token(self, token):
        """Set reconnect token."""
        self._reconnection_token = token

    def on_disconnected(self, handler):
        """Register a disconnection event handler."""
        self._disconnect_handler = handler

    def on_open(self, handler):
        """Register a connection open event handler."""
        self._on_open = handler

    async def _attempt_connection(self, server_url, attempt_fallback=True):
        """Attempt to establish a WebSocket connection."""
        try:
            self._legacy_auth = False
            websocket = await asyncio.wait_for(
                websockets.connect(server_url), self._timeout
            )
            return websocket
        except websockets.exceptions.InvalidStatusCode as e:
            # websocket code should be 1003, but it's not available in the library
            if e.status_code == 403 and attempt_fallback:
                logger.info(
                    "Received 403 error, attempting connection with query parameters."
                )
                self._legacy_auth = True
                return await self._attempt_connection_with_query_params(server_url)
            else:
                raise

    async def _attempt_connection_with_query_params(self, server_url):
        """Attempt to establish a WebSocket connection including authentication details in the query string."""
        # Initialize an empty list to hold query parameters
        query_params_list = []

        # Add each parameter only if it has a non-empty value
        if self._client_id:
            query_params_list.append(f"client_id={self._client_id}")
        if self._workspace:
            query_params_list.append(f"workspace={self._workspace}")
        if self._token:
            query_params_list.append(f"token={self._token}")
        if self._reconnection_token:
            query_params_list.append(f"reconnection_token={self._reconnection_token}")

        # Join the parameters with '&' to form the final query string
        query_string = "&".join(query_params_list)

        # Construct the full URL by appending the query string if it's not empty
        full_url = f"{server_url}?{query_string}" if query_string else server_url

        # Attempt to establish the WebSocket connection with the constructed URL
        return await websockets.connect(full_url)

    async def open(self):
        """Open the connection with fallback logic for backward compatibility."""
        if self._closing:
            raise Exception("Connection is closing, cannot open a new connection.")
        logger.info("Creating a new connection to %s", self._server_url.split("?")[0])
        self._opening = True
        try:
            if self._websocket and not self._websocket.closed:
                await self._websocket.close(code=1000)
            self._websocket = await self._attempt_connection(self._server_url)
            # Send authentication info as the first message if connected without query params
            if not self._legacy_auth:
                auth_info = json.dumps(
                    {
                        "client_id": self._client_id,
                        "workspace": self._workspace,
                        "token": self._token,
                        "reconnection_token": self._reconnection_token,
                    }
                )
                await self._websocket.send(auth_info)
            self._listen_task = asyncio.ensure_future(self._listen())
            if self._on_open:
                asyncio.ensure_future(self._on_open(self))
        except Exception as exp:
            logger.exception("Failed to connect to %s", self._server_url.split("?")[0])
            raise
        finally:
            self._opening = False

    async def emit_message(self, data):
        """Emit a message."""
        if self._closing:
            raise Exception("Connection is closing")
        if self._opening:
            while self._opening:
                logger.info("Waiting for connection to open...")
                await asyncio.sleep(0.1)
        if (
            not self._handle_message
            or self._closing
            or not self._websocket
            or self._websocket.closed
        ):
            await self.open()

        try:
            await self._websocket.send(data)
        except Exception as exp:
            logger.exception("Failed to send message")
            raise exp

    async def _listen(self):
        """Listen to the connection and handle disconnection."""
        try:
            while not self._closing and not self._websocket.closed:
                data = await self._websocket.recv()
                try:
                    if self._is_async:
                        await self._handle_message(data)
                    else:
                        self._handle_message(data)
                except Exception as exp:
                    logger.exception("Failed to handle message: %s", data)
        except Exception as e:
            logger.warning("Connection closed or error occurred: %s", str(e))
            if self._disconnect_handler:
                await self._disconnect_handler(self, str(e))
            logger.info("Reconnecting to %s", self._server_url.split("?")[0])
            await self.open()

    async def disconnect(self, reason=None):
        """Disconnect."""
        self._closing = True
        if self._websocket and not self._websocket.closed:
            await self._websocket.close(code=1000)
        if self._listen_task:
            self._listen_task.cancel()
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
    service_id = config.get("login_service_id", "public/*:hypha-login")
    timeout = config.get("login_timeout", 60)
    callback = config.get("login_callback")

    server = await connect_to_server(
        {
            "name": "initial login client",
            "server_url": config.get("server_url"),
            "method_timeout": timeout,
        }
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
        timeout=config.get("method_timeout", 60),
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
    wm.on_disconnected = connection.on_disconnected
    wm.on_open = connection.on_open

    if config.get("webrtc", False):
        from .webrtc_client import AIORTC_AVAILABLE, register_rtc_service

        if not AIORTC_AVAILABLE:
            raise Exception("aiortc is not available, please install it first.")
        await register_rtc_service(wm, client_id + "-rtc", config.get("webrtc_config"))

    if "get_service" in wm or "getService" in wm:
        _get_service = wm.get_service or wm.getService

        async def get_service(query, webrtc=None, webrtc_config=None):
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
                            wm,
                            client + ":" + client.split("/")[1] + "-rtc",
                            webrtc_config,
                        )
                        rtc_svc = await peer.get_service(svc.id.split(":")[1])
                        rtc_svc._webrtc = True
                        rtc_svc._peer = peer
                        rtc_svc._service = svc
                        return rtc_svc
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
