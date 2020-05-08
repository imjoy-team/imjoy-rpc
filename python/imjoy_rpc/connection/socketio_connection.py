import socketio

class SocketioConnection:
    def __init__(self, config):
        self.config = config or {}
        self.channel_prefix = ""
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}

    def connect(self):
        sio = socketio.Client()
        @sio.event
        async def message(data):
            print('I received a message!')

        @sio.event
        def connect():
            print("I'm connected!")

        @sio.event
        def connect_error():
            self._fire('connectFailure')

        @sio.event
        def disconnect():
            self._fire('disconnected')

        sio.connect(config.url)
        self.sio = sio

    def disconnect(self):
        pass

    def on(self, event, handler):
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def once(self, event, handler):
        handler.___event_run_once = True
        self.on(event, handler)

    def off(self, event=None, handler=None):
        if event is None and handler is None:
            self._event_handlers = {}
        elif event is not None and handler is None:
            if event in self._event_handlers:
                self._event_handlers[event] = []
        else:
            if event in self._event_handlers:
                self._event_handlers[event].remove(handler)

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

    def _fire(self, event, data):
        if self._event_handlers[event]:
            for cb in self._event_handlers[event]:
                try:
                    cb(data)
                except Exception as e:
                    traceback_error = traceback.format_exc()
                    self.emit({"type": "error", "message": traceback_error})
        else:
            if self.config.debug:
                print("Unhandled event", event, data)
