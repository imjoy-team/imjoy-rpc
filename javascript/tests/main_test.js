import { expect } from "chai";
import { RPC } from "../src/rpc.js";
import { connectRPC } from "../src/pluginCore";

const core_interface = {
  alert: msg => {
    console.log("alert:", msg);
  },
  log: msg => {
    console.log("log:", msg);
  }
};
function runPlugin(config, plugin_interface) {
  return new Promise((resolve, reject) => {
    const coreConnection = {
      connect() {
        coreConnection.on("executed", () => {});
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
        pluginConnection.emit({
          type: "initialized",
          success: true,
          config: config
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

      core.sendInterface().then(() => {
        if (pluginConfig.allow_execution) {
          console.log("execute code");
        }
        core.on("remoteReady", async () => {
          const api = core.getRemote();
          resolve(api);
        });
        core.requestRemote();
      });
    });

    const plugin = connectRPC(pluginConnection, config);
    plugin.setInterface(plugin_interface);
    pluginConnection.connect();
  });
}

describe("RPC", async () => {
  it("should connect", async () => {
    const config = {
      name: "test plugin",
      allow_execution: false
    };
    const api = await runPlugin(config, {});
    console.log("plugin api", api);
  });

  it("should encode/decode data", async () => {
    const plugin_interface = {
      echo: msg => {
        return msg;
      }
    };
    const config = {
      name: "test plugin",
      allow_execution: false
    };
    const api = await runPlugin(config, plugin_interface);

    const msg = "this is an messge.";
    expect(await api.echo(msg)).to.equal(msg);
    expect(await api.echo(99)).to.equal(99);
    expect(await api.echo(true)).to.equal(true);
    const date = new Date(2018, 11, 24, 10, 33, 30, 0);
    expect((await api.echo(date)).getTime()).to.equal(date.getTime());
    const imageData = new ImageData(200, 100);
    expect((await api.echo(imageData)).width).to.equal(200);
    expect(await api.echo({ a: 1, b: 93 })).to.include.all.keys("a", "b");
    expect(await api.echo(["12", 33, { foo: "bar" }])).to.include(33);
    expect(await api.echo(["12", 33, { foo: "bar" }])).to.include("12");
    expect(await api.echo(["12", 33, { foo: "bar" }])).to.deep.include({
      foo: "bar"
    });
    const blob = new Blob(["hello"], { type: "text/plain" });
    expect(await api.echo(blob)).to.be.an.instanceof(Blob);
    const file = new File(["foo"], "foo.txt", {
      type: "text/plain"
    });
    expect(await api.echo(file)).to.be.an.instanceof(File);

    // send a callback function
    const callback = () => {
      return 123;
    };
    const received_callback = await api.echo(callback);

    expect(await received_callback()).to.equal(123);
    try {
      await received_callback();
    } catch (error) {
      expect(error).to.be.an("error");
    }
    // send an interface
    const itf = {
      _rintf: true,
      add(a, b) {
        return a + b;
      }
    };
    const received_itf = await api.echo(itf);
    expect(await received_itf.add(1, 3)).to.equal(4);
    expect(await received_itf.add(9, 3)).to.equal(12);
    expect(await received_itf.add("12", 2)).to.equal("122");
  });
});
