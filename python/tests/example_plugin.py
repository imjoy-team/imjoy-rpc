from imjoy_rpc import api
import asyncio

class ImJoyPlugin():
    async def setup(self):
        await api.registerService({"name": "echo service", "echo": lambda x: print('echo: '+str(x))})
        s = await api.getService("echo service")
        await s.echo('a message')
        await api.log('initialized')

    async def run(self, ctx):
        await api.log('hello world.')

api.export(ImJoyPlugin(), config={"name":"test-plugin"})