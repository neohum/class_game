#!/usr/bin/env node
/**
 * studio.ts — Multi-Agent Live Studio entrypoint.
 * Runs the Harness Studio server and launches it in Google Chrome.
 *
 * Usage:
 *   node scripts/studio.ts [--port=4780] [--no-open]
 */
import { server, openInChrome, PORT } from "./loop/dashboard.ts";

const shouldOpen = !process.argv.includes("--no-open");
const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = Number(portArg) || PORT;

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n======================================================`);
  console.log(`🚀 [Harness Studio] Multi-Agent Live Code Console`);
  console.log(`👉 URL: ${url}`);
  console.log(`======================================================\n`);
  if (shouldOpen) {
    console.log(`[Harness Studio] Google Chrome을 실행하여 실시간 관제 화면을 엽니다...`);
    openInChrome(url);
  }
});

export { server, openInChrome, port };
