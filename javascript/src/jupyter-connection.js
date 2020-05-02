function setupRPC(config) {
  this.config = config || {};
  this.targetOrigin = this.config.target_origin || "*";
  this.comm = null;
  if (config.listen_events)
    // event listener for the plugin message
    window.addEventListener("message", e => {
      if (this.targetOrigin === "*" || e.origin === this.targetOrigin) {
        const data = e.data;
        const split = remove_buffers(data);
        split.state.__buffer_paths__ = split.buffer_paths;
        this.comm.send(data, {}, {}, split.buffers);
      }
    });

  if (config.register_comm)
    Jupyter.notebook.kernel.comm_manager.register_target(
      "imjoy_rpc",
      (comm, open_msg) => {
        const config = open_msg.content.data;
        this.comm = comm;
        comm.on_msg(msg => {
          const data = msg.content.data;
          const buffer_paths = data.__buffer_paths__ || [];
          delete data.__buffer_paths__;
          put_buffers(data, buffer_paths, msg.buffers || []);

          if (data.type === "log") {
            console.log(data.message);
          } else if (data.type === "error") {
            console.error(data.message);
          } else {
            parent.postMessage(data, this.targetOrigin);
          }
        });
      }
    );
}

$.getScript("http://127.0.0.1:8080/imjoy-loader.js").done(function() {
  //notebook view
  if (Jupyter.notebook) {
    // check if it's inside an iframe
    if (window.self !== window.top) {
      setupRPC({ register_comm: true, listen_events: true });
      console.log("ImJoy RPC started.");
      Jupyter.notebook.kernel.events.on("kernel_connected.Kernel", e => {
        setupRPC({ register_comm: true, listen_events: false });
        console.log("ImJoy RPC reconnected.");
      });
    } else {
      loadImJoyCore().then(imjoyCore => {
        alert("imjoy core loaded");
      });
    }
  }
  // tree view
  if (Jupyter.notebook_list) {
    loadImJoyAuto({ debug: true, version: "0.1.4" }).then(imjoyAuto => {
      if (imjoyAuto.mode === "core") {
        const imjoy = new imjoyCore.ImJoy({
          imjoy_api: {}
          //imjoy config
        });
        imjoy.start({ workspace: "default" }).then(() => {
          console.log("ImJoy Core started successfully!");
        });
      }
      if (imjoyAuto.mode === "plugin") {
        const api = imjoyAuto.api;
        function setup() {
          Jupyter._target = "self";
          api.alert("ImJoy plugin initialized.");
        }
        function getSelections() {
          return Jupyter.notebook_list.selected;
        }
        api.export({ setup, getSelections });
      }
    });
  }
});

function isSerializable(object) {
  return typeof object === "object" && object && object.toJSON;
}

function isObject(value) {
  return value && typeof value === "object" && value.constructor === Object;
}

// pub_buffers and remove_buffers are taken from https://github.com/jupyter-widgets/ipywidgets/blob/master/packages/base/src/utils.ts
// Author: IPython Development Team
// License: BSD
export function put_buffers(state, buffer_paths, buffers) {
  buffers = buffers.map(b => {
    if (b instanceof DataView) {
      return b;
    } else {
      return new DataView(b instanceof ArrayBuffer ? b : b.buffer);
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
                obj = { ...obj };
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
                  obj = { ...obj };
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
  return { state: new_state, buffers: buffers, buffer_paths: buffer_paths };
}
