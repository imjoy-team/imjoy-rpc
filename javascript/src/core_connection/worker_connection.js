import { IframeConnection } from "./iframe_connection.js";

export class WebWorkerConnection extends IframeConnection {
  constructor(worker) {
    super();
    this._worker = worker;
  }

  connect() {
    // TODO: remove listener when disconnected
    this._worker.addEventListener("message", e => {
      const target_id = e.data.target_id;
      if (target_id && this._peer_id && target_id !== this._peer_id) {
        const conn = all_connections[target_id];
        if (conn) conn._fire(e.data.type, e.data);
        else
          console.warn(
            `connection with target_id ${target_id} not found, discarding data: `,
            e.data
          );
      } else {
        this._fire(e.data.type, e.data);
      }
    });
    this._fire("connected");
  }

  emit(data) {
    let transferables = undefined;
    if (data.__transferables__) {
      transferables = data.__transferables__;
      delete data.__transferables__;
    }
    if (this._access_token) {
      if (Date.now() >= this._expires_in * 1000) {
        //TODO: refresh access token
        throw new Error("Refresh token is not implemented.");
      }
      data.access_token = this._access_token;
    }
    data.peer_id = this._peer_id || data.peer_id;
    this._worker.postMessage(data, transferables);
  }
}
