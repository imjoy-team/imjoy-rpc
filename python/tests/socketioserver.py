import sys
import os
import argparse
import logging
import aiohttp_cors
import socketio

from aiohttp import web, streamer

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("socketio-server")

parser = argparse.ArgumentParser()
parser.add_argument("--web_app_dir", type=str, default="./", help="connection token")

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
    async def index(request):
        """Serve the client-side application."""
        with open(
            os.path.join(opt.web_app_dir, "index.html"), "r", encoding="utf-8",
        ) as fil:
            return web.Response(text=fil.read(), content_type="text/html")

    app.router.add_static("/static", path=str(os.path.join(opt.web_app_dir, "static")))


def setup_socketio(sio):
    @sio.event
    def join_room(sid):
        print("===join_room====>", sid)
        sio.enter_room(sid, "imjoy")

    @sio.event
    async def imjoy_rpc(sid, data):
        print("broadcase message: ", data)
        await sio.emit("imjoy_rpc", data, room="imjoy", skip_sid=sid)


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, port=9988)
