import socketio


class SocketioConnection(EventManager):
    def __init__(self, config):
        self.config = config or {}
        super().__init__(config.get("debug"))
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}

    def connect(self):
        sio = socketio.Client()

        @sio.on(self.channel)
        def on_message(data):
            if "type" in data:
                self._fire(data["type"], data)

        @sio.event
        def connect():
            self._fire("connected")

        @sio.event
        def connect_error():
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            self._fire("disconnected")

        sio.connect(config.url)
        self.sio = sio

    def disconnect(self):
        self.sio.disconnect()

    def emit(self, msg):
        self.sio.emit(self.channel, msg)
