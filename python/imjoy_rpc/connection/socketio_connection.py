import socketio
from imjoy_rpc.utils import EventManager, dotdict


class SocketioConnection(EventManager):
    def __init__(self, config):
        self.config = dotdict(config or {})
        super().__init__(self.config.get("debug"))
        self.channel = self.config.get("channel") or 'test_plugin'
        self._event_handlers = {}
    
    def init(self):
        pass

    def connect(self):
        sio = socketio.Client()

        @sio.on('imjoy_rpc')
        def on_message(data):
            if "type" in data:
                self._fire(data["type"], data)

        @sio.event
        def connect():
            sio.emit('join_rpc_channel', {"channel": self.channel})
            self._fire("connected")

        @sio.event
        def connect_error():
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            self._fire("disconnected")

        sio.connect(self.config.url)
        self.sio = sio

        self.init()

    def disconnect(self):
        self.sio.disconnect()

    def emit(self, msg):
        self.sio.emit('imjoy_rpc', msg)
