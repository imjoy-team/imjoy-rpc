(function ($) {
  $.getStylesheet = function (href) {
    var $d = $.Deferred();
    var $link = $("<link/>", {
      rel: "stylesheet",
      type: "text/css",
      href: href
    }).appendTo("head");
    $d.resolve($link);
    return $d.promise();
  };
})(jQuery);


$.getStylesheet(
  "https://imjoy-team.github.io/vue-js-modal/styles.css"
);

$.getStylesheet(
  "https://fezvrasta.github.io/snackbarjs/themes-css/material.css"
);

$.getStylesheet(
  "https://fezvrasta.github.io/snackbarjs/dist/snackbar.min.css"
);

function randId() {
  return Math.random()
    .toString(36)
    .substr(2, 10);
}


class MessageEmitter {
  constructor(debug) {
    this._event_handlers = {};
    this._once_handlers = {};
    this._debug = debug;
  }
  emit() {
    throw new Error("emit is not implemented");
  }
  on(event, handler) {
    if (!this._event_handlers[event]) {
      this._event_handlers[event] = [];
    }
    this._event_handlers[event].push(handler);
  }
  once(event, handler) {
    handler.___event_run_once = true;
    this.on(event, handler);
  }
  off(event, handler) {
    if (!event && !handler) {
      // remove all events handlers
      this._event_handlers = {};
    } else if (event && !handler) {
      // remove all hanlders for the event
      if (this._event_handlers[event]) this._event_handlers[event] = [];
    } else {
      // remove a specific handler
      if (this._event_handlers[event]) {
        const idx = this._event_handlers[event].indexOf(handler);
        if (idx >= 0) {
          this._event_handlers[event].splice(idx, 1);
        }
      }
    }
  }
  _fire(event, data) {
    if (this._event_handlers[event]) {
      var i = this._event_handlers[event].length;
      while (i--) {
        const handler = this._event_handlers[event][i];
        try {
          handler(data);
        } catch (e) {
          console.error(e);
        } finally {
          if (handler.___event_run_once) {
            this._event_handlers[event].splice(i, 1);
          }
        }
      }
    } else {
      if (this._debug) {
        console.warn("unhandled event", event, data);
      }
    }
  }
}

function initPlugin(config) {
  config = config || {};
  const targetOrigin = config.target_origin || "*";
  const peer_id = randId();
  const pluginConfig = {
    allow_execution: false,
    version: "0.1.1",
    api_version: "0.2.3",
    dedicated_thread: true,
    description: "Jupyter notebook",
    id: "jupyter_" + randId(),
    lang: "python",
    name: "Jupyter Notebook",
    type: "rpc-window",
    origin: window.location.origin,
    defaults: {
      fullscreen: true
    }
  };
  parent.postMessage({
      type: "initialized",
      config: pluginConfig,
      peer_id: peer_id
    },
    targetOrigin
  );
}

const IMJOY_LOADER_URL = "https://imjoy.io/imjoy-loader.js";
require.config({
  baseUrl: "js",
  paths: {
    imjoyLoader: "https://lib.imjoy.io/imjoy-loader",
    vue: "https://cdn.jsdelivr.net/npm/vue@2.6.10/dist/vue.min",
    "vue-js-modal": "https://imjoy-team.github.io/vue-js-modal/index",
    snackbar: "https://cdnjs.cloudflare.com/ajax/libs/snackbarjs/1.1.0/snackbar.min",
  },
  waitSeconds: 30 // optional
});

class Connection extends MessageEmitter {
  constructor(config) {
    super(config && config.debug);
    const comm = Jupyter.notebook.kernel.comm_manager.new_comm("imjoy_rpc", {});
    comm.on_msg(msg => {
      const data = msg.content.data;
      const buffer_paths = data.__buffer_paths__ || [];
      delete data.__buffer_paths__;
      put_buffers(data, buffer_paths, msg.buffers || []);
      if (data.type === "log" || data.type === "info") {
        console.log(data.message);
      } else if (data.type === "error") {
        console.error(data.message);
      } else {
        if (data.peer_id) {
          this._peer_id = data.peer_id
        }
        this._fire(data.type, data);
      }
    });
    this.comm = comm;
  }
  connect() {}
  disconnect() {}
  emit(data) {
    data.peer_id = this._peer_id;
    const split = remove_buffers(data);
    split.state.__buffer_paths__ = split.buffer_paths;
    this.comm.send(split.state, {}, {}, split.buffers);
  }
};

