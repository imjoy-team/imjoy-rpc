from werkzeug.local import Local, LocalProxy, LocalManager
from .connection.jupyter_connection import JupyterConnection
from .utils import dotdict
from .rpc import RPC

_local_context = Local()
_local_manager = LocalManager([_local_context])
api = LocalProxy(_local_context, "api")


def initial_export(interface, config=None):
    transport = JupyterConnection()
    transport.connect()
    rpc = RPC(transport, local_context=_local_context, config=config)
    rpc.set_interface(interface)
    rpc.init()


_local_context.api = dotdict(export=initial_export)
