import { expect } from "chai";
import { RPC } from "../src/rpc.js";
import { connectRPC } from "../src/pluginCore";

describe("test", async () => {
  it("pass test", done => {
    const coreConnection = {
      connect() {
        coreConnection.on("executeSuccess", () => {});
        coreConnection.on("executeFailure", () => {});
      },
      disconnect: function() {},
      emit: function(data) {
        // connect to the plugin
        pluginConnection.receiveMsg(data);
      },
      on: function(event, handler) {
        coreConnection._messageHandler[event] = handler;
      },
      _messageHandler: {},
      receiveMsg: function(m) {
        if (coreConnection._messageHandler[m.type]) {
          coreConnection._messageHandler[m.type](m);
        }
      }
    };

    const config = {
      name: "test plugin",
      allow_execution: false
    };
    const execute = code => {
      console.log("executing code", code);
    };
    const pluginConnection = {
      connect() {
        pluginConnection.on("execute", () => {
          if (config.allow_execution) {
            execute(m.code);
          } else {
            console.warn(
              "execute script is not allowed (allow_execution=false)"
            );
          }
        });
        pluginConnection.on("initialize", () => {
          pluginConnection.emit({
            type: "initialized",
            config: config
          });
        });
      },
      disconnect: function() {},
      emit: function(data) {
        // connect to the core
        coreConnection.receiveMsg(data);
      },
      on: function(event, handler) {
        pluginConnection._messageHandler[event] = handler;
      },
      _messageHandler: {},
      receiveMsg: function(m) {
        if (pluginConnection._messageHandler[m.type]) {
          pluginConnection._messageHandler[m.type](m);
        }
      }
    };

    coreConnection.on("initialized", pluginConfig => {
      console.log("plugin initialized:", pluginConfig);
      const core = new RPC(coreConnection);
      core.on("disconnected", details => {
        console.log("status: plugin is disconnected", details);
      });

      core.on("remoteReady", () => {
        console.log("status: plugin is ready");
      });

      core.on("remoteBusy", () => {
        console.log("status: plugin is busy");
      });

      core.setInterface({
        alert: msg => {
          console.log("alert:", msg);
        }
      });

      core.sendInterface().then(() => {
        if (pluginConfig.allow_execution) {
          console.log("execute code");
        }
        core.on("remoteUpdated", async () => {
          const api = core.getRemote();
          console.log("plugin api", api);
          await api.imshow("this is an image.");
          done();
        });
        core.requestRemote();
      });
    });
    coreConnection.emit({ type: "initialize" });
    const plugin = connectRPC(pluginConnection, config);
    plugin.setInterface({
      imshow: img => {
        console.log("show image:", img);
      }
    });
    pluginConnection.connect();
    expect(true).to.be.true;
  });
});
