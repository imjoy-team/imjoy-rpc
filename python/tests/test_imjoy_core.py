# stdlib imports
import os
import asyncio
from typing import Optional

# 3rd party imports
import pytest
import uvicorn

# FastAPI imports
from fastapi import FastAPI
from imjoy_rpc.imjoy_core.imjoy_core_server import JWT_SECRET, app
from imjoy_rpc.imjoy_core.plugin_runner import run_plugin
from jose import jwt

PORT = 8007


class UvicornTestServer(uvicorn.Server):
    """Uvicorn test server

    Usage:
        @pytest.fixture
        async def start_stop_server():
            server = UvicornTestServer()
            await server.up()
            yield
            await server.down()
    """

    def __init__(self, app: FastAPI, host: str = "127.0.0.1", port: int = PORT) -> None:
        """Create a Uvicorn test server

        Args:
            app (FastAPI, optional): the FastAPI app. Defaults to main.app.
            host (str, optional): the host ip. Defaults to '127.0.0.1'.
            port (int, optional): the port. Defaults to PORT.
        """
        self._startup_done = asyncio.Event()
        super().__init__(config=uvicorn.Config(app, host=host, port=port))

    async def startup(self, sockets: Optional[list] = None) -> None:
        """Override uvicorn startup"""
        await super().startup(sockets=sockets)
        self.config.setup_event_loop()
        self._startup_done.set()

    async def up(self) -> None:
        """Start up server asynchronously"""
        self._serve_task = asyncio.create_task(self.serve())
        await self._startup_done.wait()

    async def down(self) -> None:
        """Shut down server asynchronously"""
        self.should_exit = True
        await self._serve_task


@pytest.fixture
async def startup_and_shutdown_server():
    """Start server as test fixture and tear down after test"""
    import shlex
    import subprocess
    import sys
    import requests
    import time

    proc = subprocess.Popen([sys.executable, "-m", "imjoy_rpc.imjoy_core.imjoy_core_server", f'--port={PORT}'])

    timeout = 5
    while timeout > 0:
        try:
            r = requests.get(f'http://127.0.0.1:{PORT}/docs')
            if r.ok:
                break
        except:
            pass
        timeout -= 0.1
        time.sleep(0.1)
    yield
    proc.terminate()
    proc.wait()



async def test_plugin(startup_and_shutdown_server):
    """Create and return the client."""
    file = os.path.join(os.path.dirname(__file__), 'example_plugin.py')
    server = f'http://127.0.0.1:{startup_and_shutdown_server.config.port}'
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    def on_ready_callback(_):
        fut.set_result(None)

    from imjoy_rpc import default_config
    default_config.update({
        "name": "ImJoy Plugin", 
        "server": server,
        "token": None,
        "on_ready_callback": on_ready_callback
    })
    
    run_plugin(file)
    await fut