import { expect } from "chai";
import { login, connectToServer } from "../src/hypha/websocket-client.js";

const WS_PORT = 9529;

class ImJoyPlugin {
  async setup() {}
  async add2(arg) {
    return arg + 2;
  }
}

describe("RPC", async () => {
  it("should connect to the server", async () => {
    const api = await connectToServer({
      server_url: `ws://127.0.0.1:${WS_PORT}/ws`,
      client_id: "test-plugin-1"
    });
    expect(typeof api.log).to.equal("function");
    await api.disconnect();
  }).timeout(20000);

  it("should login to the server", async () => {
    const TOKEN = "sf31df234";

    async function callback(context) {
      console.log(`By passing login: ${context["login_url"]}`);
      const response = await fetch(
        `${context["report_url"]}?key=${context["key"]}&token=${TOKEN}`
      );
      if (!response.ok) throw new Error("Network response was not ok");
    }

    // We use ai.imjoy.io to test the login for now
    const token = await login({
      server_url: "https://ai.imjoy.io",
      login_callback: callback,
      login_timeout: 3
    });
    expect(token).to.equal(TOKEN);
  }).timeout(20000);

  it("should connect to the server", async () => {
    const api = await connectToServer({
      server_url: `ws://127.0.0.1:${WS_PORT}/ws`,
      client_id: "test-plugin-1"
    });
    // await api.log("hello")
    const size = 100000;
    const data = await api.echo(new ArrayBuffer(size));
    expect(data.byteLength).to.equal(size);
    await api.register_service({
      name: "my service",
      id: "test-service",
      config: { visibility: "public" },
      square: function(a) {
        return a * a;
      }
    });
    const svc = await api.rpc.get_remote_service("test-service");
    expect(await svc.square(2)).to.equal(4);
    await api.export(new ImJoyPlugin());
    const dsvc = await api.rpc.get_remote_service("default");
    expect(await dsvc.add2(3)).to.equal(5);
    await api.disconnect();
  }).timeout(20000);

  it("should encode/decode data", async () => {
    const plugin_interface = {
      id: "default",
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
    const server = await connectToServer({
      server_url: `ws://127.0.0.1:${WS_PORT}/ws`,
      client_id: "test-plugin-1"
    });
    await server.register_service(plugin_interface);
    const api = await server.rpc.get_remote_service("default");

    const msg = "this is an messge.";
    expect(api.embed.embed).to.include.all.keys("value", "sayHello");
    expect(api.embed.embed.value).to.equal(8873);
    expect(await api.embed.embed.sayHello()).to.equal(true);
    expect(await api.echo(msg)).to.equal(msg);
    expect(await api.echo(99)).to.equal(99);
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
    // const imageData = new ImageData(200, 100);
    // expect((await api.echo(imageData)).width).to.equal(200);
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
    expect(await api.echo(file)).to.be.an.instanceof(Blob);

    // send an interface
    const itf = {
      id: "hello",
      add(a, b) {
        return a + b;
      }
    };
    await server.register_service(itf);
    const received_itf = await api.echo(itf);
    expect(await received_itf.add(1, 3)).to.equal(4);
    expect(await received_itf.add(9, 3)).to.equal(12);
    expect(await received_itf.add("12", 2)).to.equal("122");
    await server.disconnect();
  }).timeout(20000);

  it("should encode and decode custom object", async () => {
    const api = await connectToServer({
      server_url: `ws://127.0.0.1:${WS_PORT}/ws`,
      client_id: "test-plugin-1"
    });

    class Cat {
      constructor(name, color, age) {
        this.name = name;
        this.color = color;
        this.age = age;
      }
    }

    api.registerCodec({
      name: "cat",
      type: Cat,
      encoder: obj => {
        return { name: obj.name, color: obj.color, age: obj.age };
      },
      decoder: encoded_obj => {
        return new Cat(encoded_obj.name, encoded_obj.color, encoded_obj.age);
      }
    });

    const bobo = new Cat("boboshu", "mixed", 0.67);
    const cat = await api.echo(bobo);
    const result =
      cat instanceof Cat &&
      bobo.name === cat.name &&
      bobo.color === cat.color &&
      bobo.age === cat.age;
    expect(result).to.equal(true);

    await api.disconnect();
  }).timeout(20000);
});
