import logging
import sys
import asyncio
import uuid
from functools import partial
from imjoy_rpc.utils import dotdict, ContextLocal
from imjoy_rpc.rpc import RPC

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("dynamic-plugin")
logger.setLevel(logging.INFO)


class DynamicPlugin:
    def __init__(self, config, interface, connection):
        self.loop = asyncio.get_event_loop()
        self.config = dotdict(config)
        self.id = self.config.id or str(uuid.uuid4())
        self.name = self.config.name
        self.initializing = False
        self._disconnected = True
        self._log_history = []
        self.connection = connection
        self.authorizer = None

        self._bind_interface(interface)
        self.initializeIfNeeded(self.connection, self.config)

        def initialized(data):
            if "error" in data:
                self.error(data["error"])
                logger.error("Plugin failed to initialize", data["error"])
                raise Exception(data["error"])

            asyncio.ensure_future(self._setup_rpc(connection, data["config"]))

        self.connection.on("initialized", initialized)
        self.connection.connect()

    def _bind_interface(self, interface):
        self._initial_interface = dotdict(_rintf=True)
        for k in interface:
            if callable(interface[k]):
                self._initial_interface[k] = partial(interface[k], self)
            elif isinstance(interface[k], dict):
                utils = dotdict()
                for u in interface[k]:
                    if callable(utils[u]):
                        utils[u] = partial(interface[k][u], self)
                interface[k] = utils
            else:
                self._initial_interface[k] = interface[k]

    async def _setup_rpc(self, connection, pluginConfig):
        self.initializing = True
        logger.info(f'setting up imjoy-rpc for {pluginConfig["name"]}')
        _rpc_context = ContextLocal()
        _rpc_context.api = self._initial_interface
        _rpc_context.default_config = {}
        self._rpc = RPC(connection, _rpc_context)
        self._register_rpc_events()
        self._rpc.set_interface(self._initial_interface)
        await self._send_interface()
        self._allow_execution = pluginConfig.get("allow_execution")
        if self._allow_execution:
            await self._execute_plugin()

        self.config.passive = self.config.passive or pluginConfig.get("passive")
        if self.config.passive:

            def func(*args):
                pass

            self.api = dotdict(
                passive=True, _rintf=True, setup=func, on=func, off=func, emit=func
            )
        else:
            self.api = await self._request_remote()

        self.api["config"] = dotdict(
            id=self.id,
            name=self.config.name,
            workspace=self.config.workspace,
            type=self.config.type,
            namespace=self.config.namespace,
            tag=self.config.tag,
        )

        self._disconnected = False
        self.initializing = False
        logger.info(
            f"Plugin registered successfully (name={self.config.name}, description={self.config.description}, api={list(self.api.keys())})"
        )
        if self.api.setup:
            asyncio.ensure_future(self.api.setup())

    def error(self, *args):
        self._log_history.append({"type": "error", "value": args})
        logger.error(f"Error in Plugin {self.id}: ${args}")

    def log(self, *args):
        if isinstance(args[0], dict):
            self._log_history.append(args[0])
            logger.info(f"Plugin ${self.id}:{args[0]}")
        else:
            msg = " ".join(map(str, args))
            self._log_history.push({"type": "info", "value": msg})
            logger.info(f"Plugin ${self.id}: ${msg}")

    def _set_disconnected(self):
        self._disconnected = True
        self.running = False
        self.initializing = False
        self.terminating = False

    def _register_rpc_events(self):
        def disconnected(details):
            if details:
                if "error" in details:
                    self.error(details["message"])
                if "info" in details:
                    self.log(details.info)
            self._set_disconnected()

        self._rpc.on("disconnected", disconnected)

        def remote_idle():
            self.running = False

        self._rpc.on("remoteIdle", remote_idle)

        def remote_busy():
            self.running = True

        self._rpc.on("remoteBusy", remote_busy)

    async def _execute_plugin(self):
        raise NotImplementedError

    def _send_interface(self):
        fut = self.loop.create_future()

        def interfaceSetAsRemote(result):
            fut.set_result(result)

        self._rpc.once("interfaceSetAsRemote", interfaceSetAsRemote)
        self._rpc.send_interface()
        return fut

    def _request_remote(self):
        fut = self.loop.create_future()

        def remoteReady(result):
            fut.set_result(self._rpc.get_remote())

        self._rpc.once("remoteReady", remoteReady)
        self._rpc.request_remote()
        return fut

    def initializeIfNeeded(self, connection, default_config):
        def imjoyRPCReady(data):
            config = data["config"] or {}
            forwarding_functions = ["close", "on", "off", "emit"]
            type = config.get("type") or default_config.get("type")
            if type in ["rpc-window", "window"]:
                forwarding_functions = forwarding_functions + [
                    "resize",
                    "show",
                    "hide",
                    "refresh",
                ]

            credential = None
            if config.get("credential_required"):
                if isinstance(config.credential_fields, list):
                    raise Exception(
                        "Please specify the `config.credential_fields` as an array of object."
                    )

                if default_config["credential_handler"]:
                    credential = default_config["credential_handler"](
                        config["credential_fields"]
                    )

                else:
                    credential = {}
                    # for k in config['credential_fields']:
                    #     credential[k.id] = prompt(k.label, k.value)

            connection.emit(
                {
                    "type": "initialize",
                    "config": {
                        "name": default_config.get("name"),
                        "type": default_config.get("type"),
                        "allow_execution": True,
                        "enable_service_worker": True,
                        "forwarding_functions": forwarding_functions,
                        "expose_api_globally": True,
                        "credential": credential,
                    },
                    "peer_id": data["peer_id"],
                }
            )

        connection.once("imjoyRPCReady", imjoyRPCReady)
