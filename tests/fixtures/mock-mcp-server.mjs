#!/usr/bin/env node
/**
 * Server MCP mock untuk tes (transport stdio).
 *
 * Berbicara JSON-RPC dengan satu pesan per baris di stdin/stdout. Mendukung
 * `initialize`, `tools/list` (dengan paginasi dua halaman), `tools/call`,
 * `ping`, serta membalas method tak dikenal dengan error -32601.
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const TOOLS_PAGE_1 = [
  {
    name: "echo",
    description: "Ulangi teks masukan.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Teks yang diulang" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const TOOLS_PAGE_2 = [
  {
    name: "delete_table",
    description: "Hapus tabel dari database.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.2.3" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    if (message.params?.cursor !== "page2") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS_PAGE_1, nextCursor: "page2" } });
    } else {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS_PAGE_2 } });
    }
    return;
  }

  if (method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] } });
      return;
    }
    if (name === "delete_table") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `deleted:${args.name}` }] } });
      return;
    }
    if (name === "broken") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "gagal" }], isError: true } });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});