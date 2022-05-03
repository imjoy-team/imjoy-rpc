"""Provide common pytest fixtures."""
import os
import subprocess
import sys
import time
import uuid

import pytest
import requests
from requests import RequestException
from . import WS_PORT


JWT_SECRET = str(uuid.uuid4())
os.environ["JWT_SECRET"] = JWT_SECRET
test_env = os.environ.copy()


@pytest.fixture(name="socketio_server", scope="session")
def socketio_server_fixture():
    """Start server as test fixture and tear down after test."""
    with subprocess.Popen(
        [sys.executable, "-m", "hypha.server", f"--port={WS_PORT}"],
        env=test_env,
    ) as proc:

        timeout = 10
        while timeout > 0:
            try:
                response = requests.get(f"http://127.0.0.1:{WS_PORT}/health/liveness")
                if response.ok:
                    break
            except RequestException:
                pass
            timeout -= 0.1
            time.sleep(0.1)
        yield
        proc.kill()
        proc.terminate()
