import { expect } from "chai";
import { ImJoyRPC } from "../src/imjoyRPC.js";

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
    const site = new ImJoyRPC(conn);
    expect(true).to.be.true;
  });
});
