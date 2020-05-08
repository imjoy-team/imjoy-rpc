/**
 * Contains the routines loaded by the plugin iframe under web-browser
 * in case when worker failed to initialize
 *
 * Initializes the web environment version of the platform-dependent
 * connection object for the plugin site
 */
import { connectRPC } from "./pluginCore.js";
import { API_VERSION, BaseConnection } from "./rpc.js";

// Create a new, plain <span> element
function _htmlToElement(html) {
  var template = document.createElement("template");
  html = html.trim(); // Never return a text node of whitespace as the result
  template.innerHTML = html;
  return template.content.firstChild;
}

var _importScript = function(url) {
  //url is URL of external file, implementationCode is the code
  //to be called from the file, location is the location to
  //insert the <script> element
  return new Promise((resolve, reject) => {
    var scriptTag = document.createElement("script");
    scriptTag.src = url;
    scriptTag.type = "text/javascript";
    scriptTag.onload = resolve;
    scriptTag.onreadystatechange = function() {
      if (this.readyState === "loaded" || this.readyState === "complete") {
        resolve();
      }
    };
    scriptTag.onerror = reject;
    document.head.appendChild(scriptTag);
  });
};

// support importScripts outside web worker
async function importScripts() {
  var args = Array.prototype.slice.call(arguments),
    len = args.length,
    i = 0;
  for (; i < len; i++) {
    await _importScript(args[i]);
  }
}

export class Connection extends BaseConnection {
  constructor(config) {
    super(config);
  }
  connect() {
    this.config.target_origin = this.config.target_origin || "*";
    // event listener for the plugin message
    window.addEventListener("message", e => {
      if (
        this.config.target_origin === "*" ||
        e.origin === this.config.target_origin
      ) {
        this._fire(e.data.type, e.data);
      }
    });
    this.emit({
      type: "initialized",
      config: this.config
    });
  }
  disconnect() {}
  emit(data, transferables) {
    parent.postMessage(data, this.config.target_origin, transferables);
  }
  async execute(code) {
    try {
      if (code.type === "requirements") {
        if (
          code.requirements &&
          (Array.isArray(code.requirements) ||
            typeof code.requirements === "string")
        ) {
          try {
            var link_node;
            code.requirements =
              typeof code.requirements === "string"
                ? [code.requirements]
                : code.requirements;
            if (Array.isArray(code.requirements)) {
              for (var i = 0; i < code.requirements.length; i++) {
                if (
                  code.requirements[i].toLowerCase().endsWith(".css") ||
                  code.requirements[i].startsWith("css:")
                ) {
                  if (code.requirements[i].startsWith("css:")) {
                    code.requirements[i] = code.requirements[i].slice(4);
                  }
                  link_node = document.createElement("link");
                  link_node.rel = "stylesheet";
                  link_node.href = code.requirements[i];
                  document.head.appendChild(link_node);
                } else if (
                  code.requirements[i].toLowerCase().endsWith(".js") ||
                  code.requirements[i].startsWith("js:")
                ) {
                  if (code.requirements[i].startsWith("js:")) {
                    code.requirements[i] = code.requirements[i].slice(3);
                  }
                  await importScripts(code.requirements[i]);
                } else if (code.requirements[i].startsWith("http")) {
                  await importScripts(code.requirements[i]);
                } else if (code.requirements[i].startsWith("cache:")) {
                  //ignore cache
                } else {
                  console.log(
                    "Unprocessed requirements url: " + code.requirements[i]
                  );
                }
              }
            } else {
              throw "unsupported requirements definition";
            }
          } catch (e) {
            throw "failed to import required scripts: " +
              code.requirements.toString();
          }
        }
      } else if (code.type === "script") {
        if (code.src) {
          var script_node = document.createElement("script");
          script_node.setAttribute("type", code.attrs.type);
          script_node.setAttribute("src", code.src);
          document.head.appendChild(script_node);
        } else {
          if (
            code.content &&
            (!code.attrs.type || code.attrs.type === "text/javascript")
          ) {
            // document.addEventListener("DOMContentLoaded", function(){
            eval(code.content);
            // });
          } else {
            var node = document.createElement("script");
            node.setAttribute("type", code.attrs.type);
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
      parent.postMessage({ type: "executeSuccess" }, this.config.target_origin);
    } catch (e) {
      console.error("failed to execute scripts: ", code, e);
      parent.postMessage(
        { type: "executeFailure", error: e.stack || String(e) },
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
  conn.connect();
  connectRPC(conn, config);
}
