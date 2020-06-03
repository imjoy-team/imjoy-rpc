import sys
import logging

from werkzeug.local import Local, LocalProxy
from .utils import ContextLocal, setup_connection, type_of_script

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ImJoy-RPC")
logger.setLevel(logging.INFO)

_rpc_context = ContextLocal()
api = LocalProxy(_rpc_context, "api")
setup_connection(_rpc_context, type_of_script(), logger)
