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

parser = argparse.ArgumentParser()
parser.add_argument("--static-dir", type=str, default=None, help="connection token")

opt = parser.parse_args()


def create_app():
    """Create and return aiohttp webserver app."""
    sio = socketio.AsyncServer(cors_allowed_origins="*")
    app = web.Application()
    sio.attach(app)
    setup_router(app)
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


def setup_router(app):
    if opt.static_dir is not None:
        app.router.add_static("/", path=str(opt.static_dir))


def setup_socketio(sio):
    @sio.event
    def join_rpc_channel(sid, data):
        logger.info(f'{sid} joined the rpc channel: {data.get("channel")}')
        sio.enter_room(sid, data.get("channel"))

    @sio.event
    async def imjoy_rpc(sid, data):
        for room in sio.rooms(sid):
            logger.info("broadcase message to room %s: %s", room, data)
            await sio.emit("imjoy_rpc", data, room=room, skip_sid=sid)


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, port=9988)
