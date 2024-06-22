"""Provide a pyodide websocket."""
import asyncio
import inspect
from js import WebSocket
import js

try:
    from pyodide.ffi import to_js
except ImportError:
    from pyodide import to_js

local_websocket_patch = """
class LocalWebSocket {
  constructor(url, client_id, workspace) {
    this.url = url;
    this.onopen = () => {};
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onerror = () => {};
    this.client_id = client_id;
    this.workspace = workspace;
    const context = typeof window !== "undefined" ? window : self;
    const isWindow = typeof window !== "undefined";
    this.postMessage = message => {
      if (isWindow) {
        window.parent.postMessage(message, "*");
      } else {
        self.postMessage(message);
      }
    };

    this.readyState = WebSocket.CONNECTING;
    context.addEventListener(
      "message",
      event => {
        const { type, data, to } = event.data;
        if (to !== this.client_id) {
          console.debug("message not for me", to, this.client_id);
          return;
        }
        switch (type) {
          case "message":
            if (this.readyState === WebSocket.OPEN && this.onmessage) {
              this.onmessage({ data: data });
            }
            break;
          case "connected":
            this.readyState = WebSocket.OPEN;
            this.onopen(event);
            break;
          case "closed":
            this.readyState = WebSocket.CLOSED;
            this.onclose(event);
            break;
          default:
            break;
        }
      },
      false
    );

    if (!this.client_id) throw new Error("client_id is required");
    if (!this.workspace) throw new Error("workspace is required");
    this.postMessage({
      type: "connect",
      url: this.url,
      from: this.client_id,
      workspace: this.workspace
    });
  }

  send(data) {
    if (this.readyState === WebSocket.OPEN) {
      this.postMessage({
        type: "message",
        data: data,
        from: this.client_id,
        workspace: this.workspace
      });
    }
  }

  close() {
    this.readyState = WebSocket.CLOSING;
    this.postMessage({
      type: "close",
      from: this.client_id,
      workspace: this.workspace
    });
    this.onclose();
  }

  addEventListener(type, listener) {
    if (type === "message") {
      this.onmessage = listener;
    }
    if (type === "open") {
      this.onopen = listener;
    }
    if (type === "close") {
      this.onclose = listener;
    }
    if (type === "error") {
      this.onerror = listener;
    }
  }
}
"""

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
        self._client_id = client_id
        self._workspace = workspace

    def on_message(self, handler):
        """Register a message handler."""
        self._handle_message = handler
        self._is_async = inspect.iscoroutinefunction(handler)

    async def open(self):
        """Open the connection."""
        if self._server_url.startswith("wss://local-hypha-server:"):
            js.console.log("Connecting to local websocket " + self._server_url)
            LocalWebSocket = js.eval("(" + local_websocket_patch + ")")
            self._websocket = LocalWebSocket.new(self._server_url, self._client_id, self._workspace)
        else:
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

        def opened(evt=None):
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
            data = to_js(data)
            self._websocket.send(data)
        except Exception as exp:
            #   data = msgpack_unpackb(data);
            if self._logger:
                self._logger.error("Failed to send data, error: %s", exp)
            print("Failed to send data, error: %s", exp)
            raise

    async def disconnect(self, reason=None):
        """Disconnect."""
        ws = self._websocket
        self._websocket = None
        if ws:
            ws.close(1000, reason)
        if self._logger:
            self._logger.info("Websocket connection disconnected (%s)", reason)
