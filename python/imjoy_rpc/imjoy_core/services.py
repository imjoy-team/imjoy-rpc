import logging
import sys

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("imjoy-core")
logger.setLevel(logging.INFO)


class Services:
    def __init__(self, imjoy_api=None):
        self._services = []
        self.imjoy_api = imjoy_api

    def register_service(self, plugin, service):
        self._services.append(service)

    def get_plugin(self, plugin, config):
        pass

    def generate_presigned_token(self, plugin):
        pass

    def get_service(self, plugin, name):
        return list(filter(lambda x: x.get("name") == name, self._services))[0]

    def log(self, plugin, msg):
        logger.info(f"{plugin.name}: {msg}")

    def error(self, plugin, msg):
        logger.error(f"{plugin.name}: {msg}")

    def alert(self, plugin, msg):
        print(msg)

    def confirm(self, plugin, msg):
        print(msg)
        return True

    def prompt(self, plugin, *arg):
        print(*arg)
        return None

    def get_interface(self):
        return dict(
            log=self.log,
            error=self.error,
            alert=self.alert,
            confirm=self.confirm,
            prompt=self.prompt,
            registerService=self.register_service,
            getService=self.get_service,
            utils=dict(),
        )
