function setupRPC(config) {
  this.config = config || {};
  this.targetOrigin = this.config.target_origin || "*";
  this.comm = null;
  if (config.listen_events)
    // event listener for the plugin message
    window.addEventListener("message", e => {
      if (this.targetOrigin === "*" || e.origin === this.targetOrigin) {
        this.comm.send(e.data);
      }
    });

  if (config.register_comm)
    Jupyter.notebook.kernel.comm_manager.register_target(
      "imjoy_rpc",
      (comm, open_msg) => {
        const config = open_msg.content.data;
        this.comm = comm;
        comm.on_msg(msg => {
          var data = msg.content.data;
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
