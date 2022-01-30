"""Provide hypha-rpc to connecting to Hypha server."""

from .rpc import RPC

from .websocket_client import connect_to_server

__all__ = ["RPC", "connect_to_server"]
