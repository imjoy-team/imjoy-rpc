import sys
import logging

if sys.version_info < (3, 7):
    import aiocontextvars
import contextvars
import threading
from werkzeug.local import Local, LocalProxy, LocalManager

import uuid
from .utils import dotdict
from .rpc import RPC

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ImJoy-RPC")
logger.setLevel(logging.INFO)


def type_of_script():
    try:
        ipy_str = str(type(get_ipython()))
        if "zmqshell" in ipy_str:
            return "jupyter"
        if "terminal" in ipy_str:
            return "ipython"
    except:
        return "terminal"


class ContextLocal(Local):
    def __init__(self):
        object.__setattr__(
            self, "__context_id__", contextvars.ContextVar("context_id", default=None)
        )
        object.__setattr__(self, "__thread_lock__", threading.Lock())
        object.__setattr__(self, "__storage__", {})
        object.__setattr__(self, "__ident_func__", self.__get_ident)
        object.__setattr__(self, "__default_context_id__", "_")

    def set_default_context(self, context_id):
        object.__setattr__(self, "__default_context_id__", context_id)

    def run_with_context(self, context_id, func, *args, **kwargs):
        # make sure we obtain the context with the correct context_id
        with object.__getattribute__(self, "__thread_lock__"):
            object.__getattribute__(self, "__context_id__").set(context_id)
            object.__setattr__(self, "__default_context_id__", context_id)
            ctx = contextvars.copy_context()
        ctx.run(func, *args, **kwargs)

    def __get_ident(self):
        ident = object.__getattribute__(self, "__context_id__").get()
        if ident is None:
            return object.__getattribute__(self, "__default_context_id__")
        if not isinstance(ident, str):
            raise ValueError("Context value must be a string.")
        return ident


_rpc_context = ContextLocal()

if type_of_script() == "jupyter":
    logger.info("Using jupyter connection for imjoy-rpc")
    from .connection.jupyter_connection import JupyterCommManager

    manager = JupyterCommManager(_rpc_context)
    _rpc_context.api = dotdict(
        export=manager.set_interface, registerCodec=manager.register_codec
    )
    manager.register()
else:
    logger.info("TODO: support socketio connection")
    raise NotImplementedError

api = LocalProxy(_rpc_context, "api")
