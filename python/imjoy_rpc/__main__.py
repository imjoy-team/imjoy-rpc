import asyncio
from imjoy_rpc import api


class ImJoyPlugin:
    async def setup(self):
        await api.log("plugin initialized")

    async def run(self, ctx):
        await api.alert("hello")
        await api.showDialog(type="external", src="https://imjoy.io")


if __name__ == "__main__":
    api.export(ImJoyPlugin(), {"debug": True, "url": "http://localhost:9988"})
