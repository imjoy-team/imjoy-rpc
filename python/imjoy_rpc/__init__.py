import os
import sys
import logging
from functools import partial

from werkzeug.local import Local, LocalProxy
from .utils import (
    ContextLocal,
    setup_connection,
    type_of_script,
    register_default_codecs,
)


__all__ = [
    "api",
    "register_default_codecs",
    "connect_to_server",
    "connect_to_jupyter",
    "connect_to_colab",
    "connect_to_pyodide",
]

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


def _connect(connection_type, config={}, **kwargs):
    import asyncio

    config.update(kwargs)

    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    # passing server_url, token and workspace
    def on_ready_callback(result):
        if fut.done():
            logger.warning("on_ready_callback was called more than once")
            return
        logger.info("Plugin is now ready")
        fut.set_result(result)

    def on_error_callback(detail):
        if fut.done():
            logger.error(str(detail))
            return
        logger.error("Plugin failed with error: " + str(detail))
        fut.set_exception(Exception("Plugin failed with error: " + str(detail)))

    default_config.update(config)
    setup_connection(
        _rpc_context,
        connection_type,
        logger=logger,
        on_ready_callback=on_ready_callback,
        on_error_callback=on_error_callback,
    )
    _rpc_context.api.__initialized = True
    return fut


connect_to_server = partial(_connect, "terminal")
connect_to_jupyter = partial(_connect, "jupyter")
connect_to_colab = partial(_connect, "colab")
connect_to_pyodide = partial(_connect, "pyodide")
