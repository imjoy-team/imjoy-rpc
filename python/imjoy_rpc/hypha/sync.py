import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from imjoy_rpc.hypha import (
    connect_to_server as connect_to_server_async,
    register_rtc_service as register_rtc_service_async,
    get_rtc_service as get_rtc_service_async,
)
import time
from imjoy_rpc.hypha.utils import dotdict
from imjoy_rpc.hypha.websocket_client import normalize_server_url

import inspect


def get_async_methods(instance):
    methods = []
    for attr_name in dir(instance):
        if not attr_name.startswith("_"):
            attr_value = getattr(instance, attr_name)
            if inspect.iscoroutinefunction(attr_value):
                methods.append(attr_name)
    return methods


def convert_sync_to_async(sync_func, loop, executor):
    if asyncio.iscoroutinefunction(sync_func):
        return sync_func

    async def wrapped_async(*args, **kwargs):
        result_future = loop.create_future()

        def run_and_set_result():
            try:
                result = sync_func(*args, **kwargs)
                loop.call_soon_threadsafe(result_future.set_result, result)
            except Exception as e:
                loop.call_soon_threadsafe(result_future.set_exception, e)

        executor.submit(run_and_set_result)
        result = await result_future
        obj = _encode_callables(result, convert_async_to_sync, loop, executor)
        return obj

    return wrapped_async


def convert_async_to_sync(async_func, loop, executor):
    def wrapped_sync(*args, **kwargs):
        # Recursively encode callables in args
        args = _encode_callables(args, convert_sync_to_async, loop, executor)

        # Recursively encode callables in kwargs
        kwargs = _encode_callables(kwargs, convert_sync_to_async, loop, executor)

        async def async_wrapper():
            obj = await async_func(*args, **kwargs)
            return _encode_callables(obj, convert_async_to_sync, loop, executor)

        result = asyncio.run_coroutine_threadsafe(async_wrapper(), loop).result()
        return result

    return wrapped_sync


def _encode_callables(obj, wrap, loop, executor):
    if isinstance(obj, dict):
        return dotdict(
            {k: _encode_callables(v, wrap, loop, executor) for k, v in obj.items()}
        )
    elif isinstance(obj, (list, tuple)):
        return [_encode_callables(item, wrap, loop, executor) for item in obj]
    elif callable(obj):
        return wrap(obj, loop, executor)
    else:
        return obj


class SyncHyphaServer:
    def __init__(self):
        self.loop = None
        self.thread = None
        self.server = None
        self.executor = ThreadPoolExecutor(max_workers=1)

    async def _connect(self, config):
        config["loop"] = self.loop
        self.server = await connect_to_server_async(config)
        skip_keys = ["register_codec"]
        skipped = {k: v for k, v in self.server.items() if k not in skip_keys}
        obj = _encode_callables(
            skipped, convert_async_to_sync, self.loop, self.executor
        )
        for k in skip_keys:
            obj[k] = self.server[k]
        # copy all the attributes from the encoded server object
        for k, v in obj.items():
            setattr(self, k, v)

    def _start_loop(self):
        asyncio.set_event_loop(asyncio.new_event_loop())
        self.loop = asyncio.get_event_loop()
        self.loop.run_forever()


def connect_to_server(config):
    server = SyncHyphaServer()

    if not server.loop:
        server.thread = threading.Thread(target=server._start_loop, daemon=True)
        server.thread.start()

    while not server.loop or not server.loop.is_running():
        pass  # Wait until loop is running

    future = asyncio.run_coroutine_threadsafe(server._connect(config), server.loop)
    future.result()  # Wait for the server to start

    return server


def login(config):
    """Login to the hypha server."""
    server_url = normalize_server_url(config.get("server_url"))
    service_id = config.get("login_service_id", "public/*:hypha-login")
    timeout = config.get("login_timeout", 60)
    callback = config.get("login_callback")

    server = connect_to_server(
        {"name": "initial login client", "server_url": server_url}
    )
    try:
        svc = server.get_service(service_id)
        context = svc.start()
        if callback:
            callback(context)
        else:
            print(f"Please open your browser and login at {context['login_url']}")

        return svc.check(context["key"], timeout)
    except Exception as error:
        raise error
    finally:
        server.disconnect()


def register_rtc_service(server, service_id, config=None):
    assert isinstance(
        server, SyncHyphaServer
    ), "server must be an instance of SyncHyphaServer, please use hypha.sync.connect_to_server to create a server instance."
    future = asyncio.run_coroutine_threadsafe(
        register_rtc_service_async(
            server.server,
            service_id,
            _encode_callables(
                config, convert_sync_to_async, server.loop, server.executor
            ),
        ),
        server.loop,
    )
    future.result()  # Wait for the service to register


def get_rtc_service(server, service_id, config=None):
    assert isinstance(
        server, SyncHyphaServer
    ), "server must be an instance of SyncHyphaServer, please use hypha.sync.connect_to_server to create a server instance."

    future = asyncio.run_coroutine_threadsafe(
        get_rtc_service_async(
            server.server,
            service_id,
            _encode_callables(
                config, convert_sync_to_async, server.loop, server.executor
            ),
        ),
        server.loop,
    )
    pc = future.result()
    for func in get_async_methods(pc):
        setattr(
            pc,
            func,
            convert_async_to_sync(getattr(pc, func), server.loop, server.executor),
        )
    return pc


if __name__ == "__main__":
    server_url = "https://ai.imjoy.io"
    server = connect_to_server({"server_url": server_url})

    # Now all the functions are sync
    services = server.list_services("public")
    print("Public services: #", len(services))

    def hello(name):
        print("Hello " + name)
        # print the current thread id, check if it's the mainthread
        print("Current thread id: ", threading.get_ident(), threading.current_thread())
        time.sleep(2)
        return "Hello " + name

    server.register_service(
        {
            "name": "Hello World",
            "id": "hello-world",
            "config": {
                "visibility": "protected",
                "run_in_executor": True,
            },
            "hello": hello,
        }
    )

    workspace = server.config.workspace
    token = server.generate_token()

    server2 = connect_to_server(
        {"server_url": server_url, "workspace": workspace, "token": token}
    )
    svc = server2.get_service("hello-world")
    print(svc.hello("Joy"))
    assert svc.hello("Joy") == "Hello Joy"

    register_rtc_service(
        server,
        service_id="webrtc-service",
        config={
            "visibility": "public",
            # "ice_servers": ice_servers,
        },
    )

    svc = get_rtc_service(server, "webrtc-service")

    while True:
        print(".", end="", flush=True)
        time.sleep(1)
