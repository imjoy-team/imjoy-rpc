"""Test the hypha server."""
import pytest
from imjoy_rpc.hypha import (
    login,
    connect_to_server,
    login_sync,
    connect_to_server_sync,
    register_rtc_service,
    get_rtc_service,
    register_rtc_service_sync,
    get_rtc_service_sync,
)
from . import WS_SERVER_URL
import numpy as np
import requests
import asyncio


class ImJoyPlugin:
    """Represent a test plugin."""

    def __init__(self, ws):
        """Initialize the plugin."""
        self._ws = ws

    # async def setup(self):
    #     """Set up the plugin."""
    #     await self._ws.log("initialized")

    async def run(self, ctx):
        """Run the plugin."""
        await self._ws.log("hello world")

    async def add(self, data):
        """Add function."""
        return data + 1.0


@pytest.mark.asyncio
async def test_login(websocket_server):
    """Test login to the server."""
    TOKEN = "sf31df234"

    async def callback(context):
        print(f"By passing login: {context['login_url']}")
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            requests.get,
            context["report_url"] + "?key=" + context["key"] + "&token=" + TOKEN,
        )

    # We use ai.imjoy.io to test the login for now
    token = await login(
        {
            "server_url": "https://ai.imjoy.io",
            "login_callback": callback,
            "login_timeout": 3,
        }
    )
    assert token == TOKEN


def test_login_sync(websocket_server):
    """Test login to the server."""
    TOKEN = "sf31df234"

    def callback(context):
        print(f"By passing login: {context['login_url']}")
        requests.get(
            context["report_url"] + "?key=" + context["key"] + "&token=" + TOKEN
        )

    # We use ai.imjoy.io to test the login for now
    token = login_sync(
        {
            "server_url": "https://ai.imjoy.io",
            "login_callback": callback,
            "login_timeout": 3,
        }
    )
    assert token == TOKEN


@pytest.mark.asyncio
async def test_numpy_array_sync(websocket_server):
    """Test numpy array registered in async."""
    ws = connect_to_server_sync(
        {"client_id": "test-plugin", "server_url": WS_SERVER_URL}
    )
    ws.export(ImJoyPlugin(ws))
    workspace = ws.config.workspace
    token = ws.generate_token()

    api = await connect_to_server(
        {
            "client_id": "client",
            "workspace": workspace,
            "token": token,
            "server_url": WS_SERVER_URL,
        }
    )
    plugin = await api.get_service("test-plugin:default")
    result = await plugin.add(2.1)
    assert result == 2.1 + 1.0

    large_array = np.zeros([2048, 2048, 4], dtype="float32")
    result = await plugin.add(large_array)
    np.testing.assert_array_equal(result, large_array + 1.0)


def test_connect_to_server_sync(websocket_server):
    """Test connecting to the server sync."""
    # Now all the functions are sync
    server = connect_to_server_sync(
        {"client_id": "test-plugin", "server_url": WS_SERVER_URL}
    )
    workspace = server.config.workspace
    token = server.generate_token()
    assert workspace and token

    services = server.list_services("public")
    assert isinstance(services, list)

    def hello(name):
        print("Hello " + name)
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


@pytest.mark.asyncio
async def test_connect_to_server(websocket_server):
    """Test connecting to the server."""
    # test workspace is an exception, so it can pass directly
    ws = await connect_to_server({"name": "my plugin", "server_url": WS_SERVER_URL})
    with pytest.raises(Exception, match=r".*Permission denied for.*"):
        ws = await connect_to_server(
            {"name": "my plugin", "workspace": "test", "server_url": WS_SERVER_URL}
        )
    ws = await connect_to_server({"name": "my plugin", "server_url": WS_SERVER_URL})
    await ws.export(ImJoyPlugin(ws))

    def hello(name, key=12):
        """Say hello."""
        print("Hello " + name)
        return "Hello " + name

    await ws.register_service(
        {
            "name": "Hello World",
            "id": "hello-world",
            "description": "hello world service",
            "config": {
                "visibility": "protected",
                "run_in_executor": True,
            },
            "hello": hello,
        }
    )

    svc = await ws.get_service("hello-world")
    assert svc.hello.__doc__ == f"hello(name, key=12)\n{hello.__doc__}"


@pytest.mark.asyncio
async def test_reconnect_to_server(websocket_server):
    """Test reconnecting to the server."""
    # test workspace is an exception, so it can pass directly
    ws = await connect_to_server({"name": "my plugin", "server_url": WS_SERVER_URL})
    await ws.register_service(
        {
            "name": "Hello World",
            "id": "hello-world",
            "description": "hello world service",
            "config": {
                "visibility": "protected",
                "run_in_executor": True,
            },
            "hello": lambda x: "hello " + x,
        }
    )
    # simulate abnormal close
    await ws.rpc._connection._websocket.close(1010)
    # will trigger reconnect
    svc = await ws.get_service("hello-world")
    assert await svc.hello("world") == "hello world"


@pytest.mark.asyncio
async def test_numpy_array(websocket_server):
    """Test numpy array."""
    ws = await connect_to_server(
        {"client_id": "test-plugin", "server_url": WS_SERVER_URL}
    )
    await ws.export(ImJoyPlugin(ws))
    workspace = ws.config.workspace
    token = await ws.generate_token()

    api = await connect_to_server(
        {
            "client_id": "client",
            "workspace": workspace,
            "token": token,
            "server_url": WS_SERVER_URL,
        }
    )
    plugin = await api.get_service("test-plugin:default")
    result = await plugin.add(2.1)
    assert result == 2.1 + 1.0

    large_array = np.zeros([2048, 2048, 4], dtype="float32")
    result = await plugin.add(large_array)
    np.testing.assert_array_equal(result, large_array + 1.0)


@pytest.mark.asyncio
async def test_rtc_service(websocket_server):
    """Test RTC service."""
    from imjoy_rpc.hypha import connect_to_server

    service_id = "test-rtc-service"
    server = await connect_to_server(
        {
            "server_url": WS_SERVER_URL,
        }
    )
    await server.register_service(
        {
            "id": "echo-service",
            "config": {"visibility": "public"},
            "type": "echo",
            "echo": lambda x: x,
        }
    )
    await register_rtc_service(server, service_id)
    pc = await get_rtc_service(server, service_id)
    svc = await pc.get_service("echo-service")
    assert await svc.echo("hello") == "hello", "echo service failed"
    await pc.close()


def test_rtc_service_sync(websocket_server):
    """Test RTC service."""
    from imjoy_rpc.hypha import connect_to_server_sync

    service_id = "test-rtc-service"
    server = connect_to_server_sync(
        {
            "server_url": WS_SERVER_URL,
        }
    )
    server.register_service(
        {
            "id": "echo-service",
            "config": {"visibility": "public"},
            "type": "echo",
            "echo": lambda x: x,
        }
    )
    register_rtc_service_sync(server, service_id)
    pc = get_rtc_service_sync(server, service_id)
    svc = pc.get_service("echo-service")
    assert svc.echo("hello") == "hello", "echo service failed"
    pc.close()
