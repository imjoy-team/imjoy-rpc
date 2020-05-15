from werkzeug.local import Local, LocalProxy, LocalManager

import uuid
from .utils import dotdict
from .rpc import RPC


def type_of_script():
    try:
        ipy_str = str(type(get_ipython()))
        if "zmqshell" in ipy_str:
            return "jupyter"
        if "terminal" in ipy_str:
            return "ipython"
    except:
        return "terminal"


if type_of_script() == "jupyter":
    print("Using jupyter connection for imjoy-rpc")
    from .connection.jupyter_connection import JupyterConnection as Connection
else:
    print("TODO: support socketio connection")
    raise NotImplementedError

_local_context = Local()
_local_manager = LocalManager([_local_context])
api = LocalProxy(_local_context, "api")


def wait_for_initialization(config):
    config = config or {}
    connection = Connection(config)
    connection.connect()

    def initialize(data):
        cfg = data["config"]
        if cfg.get("credential_required") is not None:
            result = config.verify_credential(cfg["credential"])
            cfg["auth"] = result["auth"]
        connection.off("initialize", initialize)
        setupRPC(cfg)

    connection.on("initialize", initialize)
    connection.emit({"type": "imjoyRPCReady", "config": config})


def setupRPC(config, connection=None):
    config = config or {}
    connection = connection or Connection(config)
    rpc = RPC(connection, local_context=_local_context, config=config)
    return rpc


def initial_export(interface, config=None):
    config = config or {}
    config = dotdict(config)
    config.name = config.name or "Jupyter Notebook"
    config.allow_execution = config.allow_execution or False
    config.version = config.version or "0.1.0"
    config.api_version = config.api_version or "0.2.1"
    config.description = config.description or "[TODO: add description]"
    config.id = config.id or str(uuid.uuid4())
    rpc = setupRPC(config)
    rpc.set_interface(interface)
    rpc._connection.connect()


_local_context.api = dotdict(export=initial_export)
