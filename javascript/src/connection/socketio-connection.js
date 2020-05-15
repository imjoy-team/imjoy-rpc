import io from "socket.io-client";

const socket = io("http://localhost:8080");
// TODO: support socketio message forwarding
socket.on("connect", () => {});