async function startImJoy(app, imjoy) {
  await imjoy.start()
  imjoy.event_bus.on("show_message", msg => {
    $.snackbar({
      content: msg,
      timeout: 5000
    });
  });
  imjoy.event_bus.on("close_window", w => {
    const idx = app.dialogWindows.indexOf(w)
    if (idx >= 0)
      app.dialogWindows.splice(idx, 1)
    app.$forceUpdate()
  })
  imjoy.event_bus.on("add_window", w => {
    if (document.getElementById(w.window_id)) return;
    if (!w.dialog) {
      if (document.getElementById(app.active_plugin.id)) {
        const elem = document.createElement("div");
        elem.id = w.window_id;
        elem.classList.add("imjoy-inline-window")
        document.getElementById(app.active_plugin.id).appendChild(elem)
        return
      }
    }
    app.dialogWindows.push(w)
    app.selected_dialog_window = w;
    if (w.fullscreen || w.standalone)
      app.fullscreen = true;
    else
      app.fullscreen = false;
    app.$modal.show("window-modal-dialog");
    app.$forceUpdate()
    w.api.show = w.show = () => {
      app.selected_dialog_window = w;
      app.$modal.show("window-modal-dialog");
      imjoy.wm.selectWindow(w);
      w.api.emit("show");
    };

    w.api.hide = w.hide = () => {
      if (app.selected_dialog_window === w) {
        app.$modal.hide("window-modal-dialog");
      }
      w.api.emit("hide");
    };

    setTimeout(() => {
      try {
        w.show();
      } catch (e) {
        console.error(e);
      }
    }, 500);
  });
}

function setupComm(targetOrigin) {
  console.log(Jupyter.notebook.kernel.comm_manager);
  const comm = Jupyter.notebook.kernel.comm_manager.new_comm("imjoy_rpc", {});
  comm.on_msg(msg => {
    const data = msg.content.data;
    const buffer_paths = data.__buffer_paths__ || [];
    delete data.__buffer_paths__;
    put_buffers(data, buffer_paths, msg.buffers || []);

    if (data.type === "log" || data.type === "info") {
      console.log(data.message);
    } else if (data.type === "error") {
      console.error(data.message);
    } else {
      parent.postMessage(data, targetOrigin);
    }
  });
  return comm;
}

function setupMessageHandler(targetOrigin, comm) {
  // event listener for the plugin message
  window.addEventListener("message", e => {
    if (targetOrigin === "*" || e.origin === targetOrigin) {
      const data = e.data;
      const split = remove_buffers(data);
      split.state.__buffer_paths__ = split.buffer_paths;
      comm.send(split.state, {}, {}, split.buffers);
    }
  });
}

const CSStyle = `
<style>
.vm--modal{
  max-height: 100%!important;
  max-width: 100%!important;
}
.imjoy-inline-window{
  width: 100%;
  height: 600px;
}
</style>`

