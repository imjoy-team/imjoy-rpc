import logging
import sys
import asyncio
import time
from imjoy_rpc.utils import MessageEmitter, dotdict

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("core-connection")
logger.setLevel(logging.WARNING)

all_connections = {}


class BasicConnection(MessageEmitter):
    def __init__(self, send):
        super().__init__(logger)
        self.pluginConfig = dotdict()
        self._send = send
        self._access_token = None
        self._refresh_token = None
        self.peer_id = None
        self.on("initialized", self._initialized)

    def _initialized(self, data):
        self.pluginConfig = data["config"]
        # peer_id can only be set for once
        self.peer_id = data["peer_id"]
        self._plugin_origin = data.get("origin", "*")
        all_connections[self.peer_id] = self
        if self._plugin_origin != "*":
            logger.info(
                f"connection to the imjoy-rpc peer ${self.peer_id} is limited to origin {self._plugin_origin}."
            )

        if not self.peer_id:
            raise Exception("Please provide a peer_id for the connection.")

        if self.pluginConfig.get("auth"):
            if self._plugin_origin == "*":
                logger.error(
                    "Refuse to transmit the token without an explicit origin, there is a security risk that you may leak the credential to website from other origin. Please specify the `origin` explicitly."
                )
                self._access_token = None
                self._refresh_token = None

            if self.pluginConfig["auth"]["type"] != "jwt":
                logger.error(
                    "Unsupported authentication type: " + self.pluginConfig.auth.type
                )
            else:
                self._expires_in = self.pluginConfig["auth"]["expires_in"]
                self._access_token = self.pluginConfig["auth"]["access_token"]
                self._refresh_token = self.pluginConfig["auth"]["refresh_token"]

    def handle_message(self, data):
        target_id = data.get("target_id")
        if target_id and self.peer_id and target_id != self.peer_id:
            conn = all_connections[target_id]
            if conn:
                conn._fire(data.type, data)
            else:
                logger.warn(
                    f"connection with target_id {target_id} not found, discarding data: {data}"
                )
        else:
            self._fire(data["type"], data)

    def connect(self):
        self._fire("connected")

    async def execute(self, code):
        fut = self.loop.create_future()

        def executed(result):
            if "error" in result:
                fut.set_exception(Exception(result["error"]))
            else:
                fut.set_result(None)

        self.once("executed", executed)

        if self.pluginConfig["allow_execution"]:
            self.emit({"type": "execute", "code": code})
        else:
            fut.set_exception(Exception("Connection does not allow execution"))

    def emit(self, data):
        """
        Sends a message to the plugin site
        """
        if self._access_token:
            if time.time() >= self._expires_in:
                # TODO: refresh access token
                raise Exception("Refresh token is not implemented.")

            data["access_token"] = self._access_token
        data["peer_id"] = self.peer_id
        asyncio.ensure_future(self._send(data))

    def disconnect(self, details):
        """
        Disconnects the plugin
        """
        if self.peer_id and self.peer_id in all_connections:
            del all_connections[self.peer_id]
