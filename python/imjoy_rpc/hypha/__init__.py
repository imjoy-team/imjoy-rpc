"""Provide hypha-rpc to connecting to Hypha server."""

from .rpc import RPC

from .webrtc_client import get_rtc_service, register_rtc_service
from .websocket_client import login, connect_to_server
from .sync import (
    login as login_sync,
    connect_to_server as connect_to_server_sync,
    register_rtc_service as register_rtc_service_sync,
    get_rtc_service as get_rtc_service_sync,
)

__all__ = [
    "RPC",
    "login",
    "connect_to_server",
    "login_sync",
    "connect_to_server_sync",
    "get_rtc_service",
    "register_rtc_service",
    "register_rtc_service_sync",
    "get_rtc_service_sync",
]
