#!/usr/bin/env node
/**
 * Server MCP mock untuk menguji bahwa env/rahasia diteruskan ke proses server:
 * tool `show_env` mengembalikan nilai variabel lingkungan yang diminta.
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "env-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "show_env",
            description: "Tampilkan nilai variabel lingkungan.",
            inputSchema: {
              type: "object",
              properties: { var: { type: "string" } },
              required: ["var"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    const value = String(process.env[args.var] ?? "(kosong)");
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }] } });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});