import { expect } from "chai";
import { RPC } from "../src/rpc.js";
import io from "socket.io-client";

const plugins = {
  plugin22: {
    _rintf: true,
    multiply(a, b) {
      return a * b;
    },
    close() {
      plugins.plugin22.__close_callback();
    },
    on(event, callback) {
      if (event === "close") {
        plugins.plugin22.__close_callback = callback;
      }
    }
  }
};

const core_interface = {
  alert: msg => {
    console.log("alert:", msg);
  },
  log: msg => {
    console.log("log:", msg);
  },
  getPlugin: name => {
    return plugins[name];
  },
  echo: msg => {
    return msg;
  }
};

function setupCore(socket, code) {
  return new Promise((resolve, reject) => {
    const coreConnection = {
      connect() {
        socket.on("imjoy_rpc", m => {
          if (coreConnection._messageHandler[m.type]) {
            coreConnection._messageHandler[m.type](m);
          }
        });
      },
      disconnect: function() {},
      emit: msg => socket.emit("imjoy_rpc", msg),
      on: function(event, handler) {
        coreConnection._messageHandler[event] = handler;
      },
      _messageHandler: {},
      async execute(code) {
        coreConnection.emit({ type: "execute", code: code });
      }
    };

    coreConnection.on("initialized", data => {
      const pluginConfig = data.config;

      if (!data.success) {
        console.error("Failed to initialize the plugin", pluginConfig.error);
        return;
      }
      console.log("plugin initialized:", pluginConfig);
      const core = new RPC(coreConnection, { name: "core" });
      core.on("disconnected", details => {
        console.log("status: plugin is disconnected", details);
      });

      core.on("remoteReady", () => {
        console.log("status: plugin is ready");
      });

      core.on("remoteIdle", () => {
        console.log("status: plugin is now idle");
      });

      core.on("remoteBusy", () => {
        console.log("status: plugin is busy");
      });

      core.setInterface(core_interface);

      core.on("interfaceSetAsRemote", () => {
        if (code) {
          coreConnection.on("executed", data => {
            if (!data.success) {
              reject(data.error);
            }
          });
          coreConnection.execute({
            type: "script",
            content: code
          });
        }

        core.on("remoteReady", async () => {
          const api = core.getRemote();
          resolve({ api, core });
        });
        core.requestRemote();
      });
      core.sendInterface();
    });
  });
}

describe("RPC", async () => {
  it("should connect", async () => {
    const socket = io("http://localhost:9988");
    socket.on("connect", async () => {
      await socket.emit("join_rpc_channel", { channel: "test_plugin" });
      console.log("socketio connected");
      const { api, core } = await setupCore(
        socket,
        "imjoy_rpc",
        `
        print('hello')
        `
      );
      await api.run();
    });
  });
});
