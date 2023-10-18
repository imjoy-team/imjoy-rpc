"""Provide utility functions for RPC."""
import sys

if sys.version_info < (3, 7):
    import aiocontextvars  # noqa: F401

import asyncio
import contextvars
import copy
import io
import locale
import os
import secrets
import string
import threading
import traceback
import uuid
import base64
import json

from .werkzeug.local import Local


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

    def __init__(self, pfunc, logger=None, dispose=None):
        """Set up promise."""
        Promise.__init__(self, pfunc, logger)
        asyncio.Future.__init__(self)
        self.__dispose = dispose
        self.__obj = None

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


def setup_js_socketio(config, resolve, reject):
    """Load socketio in javascript."""
    from js import eval

    script = """
    let loadScript;
    if (
        typeof WorkerGlobalScope !== "undefined" &&
        self instanceof WorkerGlobalScope
    ) {
        loadScript = async function(url) {
            importScripts(url);
        }
    }
    else{
        function _importScript(url) {
            //url is URL of external file, implementationCode is the code
            //to be called from the file, location is the location to
            //insert the <script> element
            return new Promise((resolve, reject) => {
            var scriptTag = document.createElement("script");
            scriptTag.src = url;
            scriptTag.type = "text/javascript";
            scriptTag.onload = resolve;
            scriptTag.onreadystatechange = function() {
                if (this.readyState === "loaded" || this.readyState === "complete") {
                resolve();
                }
            };
            scriptTag.onerror = reject;
            document.head.appendChild(scriptTag);
            });
        }

        // support loadScript outside web worker
        loadScript = async function() {
            var args = Array.prototype.slice.call(arguments),
            len = args.length,
            i = 0;
            for (; i < len; i++) {
            await _importScript(args[i]);
            }
        }
    }
    const socketio_lib_url = "https://cdn.jsdelivr.net/npm/" +
    "socket.io-client@4.0.1/dist/socket.io.min.js";
    globalThis.setupJSSocketIo = async function(config, resolve, reject){
        try{
            await loadScript(socketio_lib_url)
            const toObject = (x) => {
                if(x===undefined || x===null) return x;
                return x.toJs({dict_converter : Object.fromEntries})
            }
            config = toObject(config)
            config.server_token=config.token
            globalThis.config = config
            const url = config.server_url;
            const extraHeaders = {};
            if (config.token) {
                extraHeaders.Authorization = "Bearer " + config.token;
            }
            // const basePath = new URL(url).pathname;
            // Note: extraHeaders only works for polling transport (the default)
            // If we switch to websocket only, the headers won't be respected
            if(globalThis.socket){
                globalThis.socket.disconnect();
            }
            const socket = io(url, {
                withCredentials: true,
                extraHeaders,
            });
            let connected = false;
            socket.on("connect", () => {
                if(connected) {
                    console.warn("Skipping reconnect to the server");
                    return
                }

                globalThis.sendMessage = function(data){

                    return new Promise((resolve, reject)=>{
                        try{
                            data = toObject(data)
                            socket.emit("plugin_message", data, result => {
                                if (!result.success) reject(result.detail)
                                else resolve(result)
                            })
                        }
                        catch(e){
                            reject(e)
                        }

                    })
                }

                socket.emit("register_plugin", config, async (result) => {
                    if (!result.success) {
                        console.error(result.detail);
                        reject(result.detail);
                        return;
                    }
                    connected = true;
                    globalThis.setMessageCallback = (cb)=>{
                        socket.on("plugin_message", cb);
                    }
                    console.log("Plugin registered: " + config.name)
                    resolve();
                })

                socket.on("connect_error", (error) => {
                    console.error("connection error", error);
                    reject(`${error}`);
                });
                socket.on("disconnect", () => {
                    console.error("disconnected");
                    reject("disconnected");
                });
            })
            globalThis.socket = socket;
        }
        catch(e){
            reject(`${error}`);
        }
    }
    """

    eval(script)(config, resolve, reject)


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
            register_codec=manager.register_codec,
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
            register_codec=manager.register_codec,
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
            register_codec=manager.register_codec,
        )
        manager.start(
            _rpc_context.default_config.get("server_url"),
            _rpc_context.default_config.get("token"),
            on_ready_callback=on_ready_callback,
            on_error_callback=on_error_callback,
        )
    elif connection_type == "pyodide-socketio":
        if logger:
            logger.info("Using pyodide-socketio connection for imjoy-rpc")
        from .connection.pyodide_connection import PyodideConnectionManager

        manager = PyodideConnectionManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
            register_codec=manager.register_codec,
        )

        def resolve():
            manager.start(
                on_ready_callback=on_ready_callback,
                on_error_callback=on_error_callback,
            )

        def reject(error):
            if on_error_callback:
                on_error_callback(error)

        setup_js_socketio(_rpc_context.default_config, resolve, reject)

    elif connection_type == "pyodide":
        if logger:
            logger.info("Using pyodide connection for imjoy-rpc")
        from .connection.pyodide_connection import PyodideConnectionManager

        manager = PyodideConnectionManager(_rpc_context)
        _rpc_context.api = dotdict(
            init=manager.init,
            export=manager.set_interface,
            registerCodec=manager.register_codec,
            register_codec=manager.register_codec,
        )
        manager.start(
            None,
            on_ready_callback=on_ready_callback,
            on_error_callback=on_error_callback,
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
            import js  # noqa: F401
            import pyodide  # noqa: F401

            return "pyodide"
        except ImportError:
            try:
                # check if get_ipython exists without exporting it
                # from IPython import get_ipython
                ipy_str = str(type(get_ipython()))  # noqa: F821
                if "zmqshell" in ipy_str:
                    return "jupyter"
                if "terminal" in ipy_str:
                    return "ipython"
                else:
                    return "unknown"
            except NameError:
                return "unknown"


try:
    from js import eval, location

    _sync_xhr_head = eval(
        """globalThis._sync_xhr_head = function(url){
        var request = new XMLHttpRequest();
        request.open('HEAD', url, false);  // `false` makes the request synchronous
        request.send(null);
        return request
    }
    """
    )

    _sync_xhr_get = eval(
        """globalThis._sync_xhr_get = function(url, start, end){
        var request = new XMLHttpRequest();
        request.open('GET', url, false);  // `false` makes the request synchronous
        if(typeof start === 'number' && typeof end === 'number' ){
            request.setRequestHeader("range", `bytes=${start||0}-${end||0}`)
        }
        request.responseType = "arraybuffer";
        request.send(null);
        return request
    }
    """
    )

    _sync_xhr_post = eval(
        """globalThis._sync_xhr_post = function(url, rawData, type, append){
        var request = new XMLHttpRequest();
        request.open('POST', url, false);  // `false` makes the request synchronous
        var formData = new FormData();
        var file = new Blob([new Uint8Array(rawData)],{type});
        formData.append("file", file);
        if(append) formData.append("append", "1");
        request.send(formData);
        return request
    }
    """
    )

    _sync_xhr_put = eval(
        """globalThis._sync_xhr_put = function(url, rawData, type, append){
        if(append) throw new Error("append is not supported for put requests");
        var request = new XMLHttpRequest();
        request.open('PUT', url, false);  // `false` makes the request synchronous
        var formData = new FormData();
        var file = new Blob([new Uint8Array(rawData)],{type});
        request.send(file);
        return request
    }
    """
    )
    IS_PYODIDE = True
except ImportError:
    from urllib.request import Request, urlopen

    IS_PYODIDE = False


class HTTPFile(io.IOBase):
    """A virtual file for reading content via HTTP."""

    def __init__(
        self,
        url,
        mode="r",
        encoding=None,
        newline=None,
        name=None,
        upload_method="POST",
    ):
        """Initialize the http file object."""
        self._url = url
        self._pos = 0
        self._size = None
        self._mode = mode
        self.name = name
        assert mode in ["r", "rb", "w", "wb", "a", "ab"]
        self._encoding = encoding or locale.getpreferredencoding()
        self._newline = newline or os.linesep
        if "w" not in self._mode:
            # make a request so we can see the self._size
            self._size = self._get_size()
            assert self._size is not None
        self._chunk = 1024
        self._initial_request = True
        assert upload_method in ["POST", "PUT"]
        self._upload_method = upload_method
        self._closed = False

    def tell(self):
        """Tell the position of the pointer."""
        return self._pos

    def write(self, content):
        """Write content to file."""
        if "a" not in self._mode and "w" not in self._mode:
            raise Exception(f"write is not supported with mode {self._mode}")

        if "b" in self._mode:
            self._upload(content)
        else:
            self._upload(content.encode(self._encoding))

    def seekable(self):
        """Whether the file is seekable."""
        return "w" not in self._mode

    def read(self, length=-1):
        """Read the file from the current pointer position."""
        if self._pos >= self._size:
            return ""  # EOF
        if length < 0:
            end = self._size + length
        else:
            end = self._pos + length - 1
        if end >= self._size:
            end = self._size - 1
        result = self._request_range(self._pos, end)
        self._pos += len(result)
        if self._mode == "r":
            return result.decode(self._encoding)
        return result

    def readline(self, size=-1):
        """Read a line."""
        if self._mode == "r":
            terminator = self._newline
            result = ""
        else:
            terminator = b"\n"
            result = b""
        while True:
            ret = self.read(self._chunk)
            if ret == "":
                break
            if terminator in ret:
                used = ret.split(terminator)[0] + terminator
                unused = ret[len(used) :]
                # rollback
                self._pos -= len(unused)
                result += used
                break
            result += ret

            if size is not None and size > 0:
                if len(result) > size:
                    return result[:size]

        if not result:
            return ""
        return result

    def readlines(self, hint=-1):
        """Read all the lines."""
        if hint is None or hint < 0:
            hint = None

        lines = []
        while True:
            line = self.readline()
            if line == "":
                break
            else:
                lines.append(line)
            if hint and len(lines) >= hint:
                break
        return lines

    def seek(self, offset, whence=0):
        """Set the pointer position."""
        if whence == 0:
            self._pos = offset
        elif whence == 1:
            self._pos = self._pos + offset
        elif whence == 2:
            self._pos = self._size + offset
        return self._pos

    def _upload(self, content):
        if IS_PYODIDE:
            if self._initial_request and "a" not in self._mode:
                append = False
            else:
                append = True

            if self._upload_method == "POST":
                req = _sync_xhr_post(
                    self._url, content, "application/octet-stream", append
                )
            elif self._upload_method == "PUT":
                req = _sync_xhr_post(
                    self._url, content, "application/octet-stream", append
                )
            if req.status != 200:
                raise Exception(f"Failed to write: {req.response}, {req.status}")

            if self._initial_request:
                self._initial_request = False
        else:
            raise NotImplementedError

    def _get_size(self):
        if IS_PYODIDE:
            req = _sync_xhr_head(self._url)
            if req.status in [200]:
                length = req.getResponseHeader("Content-Length")
                return int(length)
            else:
                raise Exception(f"Failed to fetch: {req.status}")
        else:
            req = Request(self._url, method="HEAD")
            response = urlopen(req)
            if response.getcode() in [200]:
                length = response.getheader("Content-Length")
                return int(length)
            else:
                raise Exception(f"Failed to fetch: {response.getcode()}")

    def _request_range(self, start, end):
        assert isinstance(start, int) and isinstance(end, int)
        assert start <= end
        if IS_PYODIDE:
            req = _sync_xhr_get(self._url, start, end)
            if req.status in [200, 206]:
                result = req.response.to_py().tobytes()
                crange = req.getResponseHeader("Content-Range")
                if crange:
                    self._size = int(crange.split("/")[1])
            else:
                raise Exception(f"Failed to fetch: {req.status}")
        else:
            req = Request(self._url, method="GET")
            req.add_header("range", f"bytes={start}-{end}")
            response = urlopen(req)
            if response.getcode() in [200, 206]:
                crange = response.getheader("Content-Range")
                if crange:
                    self._size = int(crange.split("/")[1])
                result = response.read()
            else:
                raise Exception(f"Failed to fetch: {response.getcode()}")
        return result

    def close(self):
        """Close the file."""
        self._closed = True


def open_elfinder(path, mode="r", encoding=None, newline=None):
    """Open an HTTPFile from elFinder."""
    if not path.startswith("http"):
        url = location.origin + "/fs" + path
    else:
        url = path
    return HTTPFile(url, mode=mode, encoding=encoding, newline=newline, name=path)


def elfinder_listdir(path):
    """List the directory from elFinder."""
    assert path.startswith("/"), "path must start with /"
    if path == "/":
        return ["home", "tmp"]
    # extract the first part of the path
    parts = path.split("/")
    base_path = parts[1]
    path = "/".join(parts[2:])
    if not path:
        path = "/"
    # Base64 encode the path
    encoded_path = base64.b64encode(path.encode()).decode()
    if base_path == "home":
        base = "v0_"
    elif base_path == "tmp":
        base = "v1_"
    else:
        base = "v2_"
    # Prepare the target parameter
    target_param = base + encoded_path

    # Prepare the URL
    url = f"{location.origin}/fs/connector?cmd=ls&target={target_param}"

    if IS_PYODIDE:
        req = _sync_xhr_get(url)
        if req.status in [200, 206]:
            file_list = json.loads(req.response.to_py().tobytes().decode())
            if 'list' in file_list:
                return file_list['list']
            else:
                return []
        else:
            raise FileNotFoundError(f"Directory '{path}' could not be found, HTTP status code: {req.status}")
    else:
        req = Request(url)
        response = urlopen(req)
        if response.getcode() == 200:
            file_list = json.loads(response.read().decode())
            if 'list' in file_list:
                return file_list['list']
            else:
                return []
        else:
            raise FileNotFoundError(f"Directory '{path}' could not be found, HTTP status code: {response.getcode()}")
