from ipykernel.comm import Comm

class JupyterCommTransport():
    def __init__(self):
        self._comms = {}
        self.channel_prefix = ""

    def connect(self):
        pass

    def on(self, channel, message_callback):
        if channel not in self._comms:
            self._comms[channel] = Comm(
                target_name=self.channel_prefix + channel, data={"channel": channel}
            )
        comm = self._comms[channel]
        
        def msg_cb(msg):
            message_callback(msg["content"]["data"])

        comm.on_msg(msg_cb)

        def remove_channel():
            del self._comms[channel]
        comm.on_close(remove_channel)

    def emit(self, channel, msg):
        if channel in self._comms:
            self._comms[channel].send(msg)
        else:
            raise Exception("channel not found: " + channel)