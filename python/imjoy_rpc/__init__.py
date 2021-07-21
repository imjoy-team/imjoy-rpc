"""Provide the ImJoy RPC."""
import os
import sys
import logging
from functools import partial

from .werkzeug.local import LocalProxy
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
    "connect",
]

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("ImJoy-RPC")
logger.setLevel(logging.WARNING)

_rpc_context = ContextLocal()
api = LocalProxy(_rpc_context, "api")
_rpc_context.default_config = {}


class ApiWrapper(dict):
    """Represent the wrapped API."""

    def __init__(self):
        """Set up instance."""
        self.__initialized = False

    def __getattr__(self, attr):
        """Return an attribute."""
        if not self.__initialized:
            connection_type = os.environ.get("IMJOY_RPC_CONNECTION") or type_of_script()
            setup_connection(_rpc_context, connection_type, logger)
            self.__initialized = True
        return _rpc_context.api[attr]


_rpc_context.api = ApiWrapper()
default_config = LocalProxy(_rpc_context, "default_config")


def _connect(connection_type, config=None, **kwargs):
    """Connect."""
    import asyncio

    config = config or {}
    config.update(kwargs)

    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    # passing server_url, token and workspace

    def on_ready_callback(result):
        if fut.done():
            return
        logger.info("Plugin is now ready")
        fut.set_result(result)

    def on_error_callback(detail):
        """Handle error."""
        if fut.done():
            if detail:
                logger.error(str(detail))
            return
        logger.error("Plugin failed with error: " + str(detail))
        fut.set_exception(Exception("Plugin failed with error: " + str(detail)))

    rpc_context = ContextLocal()
    rpc_context.default_config = config
    setup_connection(
        rpc_context,
        connection_type,
        logger=logger,
        on_ready_callback=on_ready_callback,
        on_error_callback=on_error_callback,
    )
    rpc_context.api.export({})
    return fut


connect_to_server = partial(_connect, "terminal")
connect_to_jupyter = partial(_connect, "jupyter")
connect_to_colab = partial(_connect, "colab")
connect_to_pyodide = partial(_connect, "pyodide")


def connect(config=None, **kwargs):
    """Connect to an ImJoy core based on the current python environment."""
    connection_type = os.environ.get("IMJOY_RPC_CONNECTION") or type_of_script()
    return _connect(connection_type, config=config, **kwargs)
