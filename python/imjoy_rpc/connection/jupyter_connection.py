"""Provide a jupyter connection."""
import asyncio
import uuid
import sys
import logging
import re

import ipykernel
from IPython import get_ipython
from IPython.display import display, HTML, Javascript

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict
import contextvars

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("JupyterConnection")

connection_id = contextvars.ContextVar("connection_id")


class JupyterCommManager:
    """Represent a jupyter communication manager."""

    def __init__(self, rpc_context):
        """Set up instance."""
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
        self.kernel_id = re.search(
            "kernel-(.*).json", ipykernel.connect.get_connection_file()
        ).group(1)
        # for loading plugin from source code,
        # we can benifit from the syntax highlighting for HTML()
        self.register_codec({"name": "HTML", "type": HTML, "encoder": lambda x: x.data})

    def get_ident(self):
        """Return identity."""
        return connection_id.get(default=None)

    def set_interface(self, interface, config=None):
        """Set the interface."""
        config = config or self.default_config
        config = dotdict(config)
        config.id = str(uuid.uuid4())
        config.name = config.name or config.id
        config.allow_execution = config.allow_execution or False
        config.version = config.version or "0.1.0"
        config.api_version = config.api_version or "0.2.3"
        config.description = config.description or "[TODO: add description]"

        self.default_config = config
        self.interface = interface
        futures = []
        for k in self.clients:
            fut = self.clients[k].rpc.set_interface(interface, self.default_config)
            futures.append(fut)
        display(
            Javascript(
                'window.connectPlugin && window.connectPlugin("{}")'.format(
                    self.kernel_id
                )
            )
        )
        display(HTML('<div id="{}"></div>'.format(config.id)))
        return asyncio.gather(*futures)

    def register_codec(self, config):
        """Register codec."""
        assert "name" in config
        assert "encoder" in config or "decoder" in config
        if "type" in config:
            for tp in list(self._codecs.keys()):
                codec = self._codecs[tp]
                if codec.type == config["type"] or tp == config["name"]:
                    logger.info("Removing duplicated codec: " + tp)
                    del self._codecs[tp]

        self._codecs[config["name"]] = dotdict(config)

    def start(self, target="imjoy_rpc", on_ready_callback=None, on_error_callback=None):
        """Start."""

        def registered(comm, open_msg):
            """Handle registration."""
            self._create_new_connection(
                comm, open_msg, on_ready_callback, on_error_callback
            )

        try:
            get_ipython().kernel.comm_manager.register_target(target, registered)
        except Exception as ex:
            if on_error_callback:
                on_error_callback(ex)
            raise ex

    def init(self, config=None):
        """Initialize the connection."""
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def _create_new_connection(
        self, comm, open_msg, on_ready_callback, on_error_callback
    ):
        """Create a new connection."""
        connection_id.set(comm.comm_id)
        connection = JupyterCommConnection(self.default_config, comm, open_msg)

        def initialize(data):
            """Initialize connection."""
            self.clients[comm.comm_id] = dotdict()
            config = self.default_config.copy()
            cfg = data["config"]
            if cfg.get("credential_required") is not None:
                result = config.verify_credential(cfg["credential"])
                cfg["auth"] = result["auth"]
            cfg["id"] = config["id"]
            rpc = RPC(connection, self.rpc_context, config=cfg, codecs=self._codecs)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                """Patch api."""
                api = rpc.get_remote() or dotdict()
                api.init = self.init
                api.export = self.set_interface
                api.dispose = rpc.disconnect
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)
            if on_ready_callback:

                def ready(_):
                    on_ready_callback(rpc.get_remote())

                rpc.once("interfaceSetAsRemote", ready)
            if on_error_callback:
                rpc.once("disconnected", on_error_callback)
                rpc.on("error", on_error_callback)
            self.clients[comm.comm_id].rpc = rpc

        if on_error_callback:
            connection.once("disconnected", on_error_callback)
            connection.once("error", on_error_callback)
        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )


