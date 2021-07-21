"""Provide utility functions for RPC."""
import sys

if sys.version_info < (3, 7):
    import aiocontextvars  # noqa: F401
import contextvars
import asyncio
import copy
import uuid
import traceback
import threading
from .werkzeug.local import Local


class dotdict(dict):  # pylint: disable=invalid-name
    """Access dictionary attributes with dot.notation."""

    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __hash__(self):
        """Return the hash."""
        # TODO: is there any performance impact?
        return hash(tuple(sorted(self.items())))

    def __deepcopy__(self, memo=None):
        """Make a deep copy."""
        return dotdict(copy.deepcopy(dict(self), memo=memo))


def format_traceback(traceback_string):
    """Format traceback."""
    formatted_lines = traceback_string.splitlines()
    # remove the second and third line
    formatted_lines.pop(1)
    formatted_lines.pop(1)
    formatted_error_string = "\n".join(formatted_lines)
    formatted_error_string = formatted_error_string.replace(
        'File "<string>"', "Plugin script"
    )
    return formatted_error_string


class ReferenceStore:
    """Represent a reference store."""

    def __init__(self):
        """Set up store."""
        self._store = {}

    @staticmethod
    def _gen_id():
        """Generate an id."""
        return str(uuid.uuid4())

    def put(self, obj):
        """Put an object into the store."""
        id_ = self._gen_id()
        self._store[id_] = obj
        return id_

    def fetch(self, search_id):
        """Fetch an object from the store by id."""
        if search_id not in self._store:
            return None
        obj = self._store[search_id]
        if not hasattr(obj, "__remote_method"):
            del self._store[search_id]
        if hasattr(obj, "__promise_pair"):
            self.fetch(obj.__promise_pair)
        return obj


class Promise(object):  # pylint: disable=useless-object-inheritance
    """Represent a promise."""

    def __init__(self, pfunc, logger=None):
        """Set up promise."""
        self._resolve_handler = None
        self._finally_handler = None
        self._catch_handler = None
        self._logger = logger

        def resolve(*args, **kwargs):
            self.resolve(*args, **kwargs)

        def reject(*args, **kwargs):
            self.reject(*args, **kwargs)

        pfunc(resolve, reject)

    def resolve(self, result):
        """Resolve promise."""
        try:
            if self._resolve_handler:
                self._resolve_handler(result)
        except Exception as exc:  # pylint: disable=broad-except
            if self._catch_handler:
                self._catch_handler(exc)
            elif not self._finally_handler:
                if self._logger:
                    self._logger.error("Uncaught Exception: {}".format(exc))
        finally:
            if self._finally_handler:
                self._finally_handler()

    def reject(self, error):
        """Reject promise."""
        try:
            if self._catch_handler:
                self._catch_handler(error)
            elif not self._finally_handler:
                if self._logger:
                    self._logger.error("Uncaught Exception: {}".format(error))
        finally:
            if self._finally_handler:
                self._finally_handler()

    def then(self, handler):
        """Implement then callback.

        Set handler and return the promise.
        """
        self._resolve_handler = handler
        return self

    def finally_(self, handler):
        """Implement finally callback.

        Set handler and return the promise.
        """
        self._finally_handler = handler
        return self

    def catch(self, handler):
        """Implement catch callback.

        Set handler and return the promise.
        """
        self._catch_handler = handler
        return self


class FuturePromise(Promise, asyncio.Future):
    """Represent a promise as a future."""

    def __init__(self, pfunc, logger=None):
        """Set up promise."""
        Promise.__init__(self, pfunc, logger)
        asyncio.Future.__init__(self)

    def resolve(self, result):
        """Resolve promise."""
        if self._resolve_handler or self._finally_handler:
            super().resolve(result)
        else:
            self.set_result(result)

    def reject(self, error):
        """Reject promise."""
        if self._catch_handler or self._finally_handler:
            super().reject(error)
        else:
            if error:
                self.set_exception(Exception(str(error)))
            else:
                self.set_exception(Exception())


class MessageEmitter:
    """Represent a message emitter."""

    def __init__(self, logger=None):
        """Set up instance."""
        self._event_handlers = {}
        self._logger = logger

    def on(self, event, handler):
        """Register an event handler."""
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def once(self, event, handler):
        """Register an event handler that should only run once."""
        # wrap the handler function,
        # this is needed because setting property
        # won't work for member function of a class instance
        def wrap_func(*args, **kwargs):
            return handler(*args, **kwargs)

        wrap_func.___event_run_once = True
        self.on(event, wrap_func)

    def off(self, event=None, handler=None):
        """Reset one or all event handlers."""
        if event is None and handler is None:
            self._event_handlers = {}
        elif event is not None and handler is None:
            if event in self._event_handlers:
                self._event_handlers[event] = []
        else:
            if event in self._event_handlers:
                self._event_handlers[event].remove(handler)

    def emit(self, msg):
        """Emit a message."""
        raise NotImplementedError

    def _fire(self, event, data=None):
        """Fire an event handler."""
        if event in self._event_handlers:
            for handler in self._event_handlers[event]:
                try:
                    handler(data)
                except Exception as err:
                    traceback_error = traceback.format_exc()
                    if self._logger:
                        self._logger.exception(err)
                    self.emit({"type": "error", "message": traceback_error})
                finally:
                    if hasattr(handler, "___event_run_once"):
                        self._event_handlers[event].remove(handler)
        else:
            if self._logger and self._logger.debug:
                self._logger.debug("Unhandled event: {}, data: {}".format(event, data))


