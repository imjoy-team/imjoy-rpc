"""Set up the ImJoy-Engine imjoy package."""
import json
from pathlib import Path

from setuptools import find_packages, setup

DESCRIPTION = (
    "ImJoy Plugin Engine for running Python plugins locally "
    "or remotely from ImJoy.io"
)

ROOT_DIR = Path(__file__).parent.resolve()
README_FILE = ROOT_DIR / "README.md"
LONG_DESCRIPTION = README_FILE.read_text(encoding="utf-8")
VERSION_FILE = ROOT_DIR / "imjoy_rpc" / "VERSION"
VERSION = json.loads(VERSION_FILE.read_text())["version"]

REQUIRES = [
    "aiocontextvars; python_version<'3.7'",
    "contextvars; python_version<'3.7'",
    "msgpack>=1.0.2",
    "shortuuid>=1.0.8",
    "websockets;platform_system!='Emscripten'",
]

setup(
    name="imjoy-rpc",
    version=VERSION,
    description=DESCRIPTION,
    long_description=LONG_DESCRIPTION,
    long_description_content_type="text/markdown",
    url="http://github.com/imjoy-team/imjoy-rpc",
    author="ImJoy Team",
    author_email="imjoy.team@gmail.com",
    license="MIT",
    packages=find_packages(),
    python_requires=">=3.6",
    include_package_data=True,
    install_requires=REQUIRES,
    extras_require={
        "full": [
            "aiortc;platform_system!='Emscripten'",
            "numpy",
            "zarr",
            "python-engineio>=4.1.0",
            "python-socketio[client]>=5.4.1",
        ],
        "socketio": [
            "python-socketio[client]>=5.4.1",
            "python-engineio>=4.1.0",
        ],
    },
    zip_safe=False,
)
