import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/loop.js";
import { Approvals } from "../src/core/approvals.js";
import { CheckpointManager } from "../src/core/checkpoint.js";
import { silentIO } from "../src/core/io.js";
import { nullLogger } from "../src/logging/logger.js";
import { OpenAICompatibleProvider } from "../src/providers/openai.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { UsageTracker } from "../src/usage/tracker.js";

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

let server: http.Server;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-e2e-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });

  let turns = 0;
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        void body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (turns++ === 0) {
          res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file" } }] } }] }));
          res.write(
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: JSON.stringify({ path: "hello.txt", content: "hi\n" }) } },
                    ],
                  },
                },
              ],
            }),
          );
          res.write(chunk({ choices: [{ finish_reason: "tool_calls" }] }));
          res.write(chunk({ usage: { prompt_tokens: 5, completion_tokens: 2 } }));
        } else {
          res.write(chunk({ choices: [{ delta: { content: "selesai" } }] }));
          res.write(chunk({ choices: [{ finish_reason: "stop" }] }));
          res.write(chunk({ usage: { prompt_tokens: 8, completion_tokens: 1 } }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

describe("integrasi end-to-end (HTTP + loop + tool)", () => {
  it("menjalankan tool write_file dari provider HTTP dan menulis file", async () => {
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAICompatibleProvider({
      id: "local",
      label: "Local",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toContain("local-model");

    const workspace = createWorkspace(root);
    const permissions = new PermissionManager(workspace.root);
    const io = silentIO("yes");
    const approvals = new Approvals(io, { yes: true, interactive: false });
    const tracker = new UsageTracker();
    const checkpoints = await CheckpointManager.load(path.join(root, ".state"));

    const session = new AgentSession(
      {
        provider,
        providerId: "local",
        registry: new ToolRegistry(),
        io,
        approvals,
        logger: nullLogger,
        checkpoints,
        workspace,
        permissions,
        systemPrompt: "test",
        resolvePath: createPathResolver({ workspace, permissions, approvals, getMode: () => "build" }),
        tracker,
        sleep: async () => {},
      },
      { model: "local-model", mode: "build", retries: 0 },
    );

    const result = await session.run("buat hello.txt", new AbortController().signal);
    expect(result.stopReason).toBe("stop");
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi\n");
  });
});
