import asyncio
from imjoy_rpc.rpc import RPC

class ImJoyPlugin():
    def __init__(self, api):
        self._api = api

    def setup(self):
        self._api.alert('hello')
        self._api.showDialog(type="external", src="https://imjoy.io")

if __name__ == '__main__':
    rpc = RPC(ImJoyPlugin)
    rpc.start()