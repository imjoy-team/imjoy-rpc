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


class Comm:
    def __init__(self, target_name="imjoy_rpc", data=None):
        self.target_name = target_name
        self._msg_callbacks = []
        self.comm_id = str(uuid.uuid4())
        google.colab.output.register_callback(
            "comm_message_" + self.target_name, self.handle_comm_msg
        )

    def handle_comm_msg(self, msg, buffers=None):
        for cb in self._msg_callbacks:
            try:
                cb({"content": {"data": msg}, "buffers": buffers})
            except Exception as e:
                print(e)

    def send(self, msg, buffers=None):
        google.colab.output.eval_js(
            {"target_name": self.target_name, "msg": msg, "buffers": buffers},
            ignore_result=True,
        )

    def on_msg(self, cb):
        self._msg_callbacks.append(cb)

    def on_close(self, cb):
        pass


class ColabManager:
    def __init__(self, rpc_context):
        self.default_config = rpc_context.default_config
        self.clients = {}
        self.interface = None
        self.rpc_context = rpc_context
        self._codecs = {}

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
                    logger.warn("Removing duplicated codec: " + tp)
                    del self._codecs[tp]

        self._codecs[config["name"]] = dotdict(config)

    def start(self):
        self.comm = Comm("imjoy_rpc")
        connection_id.set(self.comm.comm_id)
        self.connection = ColabConnection(self.default_config, self.comm)
        self.connection.on("new_connection", self._create_new_connection)

    def _create_new_connection(self, open_msg):
        # reset comm and connection
        self.start()

        comm = self.comm
        connection = self.connection

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
                api = rpc.get_remote() or dotdict()
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


class ColabConnection(MessageEmitter):
    def __init__(self, config, comm):
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
            if (
                data.get("peer_id") == self.peer_id
                or data.get("type") == "initialize"
                or data.get("type") == "new_connection"
            ):
                if "type" in data:
                    if "__buffer_paths__" in data:
                        buffer_paths = data["__buffer_paths__"]
                        del data["__buffer_paths__"]

                        # decode buffers from base64 encoding
                        buffers = msg["buffers"]
                        if buffers:
                            for i in range(len(buffers)):
                                buffers[i] = base64.decodebytes(buffers[i]).encode(
                                    "ascii"
                                )

                        put_buffers(data, buffer_paths, buffers)
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
        # encode buffers into base64
        for i in range(len(buffers)):
            buffers[i] = base64.encodebytes(buffers[i]).decode("ascii")

        if len(buffers) > 0:
            msg["__buffer_paths__"] = buffer_paths
            self.comm.send(msg, buffers=buffers)
        else:
            self.comm.send(msg)
