import argparse
import os
import re
import asyncio
import json
import yaml
from aiohttp import web
from socketioserver import create_socketio_server
from imjoy_rpc import default_config

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "input", type=str, default=None, help="path to a plugin file with plugin files"
    )
    parser.add_argument("--serve", action="store_true", help="start a socketio server")
    parser.add_argument(
        "--url", type=str, default=None, help="url to the socketio server"
    )
    parser.add_argument(
        "--port", type=str, default="9988", help="port for serving the socketio server"
    )
    args = parser.parse_args()

    if os.path.isfile(args.input):
        content = open(args.input).read()
        if args.input.endswith(".py"):
            filename = os.path.splitext(os.path.basename(args.input))
            exec(content)
        elif args.input.endswith(".imjoy.html"):
            # load config
            found = re.findall("<config (.*)>(.*)</config>", content, re.DOTALL)[0]
            if "json" in found[0]:
                plugin_config = json.loads(found[1])
            elif "yaml" in found[0]:
                plugin_config = yaml.safe_load(found[1])
            default_config.update(plugin_config)
            
            # load script
            found = re.findall("<script (.*)>(.*)</script>", content, re.DOTALL)[0]
            if "python" in found[0]:
                exec(content)
            else:
                raise Exception(
                    "Invalid script type ({}) in file {}".format(found[0], args.input)
                )
        else:
            raise Exception("Invalid script file type ({})".format(args.input))
    else:
        raise Exception("Invalid input plugin file path: {}".format(args.input))

    loop = asyncio.get_event_loop()
    if args.serve:
        if args.url and not args.url.endswith(args.port):
            print(
                "WARNING: the specified port ({}) does not match the one in the url ({})".format(
                    args.port.args.url
                )
            )
        app = create_socketio_server()
        web.run_app(app, port=args.port)
    else:
        loop.run_forever()
