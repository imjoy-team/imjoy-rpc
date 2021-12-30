/**
 * Contains the routines loaded by the plugin iframe under web-browser
 * in case when worker failed to initialize
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { connectRPC } from "./pluginCore.js";
import { API_VERSION } from "./rpc.js";
import { loadRequirementsInWindow, MessageEmitter, randId } from "./utils.js";
// Create a new, plain <span> element
function _htmlToElement(html) {
  var template = document.createElement("template");
  html = html.trim(); // Never return a text node of whitespace as the result
  template.innerHTML = html;
  return template.content.firstChild;
}

const _inWebWorker =
  typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

async function executeEsModule(content) {
  const dataUri =
    "data:text/javascript;charset=utf-8," + encodeURIComponent(content);
  await import(/* webpackIgnore: true */ dataUri);
}

export class Connection extends MessageEmitter {
  constructor(config) {
    super(config && config.debug);
    this.config = config || {};
    this.peer_id = randId();
  }
  connect() {
    this.config.target_origin = this.config.target_origin || "*";
    // this will call handleEvent function
    if (this.config.broadcastChannel) {
      this.broadcastChannel = new BroadcastChannel(
        this.config.broadcastChannel
      );
    } else {
      this.broadcastChannel = null;
    }
    if (this.broadcastChannel)
      this.broadcastChannel.addEventListener("message", this);
    else globalThis.addEventListener("message", this);
    this.emit({
      type: "initialized",
      config: this.config,
      origin: globalThis.location.origin,
      peer_id: this.peer_id
    });
    this._fire("connected");
  }
  handleEvent(e) {
    if (
      e.type === "message" &&
      (this.broadcastChannel ||
        this.config.target_origin === "*" ||
        !e.origin ||
        e.origin === this.config.target_origin)
    ) {
      if (e.data.peer_id === this.peer_id) {
        this._fire(e.data.type, e.data);
      } else if (this.config.debug) {
        console.log(
          `connection peer id mismatch ${e.data.peer_id} !== ${this.peer_id}`
        );
      }
    }
  }
  disconnect() {
    this._fire("beforeDisconnect");
    globalThis.removeEventListener("message", this);
    this._fire("disconnected");
  }
  emit(data) {
    let transferables;
    if (this.broadcastChannel) this.broadcastChannel.postMessage(data);
    else {
      if (data.__transferables__) {
        transferables = data.__transferables__;
        delete data.__transferables__;
      } else if (_inWebWorker) self.postMessage(data, transferables);
      else parent.postMessage(data, this.config.target_origin, transferables);
    }
  }
  async execute(code) {
    try {
      if (code.type === "requirements") {
        await loadRequirementsInWindow(code.requirements);
      } else if (code.type === "script") {
        if (code.src) {
          var script_node = document.createElement("script");
          script_node.setAttribute("type", code.attrs.type);
          script_node.setAttribute("src", code.src);
          document.head.appendChild(script_node);
        } else {
          if (code.content && code.attrs.lang === "javascript") {
            // document.addEventListener("DOMContentLoaded", function(){
            if (code.attrs.type === "module") {
              await executeEsModule(code.content);
            } else {
              eval(code.content);
            }
            // });
          } else {
            var node = document.createElement("script");
            for (let k in code.attrs) {
              node.setAttribute(k, code.attrs[k]);
            }
            node.appendChild(document.createTextNode(code.content));
            document.body.appendChild(node);
          }
        }
      } else if (code.type === "style") {
        const style_node = document.createElement("style");
        if (code.src) {
          style_node.src = code.src;
        }
        style_node.innerHTML = code.content;
        document.head.appendChild(style_node);
      } else if (code.type === "link") {
        const link_node_ = document.createElement("link");
        if (code.rel) {
          link_node_.rel = code.rel;
        }
        if (code.href) {
          link_node_.href = code.href;
        }
        if (code.attrs && code.attrs.type) {
          link_node_.type = code.attrs.type;
        }
        document.head.appendChild(link_node_);
      } else if (code.type === "html") {
        document.body.appendChild(_htmlToElement(code.content));
      } else {
        throw "unsupported code type.";
      }
      if (_inWebWorker) self.postMessage({ type: "executed" });
      else parent.postMessage({ type: "executed" }, this.config.target_origin);
    } catch (e) {
      console.error("failed to execute scripts: ", code, e);
      if (_inWebWorker)
        self.postMessage({ type: "executed", error: e.stack || String(e) });
      else
        parent.postMessage(
          { type: "executed", error: e.stack || String(e) },
          this.config.target_origin
        );
    }
  }
}

export default function setupIframe(config) {
  config = config || {};
  config.dedicated_thread = false;
  config.lang = "javascript";
  config.api_version = API_VERSION;
  const conn = new Connection(config);
  connectRPC(conn, config);
  conn.connect();
}
