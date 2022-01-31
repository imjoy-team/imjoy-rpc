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
            server_url = (
                (self._server_url + f"&reconnection_token={self._reconnection_token}")
                if self._reconnection_token
                else self._server_url
            )
            logger.info("Receating a new connection to %s", server_url.split("?")[0])
            self._websocket = await asyncio.wait_for(
                websockets.connect(server_url), self._timeout
            )
            self._listen_task = asyncio.ensure_future(self._listen(self._websocket))
        except Exception as exp:
            if hasattr(exp, "status_code") and exp.status_code == 403:
                raise PermissionError(
                    f"Permission denied for {server_url}, error: {exp}"
                )
            else:
                raise Exception(
                    f"Failed to connect to {server_url.split('?')[0]}: {exp}"
                )

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

    async def _listen(self, ws):
        """Listen to the connection."""
        try:
            while not ws.closed:
                data = await ws.recv()
                if self._is_async:
                    await self._handle_message(data)
                else:
                    self._handle_message(data)
        except websockets.exceptions.ConnectionClosedError:
            logger.warning("Connection is broken, reopening a new connection.")
            asyncio.ensure_future(self.open())
        except websockets.exceptions.ConnectionClosedOK:
            pass

    async def disconnect(self, reason=None):
        """Disconnect."""
        ws = self._websocket
        self._websocket = None
        if ws and not ws.closed:
            await ws.close(code=1000)
        if self._listen_task:
            self._listen_task.cancel()
            self._listen_task = None
        logger.info("Websocket connection disconnected (%s)", reason)


async def connect_to_server(config):
    """Connect to RPC via a websocket server."""
    client_id = config.get("client_id")
    if client_id is None:
        client_id = shortuuid.uuid()

    server_url = config["server_url"]
    if server_url.startswith("http://"):
        server_url = server_url.replace("http://", "ws://").rstrip("/") + "/ws"
    elif server_url.startswith("https://"):
        server_url = server_url.replace("https://", "wss://").rstrip("/") + "/ws"

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
    return wm
