import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { spawn } from "node:child_process";
import { startService } from "../modules/providers/services";

async function main() {
  await startService("worker");
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      process.argv.includes("--production") ? "start" : "dev",
      "--hostname",
      "127.0.0.1",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  server.on("exit", (code) => process.exit(code || 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.kill(signal));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
