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
    async def join_rpc_channel(sid, data):
        channel = data.get("channel")
        logger.info(f"{sid} joined the rpc channel: {channel}")
        sio.enter_room(sid, channel)
        clients[sid]["rpc_channel"] = channel
        for room in sio.rooms(sid):
            logger.info("broadcase join_rpc_channel to %s", room)
            await sio.emit("join_rpc_channel", {"sid": sid}, room=room, skip_sid=sid)

    @sio.event
    async def connect(sid, environ):
        print(sid, "connected")
        clients[sid] = {"sid": sid}

    @sio.event
    async def disconnect(sid):
        print(sid, "disconnected")
        del clients[sid]

    @sio.event
    async def imjoy_rpc(sid, data):
        for room in sio.rooms(sid):
            logger.info("broadcase message to room %s: %s", room, data)
            await sio.emit("imjoy_rpc", data, room=room, skip_sid=sid)


if __name__ == "__main__":
    app = create_socketio_server()
    web.run_app(app, port=9988)
