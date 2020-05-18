![License](https://img.shields.io/github/license/imjoy-team/imjoy-rpc.svg)
![Build ImJoy RPC](https://github.com/imjoy-team/imjoy-rpc/workflows/Build%20ImJoy%20RPC/badge.svg)
![PyPI](https://img.shields.io/pypi/v/imjoy-rpc.svg?style=popout)

# ImJoy RPC

Symmetrical Transparent Remote Procedure Calls

The core library that powers [ImJoy](https://imjoy.io).


# Install Jupyter notebook extension


```bash
git clone https://github.com/imjoy-team/imjoy-rpc.git

cd imjoy-rpc

# install the extension
jupyter nbextension install nbextension/imjoy-rpc.js

# for development, add --symlink
# jupyter nbextension install nbextension/imjoy-rpc.js --symlink

# enable the extension
jupyter nbextension enable imjoy-rpc

# you can also disabled it if you don't need it anymore
# jupyter nbextension disable imjoy-rpc
```
