/**
 * Contains the routines loaded by the plugin Worker under web-browser.
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { connectRPC } from "./pluginCore.js";
import { API_VERSION } from "./rpc.js";
import { MessageEmitter, loadRequirementsInWebworker } from "./utils.js";

// make sure this runs inside a webworker
if (
  typeof WorkerGlobalScope === "undefined" ||
  !self ||
  !(self instanceof WorkerGlobalScope)
) {
  throw new Error("This script can only loaded in a webworker");
}

async function executeEsModule(content) {
  const dataUri =
    "data:text/javascript;charset=utf-8," + encodeURIComponent(content);
  await import(/* webpackIgnore: true */ dataUri);
}

/**
 * Connection object provided to the RPC constructor,
 * plugin site implementation for the web-based environment.
 * Global will be then cleared to prevent exposure into the
 * Worker, so we put this local connection object into a closure
 */
class Connection extends MessageEmitter {
  constructor(config) {
    super(config && config.debug);
    this.config = config || {};
  }
  connect() {
    self.addEventListener("message", e => {
      this._fire(e.data.type, e.data);
    });
    this.emit({
      type: "initialized",
      config: this.config
    });
  }
  disconnect() {
    this._fire("beforeDisconnect");
    self.close();
    this._fire("disconnected");
  }
  emit(data) {
    let transferables = undefined;
    if (data.__transferables__) {
      transferables = data.__transferables__;
      delete data.__transferables__;
    }
    self.postMessage(data, transferables);
  }
  async execute(code) {
    if (code.type === "requirements") {
      await loadRequirementsInWebworker(code.requirements);
    } else if (code.type === "script") {
      try {
        if (code.attrs.type === "module") {
          await executeEsModule(code.content);
        } else {
          eval(code.content);
        }
      } catch (e) {
        console.error(e.message, e.stack);
        throw e;
      }
    } else {
      throw "unsupported code type.";
    }
    if (code.type === "requirements") {
      self.postMessage({
        type: "cacheRequirements",
        requirements: code.requirements
      });
    }
  }
}
const config = {
  type: "web-worker",
  dedicated_thread: true,
  allow_execution: true,
  lang: "javascript",
  api_version: API_VERSION
};
const conn = new Connection(config);
conn.on("connectRPC", data => {
  connectRPC(conn, Object.assign(data.config, config));
});
conn.connect();
self.postMessage({
  type: "worker-ready"
});
