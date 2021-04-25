"""Provide basic tests for jupyter rpc."""

import datetime
import json
import subprocess
import sys
import time
import uuid

import pytest
import requests
from requests import RequestException
from websocket import create_connection

# The token is written on stdout when you start the notebook
PORT = 9999
BASE_URL = f"http://localhost:{PORT}"


@pytest.fixture(name="jupyter_server")
def jupyter_server_fixture():
    """Start server as test fixture and tear down after test."""
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "jupyter",
            "notebook",
            "--NotebookApp.token=''",
            "--NotebookApp.disable_check_xsrf=True",
            "--no-browser",
            f"--port={PORT}",
        ]
    )

    timeout = 5
    while timeout > 0:
        try:
            response = requests.get(BASE_URL + "/api/kernels")
            if response.ok:
                break
        except RequestException:
            pass
        timeout -= 0.1
        time.sleep(0.1)
    yield
    proc.terminate()
    proc.wait()


@pytest.fixture(name="websocket_connection")
def websocket_connection_fixture(jupyter_server):
    """Websocket connection fixture."""
    url = BASE_URL + "/api/kernels"
    response = requests.post(url)
    kernel = json.loads(response.text)
    assert "id" in kernel
    # Execution request/reply is done on websockets channels
    ws = create_connection(
        f"ws://localhost:{PORT}/api/kernels/" + kernel["id"] + "/channels"
    )
    yield ws
    ws.close()


def send_execute_request(code):
    """Send an execution request to the notebook server."""
    msg_type = "execute_request"
    content = {"code": code, "silent": False}
    hdr = {
        "msg_id": uuid.uuid1().hex,
        "username": "test",
        "session": uuid.uuid1().hex,
        "data": datetime.datetime.now().isoformat(),
        "msg_type": msg_type,
        "version": "5.0",
    }
    msg = {"header": hdr, "parent_header": hdr, "metadata": {}, "content": content}
    return msg


def execute(ws, code):
    """Execute python code in a Jupyter notebook."""
    ws.send(json.dumps(send_execute_request(code)))
    # We ignore all the other messages, we just get the code execution output
    msg_type = ""
    while True:
        rsp = json.loads(ws.recv())
        msg_type = rsp["msg_type"]
        if msg_type == "execute_reply":
            if rsp["content"]["status"] == "error":
                print(rsp["content"]["traceback"])
                raise RuntimeError("Failed to execute")
            else:
                assert rsp["content"]["status"] == "ok"
            break
        if msg_type == "stream":
            print(rsp["content"]["text"])


TEST_CODE = """
import asyncio
from imjoy_rpc import connect_to_jupyter, api

fut = connect_to_jupyter()
api.export({})
"""


def test_jupyter_rpc(websocket_connection):
    """Testing imjoy rpc in jupyter notebooks."""
    execute(websocket_connection, TEST_CODE)