class ContextLocal(Local):
    """Represent a local context."""

    def __init__(self, default_context_id=None):
        """Set up instance."""
        if default_context_id is None:
            default_context_id = "_"
        object.__setattr__(
            self, "__context_id__", contextvars.ContextVar("context_id", default=None)
        )
        object.__setattr__(self, "__thread_lock__", threading.Lock())
        object.__setattr__(self, "__storage__", {})
        object.__setattr__(self, "__ident_func__", self.__get_ident)
        object.__setattr__(self, "__default_context_id__", default_context_id)

    def set_default_context(self, context_id):
        """Set the default context."""
        object.__setattr__(self, "__default_context_id__", context_id)

    def run_with_context(self, context_id, func, *args, **kwargs):
        """Run with the context."""
        # make sure we obtain the context with the correct context_id
        with object.__getattribute__(self, "__thread_lock__"):
            object.__getattribute__(self, "__context_id__").set(context_id)
            object.__setattr__(self, "__default_context_id__", context_id)
            ctx = contextvars.copy_context()
        ctx.run(func, *args, **kwargs)

    def __get_ident(self):
        """Return the context identity."""
        ident = object.__getattribute__(self, "__context_id__").get()
        if ident is None:
            return object.__getattribute__(self, "__default_context_id__")
        if not isinstance(ident, str):
            raise ValueError("Context value must be a string.")
        return ident


def encode_zarr_store(zobj):
    """Encode the zarr store."""
    import zarr

    path_prefix = f"{zobj.path}/" if zobj.path else ""

    def getItem(key, options=None):
        return zobj.store[path_prefix + key]

    def setItem(key, value):
        zobj.store[path_prefix + key] = value

    def containsItem(key, options=None):
        if path_prefix + key in zobj.store:
            return True

    return {
        "_rintf": True,
        "_rtype": "zarr-array" if isinstance(zobj, zarr.Array) else "zarr-group",
        "getItem": getItem,
        "setItem": setItem,
        "containsItem": containsItem,
    }


def register_default_codecs(options=None):
    """Register default codecs."""
    from imjoy_rpc import api

    if options is None or "zarr-array" in options:
        import zarr

        api.registerCodec(
            {"name": "zarr-array", "type": zarr.Array, "encoder": encode_zarr_store}
        )

    if options is None or "zarr-group" in options:
        import zarr

        api.registerCodec(
            {"name": "zarr-group", "type": zarr.Group, "encoder": encode_zarr_store}
        )


def setup_connection(
    _rpc_context,
    connection_type,
    logger=None,
    on_ready_callback=None,
    on_error_callback=None,
):
    """Set up the connection."""
    if connection_type == "jupyter":
        if logger:
            logger.info("Using jupyter connection for imjoy-rpc")
        from .connection.jupyter_connection import JupyterCommManager

        manager = JupyterCommManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
        )
        manager.start(
            on_ready_callback=on_ready_callback, on_error_callback=on_error_callback
        )
    elif connection_type == "colab":
        if logger:
            logger.info("Using colab connection for imjoy-rpc")
        from .connection.colab_connection import ColabManager

        manager = ColabManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
        )
        manager.start(
            on_ready_callback=on_ready_callback, on_error_callback=on_error_callback
        )
    elif connection_type == "terminal":
        if logger:
            logger.info("Using socketio connection for imjoy-rpc")
        from .connection.socketio_connection import SocketIOManager

        manager = SocketIOManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
        )
        manager.start(
            _rpc_context.default_config.get("server_url"),
            _rpc_context.default_config.get("token"),
            on_ready_callback=on_ready_callback,
            on_error_callback=on_error_callback,
        )
    elif connection_type == "pyodide":
        if logger:
            logger.info("Using colab connection for imjoy-rpc")
        from .connection.pyodide_connection import PyodideConnectionManager

        manager = PyodideConnectionManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
        )
        manager.start(
            on_ready_callback=on_ready_callback, on_error_callback=on_error_callback
        )
    else:
        if logger:
            logger.info(
                "There is no connection set for imjoy-rpc, connection type: %s",
                connection_type,
            )


def type_of_script():
    """Return the type of the script."""
    try:
        import google.colab.output  # noqa: F401

        return "colab"
    except ImportError:
        try:
            # check if get_ipython exists without exporting it
            # from IPython import get_ipython
            ipy_str = str(type(get_ipython()))  # noqa: F821
            if "zmqshell" in ipy_str:
                return "jupyter"
            if "terminal" in ipy_str:
                return "ipython"
        except NameError:
            try:
                import js  # noqa: F401
                import pyodide  # noqa: F401

                return "pyodide"
            except ImportError:
                return "terminal"
