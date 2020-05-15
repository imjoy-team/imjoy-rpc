import uuid
import socketio
from imjoy_rpc.utils import MessageEmitter, dotdict

# TODO: support SocketioConnection
class SocketioConnection(MessageEmitter):
    def __init__(self, config):
        self.config = dotdict(config or {})
        super().__init__(self.config.get("debug"))
        self.channel = self.config.get("channel") or "test_plugin"
        self._event_handlers = {}
        self.peer_id = str(uuid.uuid4())
        sio = socketio.Client()

        @sio.on("imjoy_rpc")
        def on_message(data):
            if data.get("peer_id") == self.peer_id:
                if "type" in data:
                    self._fire(data["type"], data)
            elif self.config.get("debug"):
                print(f"connection peer id mismatch {data.peer_id} != {self.peer_id}")

        @sio.event
        def connect():
            sio.emit("join_rpc_channel", {"channel": self.channel})
            self.emit(
                {"type": "initialized", "config": self.config, "peer_id": self.peer_id}
            )
            self._fire("connected")

        @sio.event
        def connect_error():
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            self._fire("disconnected")

        self.sio = sio

    def connect(self):
        self.sio.connect(self.config.url)

    def disconnect(self):
        self.sio.disconnect()

    def emit(self, msg):
        self.sio.emit("imjoy_rpc", msg)
