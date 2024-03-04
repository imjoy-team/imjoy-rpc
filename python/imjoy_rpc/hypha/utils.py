"""Provide utility functions for RPC."""
import ast
import asyncio
import contextlib
import copy
import inspect
import io
import re
import secrets
import string
import traceback
from functools import partial
from inspect import Parameter, Signature, signature
from types import BuiltinFunctionType, FunctionType
from typing import Any


def generate_password(length=50):
    """Generate a password."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for i in range(length))


_hash_id = generate_password()


class dotdict(dict):  # pylint: disable=invalid-name
    """Access dictionary attributes with dot.notation."""

    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __setattr__(self, name, value):
        """Set the attribute."""
        # Make an exception for __rid__
        if name == "__rid__":
            super().__setattr__("__rid__", value)
        else:
            super().__setitem__(name, value)

    def __hash__(self):
        """Return the hash."""
        if self.__rid__ and type(self.__rid__) is str:
            return hash(self.__rid__ + _hash_id)

        # FIXME: This does not address the issue of inner list
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


class Promise(object):  # pylint: disable=useless-object-inheritance
    """Represent a promise."""

    def __init__(self, pfunc, logger=None):
        """Set up promise."""
        self._resolve_handler = None
        self._finally_handler = None
        self._catch_handler = None
        self._logger = logger

        def resolve(*args, **kwargs):
            return self.resolve(*args, **kwargs)

        def reject(*args, **kwargs):
            return self.reject(*args, **kwargs)

        try:
            pfunc(resolve, reject)
        except Exception as exp:
            logger.error("Uncaught Exception: {}".format(exp))
            reject(exp)

    def resolve(self, result):
        """Resolve promise."""
        try:
            if self._resolve_handler:
                return self._resolve_handler(result)
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
                return self._catch_handler(error)
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

    def __init__(self, pfunc, logger=None, dispose=None, loop=None):
        """Set up promise."""
        self.__dispose = dispose
        self.__obj = None
        asyncio.Future.__init__(self, loop=loop)
        Promise.__init__(self, pfunc, logger)

    async def __aenter__(self):
        """Enter context for async."""
        ret = await self
        if isinstance(ret, dict):
            if "__enter__" in ret:
                ret = await ret["__enter__"]()
            self.__obj = ret
        return ret

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Exit context for async."""
        if self.__obj:
            if "__exit__" in self.__obj:
                await self.__obj["__exit__"]()
            if self.__dispose:
                await self.__dispose(self.__obj)
            del self.__obj

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


def extract_function_info(func):
    """Extract function info."""
    # Create an in-memory text stream
    f = io.StringIO()

    # Redirect the output of help to the text stream
    with contextlib.redirect_stdout(f):
        help(func)
    help_string = f.getvalue()
    match = re.search(r"(\w+)\((.*?)\)\n\s*(.*)", help_string, re.DOTALL)
    if match:
        func_name, func_signature, docstring = match.groups()
        # Clean up the docstring
        docstring = func.__doc__ or re.sub(r"\n\s*", " ", docstring).strip()
        return {"name": func_name, "sig": func_signature, "doc": docstring}
    else:
        return None


def make_signature(func, name=None, sig=None, doc=None):
    """Change signature of func to sig, preserving original behavior.

    sig can be a Signature object or a string without 'def' such as
    "foo(a, b=0)"
    """

    if isinstance(sig, str):
        # Parse signature string
        func_name, sig = _str_to_signature(sig)
        name = name or func_name

    if sig:
        func.__signature__ = sig
        annotations = {}
        for k, param in sig.parameters.items():
            if param.annotation is not param.empty:
                annotations[k] = param.annotation
        func.__annotations__ = annotations

    if doc:
        func.__doc__ = doc

    if name:
        func.__name__ = name


