#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/index.mjs");

console.log("=== Testing Claude Code Codex MCP Server ===");
console.log(`Target: ${serverPath}`);

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stage = 0;

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);

      // Stage 0: Handshake Response
      if (stage === 0 && msg.id === 1) {
        if (msg.result?.serverInfo?.name) {
          console.log(`[PASS] Handshake successful: ${msg.result.serverInfo.name} v${msg.result.serverInfo.version}`);
        } else {
          console.error("[FAIL] Unexpected handshake result:", msg);
          process.exit(1);
        }
        stage = 1;
        // Request tools/list
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        });
      }

      // Stage 1: Tools List Response
      else if (stage === 1 && msg.id === 2) {
        const tools = msg.result?.tools || [];
        console.log(`[PASS] Registered ${tools.length} MCP tools:`);
        for (const t of tools) {
          console.log(`  - ${t.name}: ${t.description.slice(0, 60)}...`);
        }
        if (tools.length < 8) {
          console.error("[FAIL] Expected at least 8 tools!");
          process.exit(1);
        }

        stage = 2;
        // Test codex_status
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "codex_status", arguments: {} },
        });
      }

      // Stage 2: codex_status Response
      else if (stage === 2 && msg.id === 3) {
        const text = msg.result?.content?.[0]?.text || "";
        console.log("[PASS] codex_status output verified:");
        console.log("-----------------------------------------");
        console.log(text.trim());
        console.log("-----------------------------------------");

        console.log("\n[SUCCESS] All MCP tests passed successfully!");
        child.kill();
        process.exit(0);
      }
    } catch (e) {
      console.error("Parse error on message:", line, e);
    }
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[Server Stderr] ${chunk.toString()}`);
});

child.on("close", (code) => {
  if (stage < 2) {
    console.error(`[FAIL] Process exited prematurely with code ${code}`);
    process.exit(1);
  }
});

// Send Initialize
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-runner", version: "1.0.0" },
  },
});

setTimeout(() => {
  console.error("[TIMEOUT] Server did not respond in 8 seconds");
  child.kill();
  process.exit(1);
}, 8000);
