"""Set up the ImJoy-Engine imjoy package."""
import json
import os
import sys
from setuptools import setup, find_packages


DESCRIPTION = (
    "ImJoy Plugin Engine for running Python plugins locally "
    "or remotely from ImJoy.io"
)

ROOT_DIR = os.path.dirname(__file__)


def read(name):
    """Read file name contents and return it."""
    with open(os.path.join(ROOT_DIR, name)) as fil:
        return fil.read()


with open(os.path.join(ROOT_DIR, "imjoy_rpc", "VERSION"), "r") as f:
    VERSION = json.load(f)["version"]

if sys.version_info < (3, 5):
    raise Exception("Python < 3.5 is not supported.")

requirements = read("requirements.txt")
requirements += '\ncontextvars;python_version<"3.7"'
requirements += '\naiocontextvars;python_version<"3.7"'
requirements += "\n"

test_requirements = read("requirements_test.txt")

setup(
    name="imjoy-rpc",
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
    install_requires=requirements,
    tests_require=requirements + test_requirements,
    extras_require={"jupyter": "ipykernel", "socketio": "python-socketio[client]"},
    zip_safe=False,
)
