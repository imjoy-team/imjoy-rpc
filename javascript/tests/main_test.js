import { expect } from "chai";
import { RPC } from "../src/rpc.js";

describe("test", async () => {
  it("pass test", async () => {
    const conn = {
      disconnect: function() {},
      send: function(data, transferables) {},
      onMessage: function(h) {
        conn._messageHandler = h;
      },
      _messageHandler: function() {},
      onDisconnect: function() {}
    };
    const site = new RPC(conn);
    expect(true).to.be.true;
  });
});
