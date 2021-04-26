"""Provide a colab connection."""
import asyncio
import contextvars
import logging
import os
import sys
import uuid

from IPython import get_ipython
from IPython.display import HTML, display

from imjoy_rpc.connection.jupyter_connection import put_buffers, remove_buffers
from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ColabConnection")

connection_id = contextvars.ContextVar("connection_id")

colab_html = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "imjoy_colab.html"), "r"
).read()


class ColabManager:
    """Represent a colab manager."""

    def __init__(self, rpc_context):
        """Set up instance."""
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
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
        display(HTML(colab_html))
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
            """Set up plugin."""
            pass

        self.set_interface({"setup": setup}, config)

    def _create_new_connection(
        self, comm, open_msg, on_ready_callback, on_error_callback
    ):
        """Create a new connection."""
        connection_id.set(comm.comm_id)
        connection = ColabCommConnection(self.default_config, comm, open_msg)

        def initialize(data):
            """Initialize connection."""
            self.clients[comm.comm_id] = dotdict()
            config = self.default_config.copy()
            config.update(data["config"])
            config["id"] = config.get("id", str(uuid.uuid4()))
            if config.get("credential_required") is not None:
                result = config.verify_credential(config["credential"])
                config["auth"] = result["auth"]
            rpc = RPC(connection, self.rpc_context, config=config, codecs=self._codecs)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                """Patch api."""
                api = rpc.get_remote() or dotdict
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


class ColabCommConnection(MessageEmitter):
    """Represent a colab communication connection."""

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
        msg, buffer_paths, buffers = remove_buffers(msg)
        if len(buffers) > 0:
            msg["__buffer_paths__"] = buffer_paths
            self.comm.send(msg, buffers=buffers)
        else:
            self.comm.send(msg)
