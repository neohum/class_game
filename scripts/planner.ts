#!/usr/bin/env node
/**
 * planner.ts — Harness Plan Documents Local Web Console Entrypoint.
 * Runs the Harness Plan Console web server and launches it in Google Chrome / browser.
 *
 * Usage:
 *   node scripts/planner.ts [--port=4790] [--project=<path>] [--no-open]
 */
import { server, openInBrowser } from "./loop/planner-web.ts";
import { resolve } from "node:path";

const PORT = Number(process.env.HARNESS_PLANNER_PORT) || 4790;
const shouldOpen = !process.argv.includes("--no-open");
const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = Number(portArg) || PORT;

const projectArg = process.argv.find((a) => a.startsWith("--project="))?.split("=")[1];
const targetProject = projectArg ? resolve(projectArg) : process.cwd();

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}?project=${encodeURIComponent(targetProject)}`;
  console.log(`\n======================================================`);
  console.log(`📝 [Harness Plan Console] Plan Documents & Recon Console`);
  console.log(`👉 URL: ${url}`);
  console.log(`📂 Project Workspace: ${targetProject}`);
  console.log(`======================================================\n`);
  if (shouldOpen) {
    console.log(`[Harness Plan Console] 브라우저를 실행하여 계획서 콘솔을 엽니다...`);
    openInBrowser(url);
  }
});

export { server, openInBrowser, port };
