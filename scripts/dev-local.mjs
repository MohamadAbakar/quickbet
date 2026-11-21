// Local-network fallback: build the app and serve app + API + WebSocket from one
// process on this Mac, reachable from phones on the same Wi-Fi.
//   npm run dev
import { spawnSync, spawn } from "node:child_process";
import os from "node:os";

const port = process.env.PORT ?? "8787";
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

console.log("Building the app (served by the server, same origin)…");
const build = spawnSync("npm", ["run", "build", "-w", "app"], {
  stdio: "inherit",
  env: { ...process.env, VITE_SERVER_URL: "" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

console.log(`\nOpen on phones (same Wi-Fi): http://${lan ?? "localhost"}:${port}`);
console.log("Phones scan the lobby QR with the built-in camera app. The in-app scanner needs HTTPS.\n");
const server = spawn("npm", ["run", "start", "-w", "server"], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, ALLOWED_ORIGIN: "*" },
});
server.on("exit", (code) => process.exit(code ?? 0));
