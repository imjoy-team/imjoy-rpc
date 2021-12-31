"""Test the hypha server."""
import pytest
from imjoy_rpc import connect_to_server
from . import SIO_SERVER_URL
import numpy as np

# All test coroutines will be treated as marked.
pytestmark = pytest.mark.asyncio


class ImJoyPlugin:
    """Represent a test plugin."""

    def __init__(self, ws):
        """Initialize the plugin."""
        self._ws = ws

    async def setup(self):
        """Set up the plugin."""
        await self._ws.log("initialized")

    async def run(self, ctx):
        """Run the plugin."""
        await self._ws.log("hello world")

    async def add(self, data):
        """Add function."""
        return data + 1.0


async def test_connect_to_server(socketio_server):
    """Test connecting to the server."""
    # test workspace is an exception, so it can pass directly
    ws = await connect_to_server(
        {"name": "my plugin", "workspace": "public", "server_url": SIO_SERVER_URL}
    )
    with pytest.raises(Exception, match=r".*Workspace test does not exist.*"):
        ws = await connect_to_server(
            {"name": "my plugin", "workspace": "test", "server_url": SIO_SERVER_URL}
        )
    ws = await connect_to_server({"name": "my plugin", "server_url": SIO_SERVER_URL})
    await ws.export(ImJoyPlugin(ws))

    ws = await connect_to_server({"server_url": SIO_SERVER_URL})
    assert len(ws.config.name) == 36


async def test_numpy_array(socketio_server):
    """Test numpy array."""
    ws = await connect_to_server(
        {"name": "test-plugin", "workspace": "public", "server_url": SIO_SERVER_URL}
    )
    await ws.export(ImJoyPlugin(ws))

    api = await connect_to_server(
        {"name": "client", "workspace": "public", "server_url": SIO_SERVER_URL}
    )
    plugin = await api.get_plugin("test-plugin")
    result = await plugin.add(2.1)
    assert result == 2.1 + 1.0

    large_array = np.zeros([2048, 2048, 4], dtype="float32")
    result = await plugin.add(large_array)
    np.testing.assert_array_equal(result, large_array + 1.0)
