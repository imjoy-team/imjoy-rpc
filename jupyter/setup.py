"""Set up the ImJoy-Engine imjoy package."""
import json
import os
import sys
from setuptools import setup, find_packages


DESCRIPTION = "Running ImJoy in Jupyter notebooks."

ROOT_DIR = os.path.dirname(__file__)


def read(name):
    """Read file name contents and return it."""
    with open(os.path.join(ROOT_DIR, name)) as fil:
        return fil.read()


with open(os.path.join(ROOT_DIR, "imjoy_jupyter_extension", "VERSION"), "r") as f:
    VERSION = json.load(f)["version"]

if sys.version_info < (3, 5):
    raise Exception("Python < 3.5 is not supported.")

setup(
    name="imjoy-jupyter-extension",
    version=VERSION,
    description=DESCRIPTION,
    long_description=read("README.md"),
    long_description_content_type="text/markdown",
    url="http://github.com/imjoy-team/imjoy-rpc",
    author="ImJoy Team",
    author_email="imjoy.team@gmail.com",
    license="MIT",
    packages=find_packages(),
    include_package_data=True,
    data_files=[
        (
            "share/jupyter/nbextensions/imjoy_jupyter_extension",
            [
                "imjoy_jupyter_extension/static/index.js",
                "imjoy_jupyter_extension/static/imjoy-icon.png",
                "imjoy_jupyter_extension/static/imjoy_jupyter_extension.yaml",
            ],
        ),
        ("etc/jupyter/nbconfig/notebook.d", ["imjoy_jupyter_extension.json"]),
    ],
    install_requires=["imjoy-rpc", "notebook>=5.3"],
    extras_require={},
    zip_safe=False,
)