const APP_TEMPLATE = `
<div style="padding-left: 5px;">
<div class="btn-group">
  <button class="btn btn-default dropdown">
    <a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-expanded="false"><img src="https://imjoy.io/static/img/imjoy-logo-black.svg" style="height: 17px;"></a>
    <ul id="plugin_menu" class="dropdown-menu"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-expanded="false">
      <li v-for="(p, name) in plugins" :key="p.id" :title="p.config.description"><a href="#" :style="{color: p.api.run?'#0456ef':'gray'}" @click="run(p)">{{p.name}}</a></li>
      <ul class="divider" v-if="plugins&&Object.keys(plugins).length>0"></ul>
      <li title="Load a new plugin"><a href="#" @click="loadPlugin()"><i class="fa-plus fa"></i>&nbsp;Load Plugin</a></li>
      <li title="Show ImJoy API documentation"><a href="#" @click="loadImJoyApp()"><i class="fa-rocket fa"></i>&nbsp;ImJoy App</a></li>
      <li title="Show ImJoy API documentation"><a href="#" @click="showAPIDocs()"><i class="fa-book fa"></i>&nbsp;API Docs</a></li>
      <li title="About ImJoy"><a href="#" @click="aboutImJoy()"><i class="fa-info-circle fa"></i>&nbsp;About ImJoy</a></li>
    </ul>
  </button>
  <button class="btn btn-default" v-if="active_plugin" @click="runNotebookPlugin()"><i class="fa-play fa"></i>&nbsp;Run</button>
</div>
<div class="btn-group">
  <button v-for="wdialog in dialogWindows" :title="wdialog.name" class="btn btn-default" @click="showWindow(wdialog)"><i class="fa fa-window-restore"></i></i></button>
</div>
<modal name="window-modal-dialog" height="500px" style="max-height: 100%; max-width: 100%" :fullscreen="fullscreen" :resizable="true" draggable=".drag-handle" :scrollable="true">
    <div v-if="selected_dialog_window" @dblclick="maximizeWindow()" class="navbar-collapse collapse drag-handle" style="cursor:move; background-color: #448aff; color: white; text-align: center;">
      {{ selected_dialog_window.name}}
      <button @click="closeWindow(selected_dialog_window)" style="height: 16px;border:0px;font-size:1rem;position:absolute;background:#ff0000c4;color:white;top:1px; left:1px;">
        X
      </button>
      <button @click="minimizeWindow()" style="height: 16px;border:0px;font-size:1rem;position:absolute;background:#00cdff61;color:white;top:1px; left:25px;">
        -
      </button>
      <button @click="maximizeWindow()" style="height: 16px;border:0px;font-size:1rem;position:absolute;background:#00cdff61;color:white;top:1px; left:45px;">
        {{fullscreen?'=': '+'}}
      </button>
    </div>
  <template v-for="wdialog in dialogWindows">
    <div
      :key="wdialog.window_id"
      v-show="wdialog === selected_dialog_window"
      style="height: calc(100% - 18px);"
    >
      <div :id="wdialog.window_id" style="width: 100%;height: 100%;"></div>
    </div>
  </template>
</modal>
</div>
`