class JupyterCommConnection(MessageEmitter):
    """Represent a jupyter communication connection."""

    def __init__(self, config, comm, open_msg):
        """Set up instance."""
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}
        self.comm = comm
        self.peer_id = str(uuid.uuid4())
        self.debug = True

        def msg_cb(msg):
            """Handle a message."""
            data = msg["content"]["data"]
            # TODO: remove the exception for "initialize"
            if data.get("peer_id") == self.peer_id or data.get("type") == "initialize":
                if "type" in data:
                    if "__buffer_paths__" in data:
                        buffer_paths = data["__buffer_paths__"]
                        del data["__buffer_paths__"]
                        put_buffers(data, buffer_paths, msg["buffers"])
                    self._fire(data["type"], data)
            else:
                logger.warn(
                    "connection peer id mismatch {} != {}".format(
                        data.get("peer_id"), self.peer_id
                    )
                )

        comm.on_msg(msg_cb)

    def connect(self):
        """Connect."""
        pass

    def disconnect(self):
        """Disconnect."""
        pass

    def emit(self, msg):
        """Emit a message."""
        if msg["type"] == "method" and msg["name"] == "createWindow":
            # create a div for displaying window
            window_id = "imjoy_window_" + str(uuid.uuid4())
            msg["args"][0]["window_id"] = window_id
            display(
                HTML(
                    '<div id="{}" class="imjoy-inline-window"></div>'.format(window_id)
                )
            )

        msg, buffer_paths, buffers = remove_buffers(msg)
        if len(buffers) > 0:
            msg["__buffer_paths__"] = buffer_paths
            self.comm.send(msg, buffers=buffers)
        else:
            self.comm.send(msg)


# self file is taken from https://github.com/jupyter-widgets/ipywidgets/blob/master/ipywidgets/widgets/widget.py  # noqa: E501
# Author: IPython Development Team
# License: BSD

_binary_types = (memoryview, bytearray, bytes)


def put_buffers(state, buffer_paths, buffers):
    """Put buffers.

    The inverse of remove_buffers, except here we modify the existing dict/lists.
    Modifying should be fine, since self is used when state comes from the wire.
    """
    for buffer_path, buffer in zip(buffer_paths, buffers):
        # we'd like to set say sync_data['x'][0]['y'] = buffer
        # where buffer_path in self example would be ['x', 0, 'y']
        obj = state
        for key in buffer_path[:-1]:
            obj = obj[key]
        obj[buffer_path[-1]] = buffer if isinstance(buffer, bytes) else buffer.tobytes()


def _separate_buffers(substate, path, buffer_paths, buffers):
    """For internal, see remove_buffers."""
    # remove binary types from dicts and lists, but keep track of their paths
    # any part of the dict/list that needs modification will be cloned,
    # so the original stays untouched
    # e.g. {'x': {'ar': ar}, 'y': [ar2, ar3]}, where ar/ar2/ar3 are binary types
    # will result in:
    # {'x': {}, 'y': [None, None]}, [ar, ar2, ar3], [['x', 'ar'], ['y', 0], ['y', 1]]
    # instead of removing elements from the list,
    # this will make replacing the buffers on the js side much easier
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
                v_new = _separate_buffers(v, path + [i], buffer_paths, buffers)
                if v is not v_new:  # only assign when value changed
                    if not is_cloned:
                        substate = list(substate)  # clone list/tuple
                        is_cloned = True
                    substate[i] = v_new
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
                v_new = _separate_buffers(v, path + [k], buffer_paths, buffers)
                if v is not v_new:  # only assign when value changed
                    if not is_cloned:
                        substate = dict(substate)  # clone list/tuple
                        is_cloned = True
                    substate[k] = v_new
    else:
        raise ValueError("expected state to be a list or dict, not %r" % substate)
    return substate


def remove_buffers(state):
    """Return (state_without_buffers, buffer_paths, buffers) for binary message parts.

    A binary message part is a memoryview, bytearray, or python 3 bytes object.
    As an example:
    >>> state = {
            'plain': [0, 'text'],
            'x': {'ar': memoryview(ar1)},
            'y': {'shape': (10,10), 'data': memoryview(ar2)}
        }
    >>> remove_buffers(state)
    ({'plain': [0, 'text']}, {'x': {}, 'y': {'shape': (10, 10)}}, [['x', 'ar'], ['y', 'data']],
     [<memory at 0x107ffec48>, <memory at 0x107ffed08>])
    """  # noqa: E501
    buffer_paths, buffers = [], []
    state = _separate_buffers(state, [], buffer_paths, buffers)
    return state, buffer_paths, buffers
