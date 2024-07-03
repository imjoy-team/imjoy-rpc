import asyncio
import uuid
from IPython.display import display, HTML
from imjoy_rpc.connection.colab_connection import put_buffers, remove_buffers

colab_websocket_proxy_js = """
function isSerializable(object) {
  return typeof object === "object" && object && object.toJSON;
}

function isObject(value) {
  return value && typeof value === "object" && value.constructor === Object;
}

function put_buffers(state, buffer_paths, buffers) {
  buffers = buffers.map(b => b instanceof DataView ? b.buffer : b);
  for (let i = 0; i < buffer_paths.length; i++) {
    const buffer_path = buffer_paths[i];
    let obj = state;
    for (let j = 0; j < buffer_path.length - 1; j++) {
      obj = obj[buffer_path[j]];
    }
    obj[buffer_path[buffer_path.length - 1]] = buffers[i];
  }
}

function remove_buffers(state) {
  const buffers = [];
  const buffer_paths = [];
  function remove(obj, path) {
    if (isSerializable(obj)) {
      obj = obj.toJSON();
    }
    if (Array.isArray(obj)) {
      let is_cloned = false;
      for (let i = 0; i < obj.length; i++) {
        const value = obj[i];
        if (value) {
          if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            if (!is_cloned) {
              obj = obj.slice();
              is_cloned = true;
            }
            buffers.push(ArrayBuffer.isView(value) ? value.buffer : value);
            buffer_paths.push(path.concat([i]));
            obj[i] = null;
          } else {
            const new_value = remove(value, path.concat([i]));
            if (new_value !== value) {
              if (!is_cloned) {
                obj = obj.slice();
                is_cloned = true;
              }
              obj[i] = new_value;
            }
          }
        }
      }
    } else if (isObject(obj)) {
      for (const key in obj) {
        let is_cloned = false;
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key];
          if (value) {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
              if (!is_cloned) {
                obj = { ...obj };
                is_cloned = true;
              }
              buffers.push(ArrayBuffer.isView(value) ? value.buffer : value);
              buffer_paths.push(path.concat([key]));
              delete obj[key];
            } else {
              const new_value = remove(value, path.concat([key]));
              if (new_value !== value) {
                if (!is_cloned) {
                  obj = { ...obj };
                  is_cloned = true;
                }
                obj[key] = new_value;
              }
            }
          }
        }
      }
    }
    return obj;
  }
  const new_state = remove(state, []);
  return { state: new_state, buffers, buffer_paths };
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

  connect() {
    this.websocket = new WebSocket(this.url);
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
            const buffer_paths = data.__buffer_paths__ || [];
            delete data.__buffer_paths__;
            put_buffers(data, buffer_paths, msg.buffers || []);
            if (data.type === "log" || data.type === "info") {
                console.log(data.message);
            } else if (data.type === "error") {
                console.error(data.message);
            } else if (data.type === "message") {
                this.send(data.data);
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
                    if "__buffer_paths__" in data:
                        buffer_paths = data["__buffer_paths__"]
                        del data["__buffer_paths__"]
                        put_buffers(data, buffer_paths, msg["buffers"])
                    loop = asyncio.get_running_loop()
                    if self._is_async:
                        loop.create_task(self._handle_message(data))
                    else:
                        self._handle_message(data)

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
        msg, buffer_paths, buffers = remove_buffers(data)
        if len(buffers) > 0:
            msg["__buffer_paths__"] = buffer_paths
            self.comm.send(msg, buffers=buffers)
        else:
            self.comm.send(msg)

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
