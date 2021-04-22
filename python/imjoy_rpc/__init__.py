import os
import sys
import logging

from werkzeug.local import Local, LocalProxy
from .utils import (
    ContextLocal,
    setup_connection,
    type_of_script,
    register_default_codecs,
)


__all__ = ["api", "register_default_codecs"]

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ImJoy-RPC")
logger.setLevel(logging.WARNING)

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


def connect_to_server(config):
    import asyncio

    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    # passing server_url, token and workspace
    def on_ready_callback(result):
        if result.get("success"):
            logger.info("Plugin is now ready")
            fut.set_result(result.get("detail"))
        else:
            logger.error("Plugin failed with error: " + str(result.get("detail")))
            fut.set_exception(
                Exception("Plugin failed with error: " + str(result.get("detail")))
            )

    default_config.update(config)
    setup_connection(_rpc_context, "terminal", logger)
    _rpc_context.api.__initialized = True
    return fut
