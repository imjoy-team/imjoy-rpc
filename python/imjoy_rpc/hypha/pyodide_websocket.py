"""Provide a pyodide websocket."""
import asyncio
import inspect
import pyodide  # noqa: F401
from js import WebSocket


class PyodideWebsocketRPCConnection:
    """Represent a pyodide websocket RPC connection."""

    def __init__(
        self, server_url, client_id, workspace=None, token=None, logger=None, timeout=5
    ):
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
        self._logger = logger
        self._timeout = timeout

    def on_message(self, handler):
        """Register a message handler."""
        self._handle_message = handler
        self._is_async = inspect.iscoroutinefunction(handler)

    async def open(self):
        """Open the connection."""
        self._websocket = WebSocket.new(self._server_url)
        self._websocket.binaryType = "arraybuffer"

        def onmessage(evt):
            """Handle event."""
            data = evt.data.to_py().tobytes()
            self._handle_message(data)

        self._websocket.onmessage = onmessage

        fut = asyncio.Future()

        def closed(evt):
            """Handle closed event."""
            if self._logger:
                self._logger.info("websocket closed")
            self._websocket = None

        self._websocket.onclose = closed

        def opened(evt):
            """Handle opened event."""
            fut.set_result(None)

        self._websocket.onopen = opened
        return await asyncio.wait_for(fut, timeout=self._timeout)

    async def emit_message(self, data):
        """Emit a message."""
        assert self._handle_message, "No handler for message"
        if not self._websocket:
            await self.open()
        try:
            data = pyodide.to_js(data)
            self._websocket.send(data)
        except Exception as exp:
            #   data = msgpack_unpackb(data);
            if self._logger:
                self._logger.error("Failed to send data, error: %s", exp)
            print("Failed to send data, error: %s", exp)
            raise

    async def disconnect(self, reason):
        """Disconnect."""
        ws = self._websocket
        self._websocket = None
        if ws:
            ws.close(1000, reason)
        if self._logger:
            self._logger.info("Websocket connection disconnected (%s)", reason)
