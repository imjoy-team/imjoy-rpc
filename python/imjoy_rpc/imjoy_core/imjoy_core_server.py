import secrets
import time
import traceback
import uuid
from enum import Enum
from os import environ as env
from typing import Any, Dict, List, Optional, Type, Union
from imjoy_rpc.imjoy_core.services import Services

import socketio
from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.logger import logger
from jose import jwt
from pydantic import BaseModel, EmailStr, PrivateAttr
from imjoy_rpc.imjoy_core.auth import JWT_SECRET, get_user_info, valid_token
from imjoy_rpc.imjoy_core.connection import BasicConnection
from imjoy_rpc.imjoy_core.dynamic_plugin import DynamicPlugin

ENV_FILE = find_dotenv()
if ENV_FILE:
    load_dotenv(ENV_FILE)


class VisibilityEnum(str, Enum):
    public = "public"
    protected = "protected"


class UserInfo(BaseModel):
    sessions: List[str]
    id: str
    roles: List[str]
    email: Optional[EmailStr]
    parent: Optional[str]
    scopes: Optional[List[str]]  # a list of namespace
    expires_at: Optional[int]
    plugin: Any  # TODO: fix type


sessions: Dict[str, UserInfo] = {}  # sid:user_info
users: Dict[str, UserInfo] = {}  # uid:user_info


def parse_token(authorization):
    if authorization.startswith("#RTC:"):
        parts = authorization.split()
        if parts[0].lower() != "bearer":
            raise Exception("Authorization header must start with" " Bearer")
        elif len(parts) == 1:
            raise Exception("Token not found")
        elif len(parts) > 2:
            raise Exception("Authorization header must be 'Bearer' token")

        token = parts[1]
        # generated token
        token = token.lstrip("#RTC:")
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    else:
        # auth0 token
        return get_user_info(valid_token(authorization))


def initialize_socketio(sio, services):
    @sio.event
    async def connect(sid, environ):
        """Event handler called when a socketio client is connected to the server."""
        if "HTTP_AUTHORIZATION" in environ:
            try:
                authorization = environ["HTTP_AUTHORIZATION"]  # JWT token
                user_info = parse_token(authorization)
                uid = user_info["user_id"]
                email = user_info["email"]
                roles = user_info["roles"]
                parent = user_info.get("parent")
                scopes = user_info.get("scopes")
                expires_at = user_info.get("expires_at")
            except Exception as e:
                logger.error("Authentication failed: %s", traceback.format_exc())
                # The connect event handler can return False to reject the connection with the client.
                return False
            logger.info("User connected: %s", uid)
        else:
            uid = str(uuid.uuid4())
            email = None
            roles = []
            parent = None
            scopes = []
            expires_at = None
            logger.info("Anonymized User connected: %s", uid)

        if uid not in users:
            users[uid] = UserInfo(
                sessions=[sid],
                id=uid,
                email=email,
                parent=parent,
                roles=roles,
                scopes=scopes,
                expires_at=expires_at,
            )
        else:
            users[uid].sessions.append(sid)
        sessions[sid] = users[uid]

    @sio.event
    async def register_plugin(sid, config):
        user_info = sessions[sid]
        plugin_id = str(uuid.uuid4())
        config["id"] = plugin_id
        sio.enter_room(sid, plugin_id)

        async def send(data):
            await sio.emit(
                "plugin_message",
                data,
                room=plugin_id,
            )

        connection = BasicConnection(send)
        user_info.plugin = DynamicPlugin(config, services.get_interface(), connection)
        return {"success": True, "id": plugin_id}

    @sio.event
    async def plugin_message(sid, data):
        user_info = sessions[sid]
        if user_info.plugin:
            user_info.plugin.connection.handle_message(data)

    @sio.event
    async def disconnect(sid):
        """Event handler called when the client is disconnected."""
        user_info = sessions[sid]
        users[user_info.id].sessions.remove(sid)
        if not users[user_info.id].sessions:
            del users[user_info.id]
        del sessions[sid]


def setup_socketio_server(
    app: FastAPI,
    mount_location: str = "/rtc",
    socketio_path: str = "socket.io",
    allow_origins: Union[str, list] = "",
) -> None:
    """Setup the socketio server."""
    sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=allow_origins)
    _app = socketio.ASGIApp(socketio_server=sio, socketio_path=socketio_path)

    app.mount(mount_location, _app)
    app.sio = sio
    services = Services()
    initialize_socketio(sio, services)
    return sio


__version__ = "0.1.0"

app = FastAPI(
    title="ImJoy Core Server",
    description="A server for managing imjoy plugin and enable remote procedure calls",
    version=__version__,
)

allow_origins = env.get("ALLOW_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Content-Type", "Authorization"],
)


setup_socketio_server(app, allow_origins=allow_origins)

if __name__ == "__main__":
    import uvicorn
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--port",
        type=int,
        default=3000,
        help="port for the socketio server",
    )

    opt = parser.parse_args()

    uvicorn.run(app, port=opt.port)
