import sys
import os
import argparse
import logging
import aiohttp_cors
import socketio

from aiohttp import web, streamer

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("socketio-server")
logger.setLevel(logging.INFO)


def create_socketio_server(static_dir=None):
    """Create and return aiohttp webserver app."""
    sio = socketio.AsyncServer(cors_allowed_origins="*")
    app = web.Application()
    sio.attach(app)
    setup_router(app, static_dir)
    setup_socketio(sio)
    setup_cors(app)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


async def on_startup(app):
    """Run on server start."""
    logger.info("socketio-server started")


async def on_shutdown(app):
    """Run on server shut down."""
    logger.info("Shutting down the server")


def setup_cors(app):
    """Set up cors."""
    cors = aiohttp_cors.setup(
        app,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True, expose_headers="*", allow_headers="*"
            )
        },
    )


clients = {}


async def app_handler(request):
    return web.Response(text="clients: " + str(clients))


def setup_router(app, static_dir=None):
    if static_dir is not None:
        app.router.add_static("/", path=str(static_dir))
    app.router.add_get("/apps", app_handler)


def setup_socketio(sio):
    @sio.event
    async def list_plugins(sid, data):
        return list(plugins.values())

    @sio.event
    async def register_plugin(sid, config):
        plugins[config["id"]] = config
        plugin_channel = str(uuid.uuid4())
        config["plugin_channel"] = plugin_channel
        clients = {}
        config["clients"] = clients

        # broadcast to the plugin message to all the clients
        @sio.on(plugin_channel)
        async def on_plugin_message(sid, data):
            if data.get("peer_id"):
                for k in clients:
                    if data.get("peer_id") == clients[k]["channel"]:
                        await sio.emit(clients[k]["channel"], data)
            else:
                for k in clients:
                    await sio.emit(clients[k]["channel"], data)

        async def finalize():
            if config["id"] in plugins:
                for k in clients:
                    await sio.emit(clients[k]["channel"], {"type": "disconnect"})
                del plugins[config["id"]]

        finalizers.append([sid, finalize])
        return {"channel": plugin_channel}

    @sio.event
    async def connect_plugin(sid, data):
        pid = data.get("id")

        if pid in plugins:
            plugin_info = plugins[pid]
            client_info = {}
            logger.info(f"{sid} is connecting to plugin {pid}")

            # generate a channel and store it to plugin.clients
            client_channel = str(uuid.uuid4())
            plugin_info["clients"][client_channel] = client_info
            client_info["channel"] = client_channel

            # listen to the client channel and forward to the plugin
            @sio.on(client_channel)
            async def on_client_message(sid, data):
                await sio.emit(plugin_info["plugin_channel"], data)

            # notify the plugin about the new client
            await sio.emit(plugin_info["plugin_channel"] + "-new-client", client_info)

            async def finalize():
                del plugin_info["clients"][client_channel]

            finalizers.append([sid, finalize])

            return {"channel": client_channel}
        else:
            logger.error(f"Plugin not found {pid}, requested by client {sid}")
            return {"error": "Plugin not found: " + pid}

    @sio.event
    async def connect(sid, environ):
        print(sid, "connected")
        clients[sid] = {"sid": sid}

    @sio.event
    async def disconnect(sid):
        lst2finalize = [b for b in finalizers if b[0] == sid]
        for obj in lst2finalize:
            finalize_func = obj[1]
            try:
                logger.info("Removing " + obj[0])
                await finalize_func()
            finally:
                finalizers.remove(obj)


if __name__ == "__main__":
    app = create_socketio_server()
    web.run_app(app, port=9988)
