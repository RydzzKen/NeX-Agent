import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWebServer, type WebServerHandle } from "../src/server/server.js";
import type { ServerMessage } from "../src/server/protocol.js";

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timeout menunggu pesan");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let provider: http.Server;
let handle: WebServerHandle;
let workspace: string;
let configHome: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nex-web-ws-"));
  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "nex-web-cfg-"));

  let turns = 0;
  provider = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      turns += 1;
      if (turns === 1) {
        res.write(
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "write_file" } },
                  ],
                },
              },
            ],
          }),
        );
        res.write(
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: JSON.stringify({ path: "web.txt", content: "ok\n" }) },
                    },
                  ],
                },
              },
            ],
          }),
        );
        res.write(chunk({ choices: [{ delta: {}, finish_reason: "tool_use" }] }));
      } else {
        res.write(chunk({ choices: [{ delta: { content: "selesai web" }, finish_reason: null }] }));
        res.write(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
  const providerPort = (provider.address() as AddressInfo).port;

  const providerKey = "custom:local";
  await fs.writeFile(
    path.join(configHome, "credentials.json"),
    JSON.stringify({
      [providerKey]: { apiKey: "test-key", baseURL: `http://127.0.0.1:${providerPort}/v1` },
    }),
  );
  await fs.writeFile(
    path.join(configHome, "config.json"),
    JSON.stringify({
      defaultProvider: providerKey,
      models: { [path.resolve(workspace)]: "local-model" },
    }),
  );

  previousConfigDir = process.env.AGENT_CONFIG_DIR;
  process.env.AGENT_CONFIG_DIR = configHome;

  handle = await createWebServer({ host: "127.0.0.1", port: 0, cwd: workspace, allowAll: true });
});

afterEach(async () => {
  await handle.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (previousConfigDir === undefined) delete process.env.AGENT_CONFIG_DIR;
  else process.env.AGENT_CONFIG_DIR = previousConfigDir;
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(configHome, { recursive: true, force: true });
});

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

async function connect(withToken = true, target: WebServerHandle = handle): Promise<Client> {
  const suffix = withToken ? `?token=${encodeURIComponent(target.token)}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}/ws${suffix}`);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, messages };
}

describe("web server", () => {
  it("mengirim state awal via WebSocket", async () => {
    const client = await connect();
    const ready = await waitFor(() => client.messages.find((m) => m.type === "ready"));
    if (ready.type !== "ready") throw new Error("bukan ready");
    expect(ready.state.workspace).toBe(path.resolve(workspace));
    expect(ready.state.model).toBe("local-model");
    expect(ready.state.provider).toBe("custom:local");
    expect(ready.state.mode).toBe("build");
    client.ws.close();
  });

  it("menerapkan opsi yang diteruskan /serve (model, provider, mode, allow-all)", async () => {
    const extra = await createWebServer({
      host: "127.0.0.1",
      port: 0,
      cwd: workspace,
      model: "other-model",
      provider: "custom:local",
      mode: "plan",
      allowAll: false,
    });
    try {
      const client = await connect(true, extra);
      const ready = await waitFor(() => client.messages.find((m) => m.type === "ready"));
      if (ready.type !== "ready") throw new Error("bukan ready");
      expect(ready.state.model).toBe("other-model");
      expect(ready.state.provider).toBe("custom:local");
      expect(ready.state.mode).toBe("plan");
      expect(ready.state.allowAll).toBe(false);
      client.ws.close();
    } finally {
      await extra.close();
    }
  });

  it("menolak koneksi tanpa token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("close", () => resolve("close"));
    });
    expect(outcome).not.toBe("open");
  });

  it("melindungi REST dengan token", async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`http://127.0.0.1:${handle.port}/api/state`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { workspace: string };
    expect(body.workspace).toBe(path.resolve(workspace));
  });

  it("menyajikan antarmuka web", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("NeX-Agent");
    expect(html).toContain("/assets/app.js");
  });

  it("menjalankan giliran chat lengkap (tool + streaming) dan menulis berkas", async () => {
    const client = await connect();
    await waitFor(() => client.messages.find((m) => m.type === "ready"));

    client.ws.send(JSON.stringify({ type: "chat.send", text: "buat berkas web.txt" }));

    await waitFor(() => client.messages.find((m) => m.type === "busy" && m.on === true));
    await waitFor(
      () => client.messages.find((m) => m.type === "busy" && m.on === false),
      20000,
    );

    const text = client.messages
      .filter((m): m is Extract<ServerMessage, { type: "text" }> => m.type === "text")
      .map((m) => m.chunk)
      .join("");
    expect(text).toContain("selesai web");
    expect(client.messages.some((m) => m.type === "stepStart")).toBe(true);
    expect(await fs.readFile(path.join(workspace, "web.txt"), "utf8")).toBe("ok\n");
    client.ws.close();
  });
});
