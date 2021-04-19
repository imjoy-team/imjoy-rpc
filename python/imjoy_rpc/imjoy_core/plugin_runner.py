"""Provide main entrypoint."""
import json
import os
import re
import sys
import logging
import urllib.request
from imjoy_rpc import default_config

logging.basicConfig(stream=sys.stdout)
logger = logging.getLogger("plugin-runner")
logger.setLevel(logging.INFO)


def run_plugin(plugin_file):
    """load plugin file"""
    try:
        import yaml
    except:
        logger.warning("yaml not found, please install it with `pip install PyYAML`")

    if os.path.isfile(plugin_file):
        content = open(plugin_file).read()
    elif plugin_file.startswith("http"):
        with urllib.request.urlopen(plugin_file) as response:
            content = response.read().decode("utf-8")
        # remove query string
        plugin_file = plugin_file.split("?")[0]
    else:
        raise Exception("Invalid input plugin file path: {}".format(plugin_file))

    if plugin_file.endswith(".py"):
        filename, _ = os.path.splitext(os.path.basename(plugin_file))
        default_config["name"] = filename[:32]
        try:
            exec(content, globals())
            logger.info("Plugin executed")
        except Exception as e:
            logger.error("Failed to execute plugin %s", e)

    elif plugin_file.endswith(".imjoy.html"):
        # load config
        found = re.findall("<config (.*)>\n(.*)</config>", content, re.DOTALL)[0]
        if "json" in found[0]:
            plugin_config = json.loads(found[1])
        elif "yaml" in found[0]:
            plugin_config = yaml.safe_load(found[1])
        default_config.update(plugin_config)

        # load script
        found = re.findall("<script (.*)>\n(.*)</script>", content, re.DOTALL)[0]
        if "python" in found[0]:
            try:
                exec(found[1], globals())
                logger.info("Plugin executed")
            except Exception as e:
                logger.error("Failed to execute plugin %s", e)
        else:
            raise Exception(
                "Invalid script type ({}) in file {}".format(found[0], plugin_file)
            )
    else:
        raise Exception("Invalid script file type ({})".format(plugin_file))


if __name__ == "__main__":
    import argparse
    import asyncio
    loop = asyncio.get_event_loop()

    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=str, help="path to a plugin file")
    parser.add_argument(
        "--server",
        type=str,
        default=None,
        help="url to the plugin socketio server",
    )

    parser.add_argument(
        "--token",
        type=str,
        default=None,
        help="token for the plugin socketio server",
    )

    parser.add_argument(
        "--quit-when-ready",
        action='store_true',
        help="token for the plugin socketio server",
    )

    opt = parser.parse_args()

    def on_ready_callback(_):
        logger.info("Plugin is now ready")
        if opt.quit_when_ready:
            loop.stop()

    def start_plugin():
        default_config.update(
            {"name": "ImJoy Plugin", "server": opt.server, "token": opt.token, "on_ready_callback": on_ready_callback}
        )
        run_plugin(opt.file)

    start_plugin()
    
    loop.run_forever()
