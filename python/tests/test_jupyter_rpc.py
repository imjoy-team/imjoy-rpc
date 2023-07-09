"""Provide basic tests for jupyter rpc."""
import uuid
import datetime
from jupyter_client.manager import KernelManager
import pytest


@pytest.fixture(name="jupyter_server")
def jupyter_server_fixture():
    """Start server as test fixture and tear down after test."""
    km = KernelManager()
    km.start_kernel()
    yield km
    km.shutdown_kernel()


@pytest.fixture(name="kernel_client")
def kernel_client_fixture(jupyter_server):
    """Kernel client fixture."""
    kc = jupyter_server.client()
    kc.start_channels()
    yield kc
    kc.stop_channels()


def send_execute_request(code):
    """Send an execution request to the notebook server."""
    msg_type = "execute_request"
    content = {"code": code, "silent": False}
    hdr = {
        "msg_id": uuid.uuid1().hex,
        "username": "test",
        "session": uuid.uuid1().hex,
        "date": datetime.datetime.now().isoformat(),
        "msg_type": msg_type,
        "version": "5.0",
    }
    msg = {"header": hdr, "parent_header": hdr, "metadata": {}, "content": content}
    return msg


def execute(kc, code):
    """Execute python code in a Jupyter notebook."""
    kc.execute(code)
    while True:
        msg = kc.get_iopub_msg()
        msg_type = msg["header"]["msg_type"]
        if msg_type == "execute_result":
            print(msg["content"]["data"])
            break
        elif msg_type == "stream":
            print(msg["content"]["text"])
        elif msg_type == "error":
            print(msg["content"]["traceback"])
            raise RuntimeError("Failed to execute")


TEST_CODE = """
import asyncio
from imjoy_rpc import connect_to_jupyter, api

fut = connect_to_jupyter()
api.export({})
"""


def test_jupyter_rpc(kernel_client):
    """Testing imjoy rpc in jupyter notebooks."""
    execute(kernel_client, TEST_CODE)
