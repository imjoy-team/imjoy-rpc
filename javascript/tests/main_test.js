import { expect } from "chai";
import { RPC } from "../src/rpc.js";
import { connectRPC } from "../src/pluginCore";

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

function evalInScope(code, scope) {
  var keys = Object.keys(scope);
  var values = keys.map(function(key) {
    return scope[key];
  });
  var f = Function(keys.join(", "), code);
  // Note that at this point you could cache the function f.
  return f.apply(undefined, values);
}

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
function runPlugin(config, plugin_interface, code) {
  return new Promise((resolve, reject) => {
    const coreConnection = {
      connect() {},
      disconnect: function() {},
      emit: function(data) {
        data.peer_id = coreConnection.peer_id;
        // connect to the plugin
        setTimeout(() => {
          pluginConnection.receiveMsg(data);
        }, 30);
      },
      on: function(event, handler) {
        coreConnection._messageHandler[event] = handler;
      },
      once: function(event, handler) {
        coreConnection._messageHandler[event] = handler;
      },
      _messageHandler: {},
      async execute(code) {
        coreConnection.emit({ type: "execute", code: code });
      },
      receiveMsg: function(m) {
        if (coreConnection._messageHandler[m.type]) {
          coreConnection._messageHandler[m.type](m);
        }
      }
    };
    let plugin;
    let imjoy_api_in_plugin;
    const plugin_peer_id = "1234";
    const pluginConnection = {
      connect() {
        pluginConnection.emit({
          type: "initialized",
          config: config,
          peer_id: plugin_peer_id
        });
      },
      async execute(code) {
        if (config.allow_execution) {
          if (code.type == "script" && code.content) {
            evalInScope(code.content, { api: imjoy_api_in_plugin });
          } else {
            throw new Error("unsupported");
          }
        } else {
          throw new Error(
            "execute script is not allowed (allow_execution=false)"
          );
        }
      },
      disconnect: function() {},
      emit: function(data) {
        // connect to the core
        setTimeout(() => {
          coreConnection.receiveMsg(data);
        }, 30);
      },
      on: function(event, handler) {
        pluginConnection._messageHandler[event] = handler;
      },
      once: function(event, handler) {
        pluginConnection._messageHandler[event] = handler;
      },
      _messageHandler: {},
      receiveMsg: function(m) {
        if (m.peer_id !== plugin_peer_id) {
          throw new Error(
            "peer_id mismatch: " + m.peer_id + "!=" + plugin_peer_id
          );
        }
        if (pluginConnection._messageHandler[m.type]) {
          pluginConnection._messageHandler[m.type](m);
        }
      }
    };

    coreConnection.on("initialized", data => {
      const pluginConfig = data.config;

      if (data.error) {
        console.error("Failed to initialize the plugin", data.error);
        return;
      }
      if (!data.peer_id) {
        throw "Please provide a peer_id for the connection.";
      }
      coreConnection.peer_id = data.peer_id;
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
            if (data.error) {
              reject(new Error(data.error));
            }
          });
          coreConnection.execute({
            type: "script",
            content: code
          });
        }

        core.on("remoteReady", async () => {
          const api = core.getRemote();
          api.disposeObject = async function(obj) {
            await core.disposeObject(obj);
          };
          resolve({ api, plugin, core });
        });
        core.requestRemote();
      });
      core.sendInterface();
    });

    pluginConnection.connect();
    plugin = connectRPC(pluginConnection, config);
    if (plugin_interface) plugin.setInterface(plugin_interface);

    window.addEventListener("imjoy_remote_api_ready", e => {
      // imjoy plugin api
      imjoy_api_in_plugin = e.detail;
    });
  });
}