define([
  'jquery',
  'base/js/namespace'
], function (
  $,
  Jupyter
) {
  function load_ipython_extension() {
    // check if it's inside an iframe
    // if yes, initialize the rpc connection
    if (window.self !== window.top) {
      initPlugin();
      window.connectPlugin = function () {
        comm = setupComm("*");
        setupMessageHandler("*", comm);
        console.log("ImJoy RPC reloaded.");
      };
      var elem = document.createElement("div");
      elem.id = "app";
      elem.style.display = "inline-block"
      elem.innerHTML = `<button class="btn btn-default" onclick="connectPlugin()"><i class="fa-play fa"></i>&nbsp;<img src="https://imjoy.io/static/img/imjoy-logo-black.svg" style="height: 18px;"></button>`;
      document.getElementById("maintoolbar-container").appendChild(elem);
      console.log("ImJoy RPC started.");

      // otherwise, load the imjoy core and run in standalone mode
    } else {
      require(["imjoyLoader", "vue", "vue-js-modal", "snackbar"], function (
        imjoyLoder,
        Vue,
        vuejsmodal,
        snackbar
      ) {
        Vue.use(vuejsmodal.default);
        var elem = document.createElement("div");
        elem.id = "app";
        elem.style.display = "inline-block"
        elem.innerHTML = APP_TEMPLATE;
        document.getElementById("maintoolbar-container").appendChild(elem);
        document.head.insertAdjacentHTML("beforeend", CSStyle)
        const app = new Vue({
          el: "#app",
          data: {
            dialogWindows: [],
            selected_dialog_window: null,
            plugins: {},
            fullscreen: false,
            imjoy: null,
            active_plugin: null,
          },
          mounted() {
            window.dispatchEvent(new Event('resize'));
            imjoyLoder.loadImJoyCore({
              version: '0.13.16'
            }).then(imjoyCore => {
              console.log(`ImJoy Core (v${imjoyCore.VERSION}) loaded.`)
              const imjoy = new imjoyCore.ImJoy({
                imjoy_api: {
                  async showMessage(_plugin, msg, duration) {
                    duration = duration || 5
                    $.snackbar({
                      content: msg,
                      timeout: duration * 1000
                    });
                  },
                  async showDialog(_plugin, config) {
                    config.dialog = true;
                    return await imjoy.pm.createWindow(_plugin, config)
                  }
                }
              });
              this.imjoy = imjoy;
              startImJoy(this, this.imjoy).then(() => {
                const base_url = new URL(Jupyter.notebook.base_url, document.baseURI).href
                if (!base_url.endsWith('/')) base_url = base_url + '/';
                this.imjoy.pm
                  .reloadPluginRecursively({
                    uri: base_url + 'elfinder/'
                  })
                  .then(async plugin => {
                    this.plugins[plugin.name] = plugin
                    this.showMessage(`Plugin ${plugin.name} successfully loaded into the workspace.`)
                    this.$forceUpdate()
                  })
                  .catch(e => {
                    console.error(e);
                    this.showMessage(`Failed to load the ImJoy elFinder plugin, error: ${e}`);
                  });
              })
            });
          },
          methods: {
            loadImJoyApp() {
              this.imjoy.pm.imjoy_api.showDialog(null, {
                src: 'https://imjoy.io/#/app',
                fullscreen: true,
                passive: true,
              })
            },
            aboutImJoy() {
              this.imjoy.pm.imjoy_api.showDialog(null, {
                src: 'https://imjoy.io/#/about',
                passive: true,
              })
            },
            showAPIDocs() {
              this.imjoy.pm.imjoy_api.showDialog(null, {
                src: 'https://imjoy.io/docs/#/api',
                passive: true,
              })
            },
            async connectPlugin() {
              const plugin = await this.imjoy.pm
                .connectPlugin(new Connection())
              this.plugins[plugin.name] = plugin
              this.active_plugin = plugin;
              if (plugin.api.setup) {
                await plugin.api.setup()
              }
              this.$forceUpdate()
            },
            async runNotebookPlugin() {
              try {
                const plugin = this.active_plugin;
                if (plugin.api.run) {
                  let config = {};
                  if (plugin.config.ui && plugin.config.ui.indexOf("{") > -1) {
                    config = await this.imjoy.pm.imjoy_api.showDialog(
                      plugin,
                      plugin.config
                    );
                  }
                  await plugin.api.run({
                    config: config,
                    data: {}
                  });
                }
              } catch (e) {
                console.error(e);
                this.showMessage(`Failed to load the plugin, error: ${e}`);
              }
            },
            async run(plugin) {
              let config = {};
              if (plugin.config.ui && plugin.config.ui.indexOf("{") > -1) {
                config = await this.imjoy.pm.imjoy_api.showDialog(
                  plugin,
                  plugin.config
                );
              }
              await plugin.api.run({
                config: config,
                data: {}
              });
            },
            showMessage(msg, duration) {
              duration = duration || 5
              $.snackbar({
                content: msg,
                timeout: duration * 1000
              });
            },
            loadPlugin() {
              const p = prompt(
                `Please type a ImJoy plugin URL`,
                "https://github.com/imjoy-team/imjoy-plugins/blob/master/repository/ImageAnnotator.imjoy.html"
              );
              this.imjoy.pm
                .reloadPluginRecursively({
                  uri: p
                })
                .then(async plugin => {
                  this.plugins[plugin.name] = plugin
                  this.showMessage(`Plugin ${plugin.name} successfully loaded into the workspace.`)
                  this.$forceUpdate()
                })
                .catch(e => {
                  console.error(e);
                  this.showMessage(`Failed to load the plugin, error: ${e}`);
                });
            },
            showWindow(w) {
              if (w.fullscreen || w.standalone)
                this.fullscreen = true
              else
                this.fullscreen = false
              if (w) this.selected_dialog_window = w;
              this.$modal.show("window-modal-dialog");
            },
            closeWindow(w) {
              this.selected_dialog_window = null;
              this.$modal.hide("window-modal-dialog");
              const idx = this.dialogWindows.indexOf(w)
              if (idx >= 0)
                this.dialogWindows.splice(idx, 1)
            },
            minimizeWindow() {
              this.$modal.hide("window-modal-dialog");
            },
            maximizeWindow() {
              this.fullscreen = !this.fullscreen;
            }
          }
        });
        window.connectPlugin = async function () {
          await app.connectPlugin()
          await app.runNotebookPlugin()
        }
      });
    }
  }

  return {
    load_ipython_extension: load_ipython_extension
  };
});


