from ipykernel.comm import Comm


class JupyterConnection:
    def __init__(self, default_channel="imjoy_rpc"):
        self._comms = {}
        self.channel_prefix = ""
        self.default_channel = default_channel

    def connect(self):
        pass

    def on(self, message_callback, channel=None):
        channel = channel or self.default_channel
        if channel not in self._comms:
            self._comms[channel] = Comm(
                target_name=self.channel_prefix + channel, data={"channel": channel}
            )
        comm = self._comms[channel]

        def msg_cb(msg):
            data = msg["content"]["data"]
            if "__buffer_paths__" in data:
                buffer_paths = data["__buffer_paths__"]
                del data["__buffer_paths__"]
                put_buffers(data, buffer_paths, msg["buffers"])
            message_callback(data)

        comm.on_msg(msg_cb)

        def remove_channel():
            del self._comms[channel]

        comm.on_close(remove_channel)

    def emit(self, msg, channel=None):
        """Emit a message to the socketio server."""
        channel = channel or self.default_channel
        if channel in self._comms:
            comm = self._comms[channel]
            msg, buffer_paths, buffers = remove_buffers(msg)
            if len(buffers) > 0:
                msg["__buffer_paths__"] = buffer_paths
                comm.send(msg, buffers=buffers)
            else:
                comm.send(msg)
        else:
            raise Exception("channel not found: " + channel)


# This file is taken from https://github.com/jupyter-widgets/ipywidgets/blob/master/ipywidgets/widgets/widget.py
# Author: IPython Development Team
# License: BSD

_binary_types = (memoryview, bytearray, bytes)


def put_buffers(state, buffer_paths, buffers):
    """The inverse of remove_buffers, except here we modify the existing dict/lists.
    Modifying should be fine, since this is used when state comes from the wire.
    """
    for buffer_path, buffer in zip(buffer_paths, buffers):
        # we'd like to set say sync_data['x'][0]['y'] = buffer
        # where buffer_path in this example would be ['x', 0, 'y']
        obj = state
        for key in buffer_path[:-1]:
            obj = obj[key]
        obj[buffer_path[-1]] = buffer


def _separate_buffers(substate, path, buffer_paths, buffers):
    """For internal, see remove_buffers"""
    # remove binary types from dicts and lists, but keep track of their paths
    # any part of the dict/list that needs modification will be cloned, so the original stays untouched
    # e.g. {'x': {'ar': ar}, 'y': [ar2, ar3]}, where ar/ar2/ar3 are binary types
    # will result in {'x': {}, 'y': [None, None]}, [ar, ar2, ar3], [['x', 'ar'], ['y', 0], ['y', 1]]
    # instead of removing elements from the list, this will make replacing the buffers on the js side much easier
    if isinstance(substate, (list, tuple)):
        is_cloned = False
        for i, v in enumerate(substate):
            if isinstance(v, _binary_types):
                if not is_cloned:
                    substate = list(substate)  # shallow clone list/tuple
                    is_cloned = True
                substate[i] = None
                buffers.append(v)
                buffer_paths.append(path + [i])
            elif isinstance(v, (dict, list, tuple)):
                vnew = _separate_buffers(v, path + [i], buffer_paths, buffers)
                if v is not vnew:  # only assign when value changed
                    if not is_cloned:
                        substate = list(substate)  # clone list/tuple
                        is_cloned = True
                    substate[i] = vnew
    elif isinstance(substate, dict):
        is_cloned = False
        for k, v in substate.items():
            if isinstance(v, _binary_types):
                if not is_cloned:
                    substate = dict(substate)  # shallow clone dict
                    is_cloned = True
                del substate[k]
                buffers.append(v)
                buffer_paths.append(path + [k])
            elif isinstance(v, (dict, list, tuple)):
                vnew = _separate_buffers(v, path + [k], buffer_paths, buffers)
                if v is not vnew:  # only assign when value changed
                    if not is_cloned:
                        substate = dict(substate)  # clone list/tuple
                        is_cloned = True
                    substate[k] = vnew
    else:
        raise ValueError("expected state to be a list or dict, not %r" % substate)
    return substate


def remove_buffers(state):
    """Return (state_without_buffers, buffer_paths, buffers) for binary message parts
    A binary message part is a memoryview, bytearray, or python 3 bytes object.
    As an example:
    >>> state = {'plain': [0, 'text'], 'x': {'ar': memoryview(ar1)}, 'y': {'shape': (10,10), 'data': memoryview(ar2)}}
    >>> remove_buffers(state)
    ({'plain': [0, 'text']}, {'x': {}, 'y': {'shape': (10, 10)}}, [['x', 'ar'], ['y', 'data']],
     [<memory at 0x107ffec48>, <memory at 0x107ffed08>])
    """
    buffer_paths, buffers = [], []
    state = _separate_buffers(state, [], buffer_paths, buffers)
    return state, buffer_paths, buffers
