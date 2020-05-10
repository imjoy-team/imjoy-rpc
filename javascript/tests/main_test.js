import { expect } from "chai";
import { RPC } from "../src/rpc.js";
import { connectRPC } from "../src/pluginCore";

describe("test", async () => {
  it("pass test", done => {
    const coreConnection = {
      disconnect: function() {},
      send: function(data, transferables) {
        // connect to the plugin
        pluginConnection.receiveMsg(data);
      },
      onMessage: function(h) {
        coreConnection._messageHandler = h;
      },
      _messageHandler: function() {},
      onDisconnect: function() {},
      receiveMsg: function(m) {
        switch (m && m.type) {
          case "config":
            console.log(m.config);
            break;
          case "initialized":
            this._init(m.config);
            break;
          case "executeSuccess":
            this._executeSCb();
            break;
          case "executeFailure":
            this._executeFCb(m.error);
            break;
          default:
            this._messageHandler(m);
        }
      },
      onInit(h) {
        this._init = h;
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
      disconnect: function() {},
      send: function(data, transferables) {
        // connect to the core
        coreConnection.receiveMsg(data);
      },
      onMessage: function(h) {
        pluginConnection._messageHandler = h;
      },
      _messageHandler: function() {},
      onDisconnect: function() {},
      receiveMsg: function(m) {
        switch (m && m.type) {
          case "getConfig":
            pluginConnection.send({
              type: "config",
              config: config
            });
            break;
          case "execute":
            if (config.allow_execution) {
              execute(m.code);
            } else {
              console.warn(
                "execute script is not allowed (allow_execution=false)"
              );
            }
            break;
          default:
            pluginConnection._messageHandler(m);
        }
      }
    };

    coreConnection.onInit(pluginConfig => {
      console.log("plugin initialized:", pluginConfig);
      const core = new RPC(coreConnection);
      core.onDisconnect(details => {
        console.log("status: plugin is disconnected", details);
      });

      core.onRemoteReady(() => {
        console.log("status: plugin is ready");
      });

      core.onRemoteBusy(() => {
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
        core.onRemoteUpdate(async () => {
          const api = core.getRemote();
          console.log("plugin api", api);
          await api.imshow("this is an image.");
          done();
        });
        core.requestRemote();
      });
    });

    const plugin = connectRPC(pluginConnection, config);
    plugin.setInterface({
      imshow: img => {
        console.log("show image:", img);
      }
    });
    pluginConnection.send({
      type: "initialized",
      config: config
    });
    expect(true).to.be.true;
  });
});