// tree view
if (Jupyter.notebook_list) {
  // if inside an iframe, load imjoy-rpc
  if (window.self !== window.top) {
    loadImJoyRPC().then(imjoyRPC => {
      imjoyRPC.setupRPC({
        name: "Jupyter Content"
      }).then(api => {
        function setup() {
          Jupyter._target = "self";
          api.log("ImJoy plugin initialized.");
        }

        function getSelections() {
          return Jupyter.notebook_list.selected;
        }
        api.export({
          setup,
          getSelections
        });
      });
    });
  }
}


function isSerializable(object) {
  return typeof object === "object" && object && object.toJSON;
}

function isObject(value) {
  return value && typeof value === "object" && value.constructor === Object;
}

// pub_buffers and remove_buffers are taken from
// https://github.com/jupyter-widgets/ipywidgets/blob/master/packages/base/src/utils.ts
// Author: IPython Development Team
// License: BSD
function put_buffers(state, buffer_paths, buffers) {
  buffers = buffers.map(b => {
    if (b instanceof DataView) {
      return b.buffer;
    } else {
      return b instanceof ArrayBuffer ? b : b.buffer;
    }
  });
  for (let i = 0; i < buffer_paths.length; i++) {
    const buffer_path = buffer_paths[i];
    // say we want to set state[x][y][z] = buffers[i]
    let obj = state;
    // we first get obj = state[x][y]
    for (let j = 0; j < buffer_path.length - 1; j++) {
      obj = obj[buffer_path[j]];
    }
    // and then set: obj[z] = buffers[i]
    obj[buffer_path[buffer_path.length - 1]] = buffers[i];
  }
}

/**
 * The inverse of put_buffers, return an objects with the new state where all buffers(ArrayBuffer)
 * are removed. If a buffer is a member of an object, that object is cloned, and the key removed. If a buffer
 * is an element of an array, that array is cloned, and the element is set to null.
 * See put_buffers for the meaning of buffer_paths
 * Returns an object with the new state (.state) an array with paths to the buffers (.buffer_paths),
 * and the buffers associated to those paths (.buffers).
 */
function remove_buffers(state) {
  const buffers = [];
  const buffer_paths = [];
  // if we need to remove an object from a list, we need to clone that list, otherwise we may modify
  // the internal state of the widget model
  // however, we do not want to clone everything, for performance
  function remove(obj, path) {
    if (isSerializable(obj)) {
      // We need to get the JSON form of the object before recursing.
      // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#toJSON()_behavior
      obj = obj.toJSON();
    }
    if (Array.isArray(obj)) {
      let is_cloned = false;
      for (let i = 0; i < obj.length; i++) {
        const value = obj[i];
        if (value) {
          if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            if (!is_cloned) {
              obj = obj.slice();
              is_cloned = true;
            }
            buffers.push(ArrayBuffer.isView(value) ? value.buffer : value);
            buffer_paths.push(path.concat([i]));
            // easier to just keep the array, but clear the entry, otherwise we have to think
            // about array length, much easier this way
            obj[i] = null;
          } else {
            const new_value = remove(value, path.concat([i]));
            // only assigned when the value changes, we may serialize objects that don't support assignment
            if (new_value !== value) {
              if (!is_cloned) {
                obj = obj.slice();
                is_cloned = true;
              }
              obj[i] = new_value;
            }
          }
        }
      }
    } else if (isObject(obj)) {
      for (const key in obj) {
        let is_cloned = false;
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key];
          if (value) {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
              if (!is_cloned) {
                obj = {
                  ...obj
                };
                is_cloned = true;
              }
              buffers.push(ArrayBuffer.isView(value) ? value.buffer : value);
              buffer_paths.push(path.concat([key]));
              delete obj[key]; // for objects/dicts we just delete them
            } else {
              const new_value = remove(value, path.concat([key]));
              // only assigned when the value changes, we may serialize objects that don't support assignment
              if (new_value !== value) {
                if (!is_cloned) {
                  obj = {
                    ...obj
                  };
                  is_cloned = true;
                }
                obj[key] = new_value;
              }
            }
          }
        }
      }
    }
    return obj;
  }
  const new_state = remove(state, []);
  return {
    state: new_state,
    buffers: buffers,
    buffer_paths: buffer_paths
  };
}