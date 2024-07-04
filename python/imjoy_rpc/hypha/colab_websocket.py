"""
Create a hypha server in colab iframe and connect to it using a websocket proxy.

TODO: the code is not working because comm message cannot be handled while awaiting in the event loop.
"""
import asyncio
import uuid
from IPython.display import display, HTML

colab_websocket_proxy_js = """
import { HyphaServer, connectToServer } from "https://cdn.jsdelivr.net/npm/hypha-core@0.1.9/dist/hypha-core.mjs";

const hyphaServer = new HyphaServer({
  url: "https://local-hypha-server:8080"
});

hyphaServer.on("add_window", (config) => {
  const wb = new WinBox(config.name || config.src.slice(0, 128), {
    background: "#448aff",
  });
  wb.body.innerHTML = `<iframe src="${config.src}" id="${config.window_id}" style="width: 100%; height: 100%; border: none;"></iframe>`;
});

function isSerializable(object) {
  return typeof object === "object" && object && object.toJSON;
}

function isObject(value) {
  return value && typeof value === "object" && value.constructor === Object;
}

class ColabWebsocketProxy {
  constructor(url, client_id, workspace) {
    this.url = url;
    this.client_id = client_id;
    this.workspace = workspace;

    console.log('Initializing ColabWebsocketProxy with URL:', url);
    console.log('Client ID:', client_id);
    console.log('Workspace:', workspace);

    this.postMessage = (message) => {
      console.log('Posting message to kernel:', message);
      if (this.comm) {
        this.comm.send(message);
      } else {
        console.error('Comm not initialized.');
      }
    };

    this.readyState = WebSocket.CONNECTING;
    console.log('Initial readyState:', this.readyState);

    this.connect();
  }

  async connect() {
    if(this.url.startsWith('wss://local-hypha-server:')){
      console.log('Using mock websocket', this.url, hyphaServer.url)
      this.websocket = new hyphaServer.WebSocketClass(hyphaServer.wsUrl);
    }
    else{
      this.websocket = new WebSocket(this.url);
    }
    this.websocket.binaryType = "arraybuffer";
    this.websocket.onopen = (event) => {
      console.log("WebSocket connection opened");
      google.colab.kernel.comms.open(this.workspace, {}).then((comm) => {
        setTimeout(async () => {
            this.readyState = WebSocket.OPEN;
            console.log('===> WebSocket connection opened');
            for await (const msg of comm.messages) {
              const data = msg.data;
              console.log('Received message from kernel:', data);
              if (data.type === "log" || data.type === "info") {
                  console.log(data.message);
              } else if (data.type === "error") {
                  console.error(data.message);
              } else if (data.type === "message") {
                  console.log('Sending message comm', msg.buffers[0]);
                  this.send(msg.buffers[0]);
              }
            }
        }, 0);
    
        this.comm = comm;
      }).catch((e) => {
        console.error("Failed to connect to kernel comm:", e);
      });
    };

    this.websocket.onmessage = (event) => {
      this.postMessage({
        type: "message",
        data: event.data,
      });
    };

    this.websocket.onclose = (event) => {
      console.log("WebSocket connection closed");
    };

    this.websocket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  send(data) {
    if (this.websocket.readyState === WebSocket.OPEN) {
      console.log('Sending data:', data);
      this.websocket.send(data);
    } else {
      console.log('Cannot send data, WebSocket not open');
    }
  }

  close() {
    if (this.websocket) {
      this.websocket.close();
    }
  }
}

(function() {
  const client_id = "<client_id>";
  const ws_url = "<ws_url>";
  const comm_target = "ws_" + client_id;
  new ColabWebsocketProxy(ws_url, client_id, comm_target);
})();
"""

class ColabWebsocketRPCConnection:
    """Represent a colab websocket RPC connection."""

    def __init__(self, server_url, client_id, workspace=None, token=None, logger=None, timeout=5):
        """Set up instance."""
        self.server_url = server_url
        self.client_id = client_id
        self.workspace = workspace
        self.token = token
        self.logger = logger
        self.timeout = timeout
        self.comm = None
        self._handle_message = None
        self._is_async = None
        self.connected_event = asyncio.Future()

    def on_message(self, handler):
        """Register a message handler."""
        self._handle_message = handler
        self._is_async = asyncio.iscoroutinefunction(handler)

    async def open(self):
        """Open the connection."""
        self._setup_comm()
        await self.connected_event

    def _setup_comm(self):
        """Set up Colab communication channel."""
        def registered(comm, open_msg):
            """Handle registration."""
            self.comm = comm
            self.comm.send({"type": "log", "message": "Comm registered"})
            def msg_cb(msg):
                """Handle a message."""
                data = msg["content"]["data"]
                if "type" in data:
                    if data["type"] == "message":
                        loop = asyncio.get_running_loop()
                        if self._is_async:
                            loop.create_task(self._handle_message(msg["buffers"][0]))
                        else:
                            self._handle_message(msg["buffers"][0])
                    elif data["type"] == "log":
                        if self.logger:
                            self.logger.info(data["message"])
                    elif data["type"] == "error":
                        if self.logger:
                            self.logger.error(data["message"])

            comm.on_msg(msg_cb)
            self.connected_event.set_result(None)

        get_ipython().kernel.comm_manager.register_target(f"ws_{self.client_id}", registered)

        js_code = colab_websocket_proxy_js.replace('<client_id>', self.client_id).replace('<ws_url>', self.server_url)

        display(HTML(f"""
            <script>
                {js_code}
            </script>
        """))

    async def emit_message(self, data):
        """Emit a message."""
        if not self.comm:
            await self.open()
        self.comm.send({"type": "message"}, buffers=[data])

    async def disconnect(self, reason=None):
        """Disconnect."""
        if self.comm:
            self.comm.send({"type": "close", "reason": reason})
            self.comm = None
        if self.logger:
            self.logger.info("Websocket connection disconnected (%s)", reason)

if __name__ == "__main__":
    # Example usage:
    uri = "ws://127.0.0.1:8765"  # Local WebSocket server for testing
    client_id = str(uuid.uuid4())
    connection = ColabWebsocketRPCConnection(uri, client_id)

    async def test_websocket_connection():
        # Open connection
        await connection.open()

        # Register message handler
        def handle_message(message):
            print(f"Received message: {message}")

        connection.on_message(handle_message)

        # Send a test message
        await connection.emit_message({"type": "message", "data": "Hello, server!"})

        # Wait for a while to receive messages
        await asyncio.sleep(5)

        # Disconnect
        await connection.disconnect("Test complete")

    # Run the test
    asyncio.get_event_loop().create_task(test_websocket_connection())