describe("RPC", async () => {
  it("should connect", async () => {
    const config = {
      name: "test plugin",
      allow_execution: false
    };
    const { api } = await runPlugin(config, {});
    console.log("plugin api", api);
  });

  it("should support plugin class", async () => {
    class Plugin {
      _invisible_method() {}
      echo(msg) {
        return msg;
      }
    }
    const { api } = await runPlugin(
      {
        name: "test plugin",
        allow_execution: false
      },
      new Plugin()
    );
    expect(await api.echo(32)).to.equal(32);
    expect(api._invisible_method).to.be.undefined;
  });

  const testGetPluginCode = `
    class Plugin {
      async testGetPlugin(a, b){
        
        this.plugin22 = await api.getPlugin('plugin22')
        return this.plugin22.multiply(a, b)
      }
      async closePlugin22(){
        this.plugin22.close()
      }
    };
    api.export(new Plugin())
    `;

  it("should execute code and get plugin", async () => {
    const { api, core } = await runPlugin(
      {
        name: "test plugin",
        allow_execution: true
      },
      null,
      testGetPluginCode
    );
    expect(await api.testGetPlugin(9, 8)).to.equal(72);
    expect(await api.testGetPlugin(3, 6)).to.equal(18);
    const count = Object.keys(core._object_store).length;
    await api.closePlugin22();
    setTimeout(() => {
      expect(Object.keys(core._object_store).length).to.equal(count - 1);
    }, 0);
  });

  it("should dispose object", async () => {
    const plugin_interface = {
      echo: obj => {
        return obj;
      }
    };
    const { api, plugin, core } = await runPlugin(
      {
        name: "test plugin",
        allow_execution: false
      },
      plugin_interface
    );
    const count = Object.keys(core._object_store).length;
    const pcount = Object.keys(plugin._object_store).length;
    const obj = await api.echo({ _rintf: true, foo: "bar" });
    expect(Object.keys(core._object_store).length).to.equal(count + 1);
    expect(Object.keys(plugin._object_store).length).to.equal(pcount + 1);
    await api.disposeObject(obj);
    setTimeout(() => {
      expect(Object.keys(plugin._object_store).length).to.equal(pcount);
    }, 200);
  });

  it("should encode and decode", async () => {
    const testEncodDecodePlugin = `
    class Cat{
      constructor(name, color, age){
        this.name = name
        this.color = color
        this.age = age
      }
    }
    
    api.registerCodec({'name': 'cat', 'type': Cat, 'encoder': (obj)=>{
      return {_rtype: 'cat', name: obj.name, color: obj.color, age: obj.age}
    }, 'decoder': (encoded_obj)=>{
      return new Cat(encoded_obj.name, encoded_obj.color, encoded_obj.age)
    }})
  
    class Plugin {
      async run(){
        const bobo = new Cat('boboshu', 'mixed', 0.67)
        const cat = await api.echo(bobo)
        if(cat instanceof Cat && bobo.name === cat.name && bobo.color === cat.color && bobo.age === cat.age)
          return true
        else
          return false
      }
    };
    api.export(new Plugin())
    `;
    const { api, core } = await runPlugin(
      {
        name: "test plugin",
        allow_execution: true
      },
      null,
      testEncodDecodePlugin
    );
    expect(await api.run()).to.equal(true);
  });

  it("should block execution if allow_execution=false", async () => {
    try {
      await runPlugin(
        { name: "test2", allow_execution: false },
        null,
        testGetPluginCode
      );
      expect("this line will not be reached").to.equal(true);
    } catch (error) {
      expect(error).to.be.an("error");
    }
  });

  it("should encode/decode data", async () => {
    const plugin_interface = {
      embed: {
        embed: {
          value: 8873,
          sayHello: () => {
            console.log("hello");
            return true;
          }
        }
      },
      echo: msg => {
        return msg;
      }
    };
    const { api } = await runPlugin(
      {
        name: "test plugin",
        allow_execution: false
      },
      plugin_interface
    );

    const msg = "this is an messge.";
    expect(api.embed.embed).to.include.all.keys("value", "sayHello");
    expect(api.embed.embed.value).to.equal(8873);
    expect(await api.embed.embed.sayHello()).to.equal(true);
    expect(await api.echo(msg)).to.equal(msg);
    expect(await api.echo(99)).to.equal(99);
    expect(
      (await api.echo(new DataView(new ArrayBuffer(101)))).buffer.byteLength
    ).to.equal(101);

    const ret = await api.echo(new Uint16Array(new ArrayBuffer(4)));
    expect(ret.length).to.equal(2);
    expect(
      (await api.echo(new Blob(["133"], { type: "text33" }))).type
    ).to.equal("text33");
    expect((await api.echo(new Map([["1", 99]]))).get("1")).to.equal(99);
    expect((await api.echo(new Set([38, "88", 38]))).size).to.equal(2);
    expect((await api.echo(new ArrayBuffer(101))).byteLength).to.equal(101);
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
      expect("this line will not be reached").to.equal(true);
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
  }).timeout(20000);
});
