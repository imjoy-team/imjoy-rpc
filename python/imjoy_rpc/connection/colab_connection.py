import base64
import contextvars
import logging
import os
import sys
import uuid

import google
from IPython import get_ipython
from IPython.display import display, HTML, Javascript

from imjoy_rpc.rpc import RPC
from imjoy_rpc.utils import MessageEmitter, dotdict
from imjoy_rpc.connection.jupyter_connection import put_buffers, remove_buffers

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ColabConnection")

connection_id = contextvars.ContextVar("connection_id")

colab_html = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "imjoy_colab.html"), "r"
).read()


class ColabManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}
        # for loading plugin from source code,
        # we can benifit from the syntax highlighting for HTML()
        self.register_codec({"name": "HTML", "type": HTML, "encoder": lambda x: x.data})

    def get_ident(self):
        return connection_id.get(default=None)

    def set_interface(self, interface, config=None):
        config = config or self.default_config
        config = dotdict(config)
        config.name = config.name or "Colab Notebook"
        config.allow_execution = config.allow_execution or False
        config.version = config.version or "0.1.0"
        config.api_version = config.api_version or "0.2.3"
        config.description = config.description or "[TODO: add description]"
        config.id = str(uuid.uuid4())
        self.default_config = config
        self.interface = interface
        for k in self.clients:
            self.clients[k].rpc.set_interface(interface)
        display(HTML(colab_html))
        display(HTML('<div id="{}"></div>'.format(config.id)))

    def register_codec(self, config):
        assert "name" in config
        assert "encoder" in config or "decoder" in config
        if "type" in config:
            for tp in list(self._codecs.keys()):
                codec = self._codecs[tp]
                if codec.type == config["type"] or tp == config["name"]:
                    logger.info("Removing duplicated codec: " + tp)
                    del self._codecs[tp]

        self._codecs[config["name"]] = dotdict(config)

    def start(self, target="imjoy_rpc"):
        get_ipython().kernel.comm_manager.register_target(
            target, self._create_new_connection
        )

    def init(self, config=None):
        # register a minimal plugin api
        def setup():
            pass

        self.set_interface({"setup": setup}, config)

    def _create_new_connection(self, comm, open_msg):
        connection_id.set(comm.comm_id)
        connection = ColabCommConnection(self.default_config, comm, open_msg)

        def initialize(data):
            self.clients[comm.comm_id] = dotdict()
            config = self.default_config.copy()
            config.update(data["config"])
            config["id"] = config.get("id", str(uuid.uuid4()))
            if config.get("credential_required") is not None:
                result = config.verify_credential(config["credential"])
                config["auth"] = result["auth"]
            rpc = RPC(connection, self.rpc_context, config=config, codecs=self._codecs,)
            rpc.set_interface(self.interface)
            rpc.init()

            def patch_api(_):
                api = rpc.get_remote() or dotdict
                api.init = self.init
                api.export = self.set_interface
                api.registerCodec = self.register_codec
                api.disposeObject = rpc.dispose_object

            rpc.on("remoteReady", patch_api)

            self.clients[comm.comm_id].rpc = rpc

        connection.once("initialize", initialize)
        connection.emit(
            {
                "type": "imjoyRPCReady",
                "config": dict(self.default_config),
                "peer_id": connection.peer_id,
            }
        )


class ColabCommConnection(MessageEmitter):
    def __init__(self, config, comm, open_msg):
        self.config = dotdict(config or {})
        super().__init__(logger)
        self.channel = self.config.get("channel") or "imjoy_rpc"
        self._event_handlers = {}
        self.comm = comm
        self.peer_id = str(uuid.uuid4())
        self.debug = True

        def msg_cb(msg):
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
        pass

    def disconnect(self):
        pass

    def emit(self, msg):
        msg, buffer_paths, buffers = remove_buffers(msg)
        if len(buffers) > 0:
            msg["__buffer_paths__"] = buffer_paths
            self.comm.send(msg, buffers=buffers)
        else:
            self.comm.send(msg)
