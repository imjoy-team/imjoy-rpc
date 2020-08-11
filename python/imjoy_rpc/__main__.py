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
        "--plugin-dir", type=str, default=None, help="path to a plugin file"
    )
    parser.add_argument("--serve", type=str, default=None, help="start a socketio server from specified port")
    parser.add_argument(
        "--plugin-server", type=str, default=None, help="url to the socketio server"
    )
    args = parser.parse_args()

    default_config.update(
        {
            "name": "ImJoy Plugin",
            "plugin_server": args.plugin_server or "http://127.0.0.1:{}".format(args.serve),
        }
    )

    if os.path.isfile(args.plugin_dir):
        content = open(args.plugin_dir).read()
        if args.plugin_dir.endswith(".py"):
            filename, _ = os.path.splitext(os.path.basename(args.plugin_dir))
            default_config["name"] = filename
            exec(content)
        elif args.plugin_dir.endswith(".imjoy.html"):
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
                    "Invalid script type ({}) in file {}".format(found[0], args.plugin_dir)
                )
        else:
            raise Exception("Invalid script file type ({})".format(args.plugin_dir))
    else:
        raise Exception("Invalid input plugin file path: {}".format(args.plugin_dir))

    loop = asyncio.get_event_loop()
    if args.serve:
        if args.plugin_server and not args.plugin_server.endswith(args.serve):
            print(
                "WARNING: the specified port ({}) does not match the one in the url ({})".format(
                    args.serve, args.plugin_server
                )
            )
        app = create_socketio_server()
        web.run_app(app, port=args.serve)
    else:
        loop.run_forever()