def _str_to_signature(sig_str):
    """Parse signature string into name and Signature object."""
    sig_str = sig_str.strip()
    # Map of common type annotations
    type_map = {
        "int": int,
        "str": str,
        "bool": bool,
        "float": float,
        "dict": dict,
        "list": list,
        "None": type(None),
        "Any": Any,
    }

    # Split sig_str into parameter part and return annotation part
    parts = sig_str.split("->")
    if len(parts) == 2:
        sig_str, return_anno = parts
        return_anno = return_anno.strip()
        if return_anno in type_map:
            return_anno = type_map[return_anno]
    elif len(parts) == 1:
        return_anno = None
    else:
        raise SyntaxError(f"Invalid signature: {sig_str}")

    func_def = re.compile(r"(\w+)\((.*)\)")

    m = func_def.match(sig_str)
    if not m:
        raise SyntaxError(f"Invalid signature: {sig_str}")

    params_str = m.group(2)
    func_name = m.group(1)

    positional_params = []
    keyword_params = []
    variadic_params = []

    if params_str and params_str.strip():
        pattern = r",(?![^\[\]]*\])"
        for p in re.split(pattern, params_str):
            p = p.strip()
            if not p:  # Skip if p is empty
                continue

            if p.startswith("**"):
                # **kwargs
                variadic_params.append(Parameter(p.lstrip("**"), Parameter.VAR_KEYWORD))
                continue

            if p.startswith("*"):
                # *args
                variadic_params.append(
                    Parameter(p.lstrip("*"), Parameter.VAR_POSITIONAL)
                )
                continue

            name, anno, default = p, Parameter.empty, Parameter.empty
            if ":" in p:
                # Type annotation
                p_split = p.split(":")
                name = p_split[0].strip()
                anno_str = p_split[1].strip()
                if "=" in anno_str:
                    anno, default = anno_str.split("=")
                    anno = anno.strip()
                    default = default.strip()
                else:
                    anno = anno_str

            else:
                if "=" in p:
                    # Keyword argument
                    name, default = p.split("=")
                    name = name.strip()
                    default = default.strip()

            if isinstance(default, str):
                default = ast.literal_eval(default)
            if isinstance(anno, str):
                anno = type_map.get(anno, Any)

            parameter = Parameter(
                name,
                Parameter.POSITIONAL_OR_KEYWORD,
                default=default,
                annotation=anno,
            )
            if "=" in p:
                keyword_params.append(parameter)
            else:
                positional_params.append(parameter)

    params = positional_params + keyword_params + variadic_params

    if return_anno:
        return func_name, Signature(parameters=params, return_annotation=return_anno)
    else:
        return func_name, Signature(parameters=params)


def callable_sig(any_callable, skip_context=False):
    """Return the signature of a callable."""
    try:
        if isinstance(any_callable, partial):
            signature = inspect.signature(any_callable.func)
            name = any_callable.func.__name__
            fixed = set(any_callable.keywords)
        elif inspect.isclass(any_callable):
            signature = inspect.signature(any_callable.__call__)
            name = any_callable.__name__
            fixed = set()
        elif hasattr(any_callable, "__call__") and not isinstance(
            any_callable, (FunctionType, BuiltinFunctionType)
        ):
            signature = inspect.signature(any_callable)
            name = type(any_callable).__name__
            fixed = set()
        else:
            signature = inspect.signature(any_callable)
            name = any_callable.__name__
            fixed = set()
    except ValueError:
        # Provide a default signature for built-in functions
        signature = Signature(
            parameters=[
                Parameter(name="args", kind=Parameter.VAR_POSITIONAL),
                Parameter(name="kwargs", kind=Parameter.VAR_KEYWORD),
            ]
        )
        name = any_callable.__name__
        fixed = set()

    if skip_context:
        fixed.add("context")

    params = [p for name, p in signature.parameters.items() if name not in fixed]
    signature = Signature(parameters=params)

    # Remove invalid characters from name
    # e.g. <lambda> -> lambda
    name = re.sub(r"\W", "", name)

    primitive = True
    for p in signature.parameters.values():
        if (
            p.default is not None
            and p.default != inspect._empty
            and not isinstance(p.default, (str, int, float, bool, list, dict, tuple))
        ):
            primitive = False
    if primitive:
        sig_str = str(signature)
    else:
        sig_str = f"({', '.join([p.name for p in signature.parameters.values()])})"
    return f"{name}{sig_str}"


def callable_doc(any_callable):
    """Return the docstring of a callable."""
    if isinstance(any_callable, partial):
        return any_callable.func.__doc__

    try:
        return any_callable.__doc__
    except AttributeError:
        return None
