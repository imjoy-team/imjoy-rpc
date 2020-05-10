from werkzeug.local import Local, LocalProxy, LocalManager


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
    from .connection.jupyter_connection import JupyterConnection as Connection
else:
    from .connection.socketio_connection import SocketioConnection as Connection

_local_context = Local()
_local_manager = LocalManager([_local_context])
api = LocalProxy(_local_context, "api")


def initial_export(interface, config=None):
    connection = Connection(config)
    connection.connect()
    rpc = RPC(connection, local_context=_local_context, config=config)
    rpc.set_interface(interface)
    rpc.init()


_local_context.api = dotdict(export=initial_export)
