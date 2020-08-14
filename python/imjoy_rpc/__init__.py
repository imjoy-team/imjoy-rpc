import os
import sys
import logging

from werkzeug.local import Local, LocalProxy
from .utils import ContextLocal, setup_connection, type_of_script, dotdict

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ImJoy-RPC")
logger.setLevel(logging.INFO)

_rpc_context = ContextLocal()
api = LocalProxy(_rpc_context, "api")
_rpc_context.default_config = {}


class ApiWrapper(object):
    def __init__(self):
        self.__initialized = False

    def __getattr__(self, attr):
        if not self.__initialized:
            connection_type = os.environ.get("IMJOY_RPC_CONNECTION", type_of_script())
            setup_connection(_rpc_context, connection_type, logger)
            self.__initialized = True
        return _rpc_context.api[attr]


_rpc_context.api = ApiWrapper()
default_config = LocalProxy(_rpc_context, "default_config")
