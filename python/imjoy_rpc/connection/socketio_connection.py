import socketio


class SocketioConnection(EventManager):
    def __init__(self, config):
        self.config = config or {}
        super().__init__(config.get("debug"))
        self.channel_prefix = ""
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}

    def connect(self):
        sio = socketio.Client()

        @sio.event
        async def message(data):
            print("I received a message!")

        @sio.event
        def connect():
            print("I'm connected!")

        @sio.event
        def connect_error():
            self._fire("connectFailure")

        @sio.event
        def disconnect():
            self._fire("disconnected")

        sio.connect(config.url)
        self.sio = sio

    def disconnect(self):
        pass

    def emit(self, msg):
        if self.channel in _comms:
            comm = _comms[self.channel]
            msg, buffer_paths, buffers = remove_buffers(msg)
            if len(buffers) > 0:
                msg["__buffer_paths__"] = buffer_paths
                comm.send(msg, buffers=buffers)
            else:
                comm.send(msg)
        else:
            raise Exception("channel not found: " + self.channel)
