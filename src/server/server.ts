import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { extractToken, generateToken, tokenMatches } from "./auth.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";
import { WebApp, type WebAppOptions } from "./webapp.js";
import { TerminalManager, describeBackend } from "./terminal.js";

export interface WebServerOptions extends WebAppOptions {
  host?: string;
  /** 0 = port acak (ephemeral). */
  port?: number;
  token?: string;
  webRoot?: string;
}

export interface WebServerHandle {
  url: string;
  /** Semua URL yang bisa dibuka (loopback + alamat LAN bila terikat ke jaringan). */
  urls: string[];
  token: string;
  host: string;
  port: number;
  backend: string;
  close(): Promise<void>;
}

/** Host yang hanya bisa dijangkau dari mesin yang sama. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Alamat IPv4 non-loopback pada mesin ini (untuk URL yang bisa dibuka dari LAN). */
export function lanAddresses(): string[] {
  const found = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) found.add(info.address);
    }
  }
  return [...found];
}

/** Susun daftar URL yang dapat dibuka untuk host/port yang diberikan. */
export function buildUrls(host: string, port: number, token: string): string[] {
  const make = (h: string): string => {
    const shown = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
    return `http://${shown}:${port}/#t=${token}`;
  };
  if (isLoopbackHost(host)) return [make(host === "localhost" ? "127.0.0.1" : host)];
  if (host === "0.0.0.0" || host === "::") {
    // Terikat ke semua antarmuka: loopback + setiap alamat LAN.
    return [make("127.0.0.1"), ...lanAddresses().map(make)];
  }
  return [make(host)];
}

/** URL pertama yang bisa dibuka dari perangkat lain (bila ada). */
export function reachableUrl(urls: string[]): string | undefined {
  return urls.find((u) => {
    try {
      const { hostname } = new URL(u);
      return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
    } catch {
      return false;
    }
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const require = createRequire(import.meta.url);

/** Lokasi aset web: `dist/web` saat terpasang, atau `web/` saat dev. */
export function findWebRoot(explicit?: string): string {
  if (explicit && fs.existsSync(path.join(explicit, "index.html"))) return explicit;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "web"),
    path.join(here, "..", "web"),
    path.join(process.cwd(), "dist", "web"),
    path.join(process.cwd(), "web"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}

function safeJoin(root: string, relative: string): string | undefined {
  const full = path.resolve(root, `.${relative}`);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return undefined;
  return full;
}

/** Aset vendor dari node_modules (dipakai saat dev sebelum `dist/web` dibangun). */
function resolveVendor(relative: string): string | undefined {
  const map: Record<string, string> = {
    "xterm.js": "@xterm/xterm/lib/xterm.js",
    "xterm.css": "@xterm/xterm/css/xterm.css",
    "addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
  };
  const target = map[path.basename(relative)];
  if (!target) return undefined;
  try {
    return require.resolve(target);
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function serveFile(res: http.ServerResponse, full: string): Promise<void> {
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      "content-type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { app: WebApp; token: string; webRoot: string },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    const provided = extractToken(req.headers.authorization, url);
    if (!tokenMatches(ctx.token, provided)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await ctx.app.state()));
      return;
    }
    if (url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await ctx.app.listSessions()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const relative = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = safeJoin(ctx.webRoot, relative);
  if (full && fs.existsSync(full)) {
    await serveFile(res, full);
    return;
  }
  if (url.pathname.startsWith("/assets/vendor/")) {
    const vendor = resolveVendor(url.pathname);
    if (vendor && fs.existsSync(vendor)) {
      await serveFile(res, vendor);
      return;
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

async function handleClientMessage(
  raw: string,
  ws: WebSocket,
  app: WebApp,
  terminals: TerminalManager,
): Promise<void> {
  const msg = parseClientMessage(raw);
  if (!msg) {
    send(ws, { type: "warn", message: "Pesan tidak valid." });
    return;
  }

  switch (msg.type) {
    case "chat.send":
      await app.send(msg.text);
      return;
    case "chat.interrupt":
      app.interrupt();
      return;
    case "approval.resolve":
      app.resolveApproval(msg.id, msg.decision);
      return;
    case "path.resolve":
      app.resolveApproval(msg.id, msg.allow);
      return;
    case "sensitive.resolve":
      app.resolveApproval(msg.id, msg.allow);
      return;
    case "session.new":
      await app.newSession();
      return;
    case "session.open":
      if (!(await app.openSession(msg.id))) {
        send(ws, { type: "warn", message: `Sesi tidak ditemukan: ${msg.id}` });
      }
      return;
    case "session.delete":
      await app.deleteSession(msg.id);
      return;
    case "session.rename":
      await app.renameSession(msg.id, msg.title.trim());
      return;
    case "mode.set":
      app.setMode(msg.mode);
      return;
    case "allowAll.set":
      app.setAllowAll(msg.on);
      return;
    case "state.request":
      send(ws, { type: "state", state: await app.state() });
      return;
    case "terminal.open": {
      const result = terminals.open(msg.id, msg.cols, msg.rows);
      if (result.buffer) send(ws, { type: "terminal.data", id: msg.id, data: result.buffer });
      send(ws, {
        type: "terminal.list",
        items: terminals.list().map((t) => ({ id: t.id, running: t.running })),
      });
      return;
    }
    case "terminal.input":
      terminals.write(msg.id, msg.data);
      return;
    case "terminal.resize":
      terminals.resize(msg.id, msg.cols, msg.rows);
      return;
    case "terminal.close":
      terminals.close(msg.id);
      send(ws, {
        type: "terminal.list",
        items: terminals.list().map((t) => ({ id: t.id, running: t.running })),
      });
      return;
  }
}

/** Bangun dan mulai server web (HTTP + WebSocket). */
export async function createWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const token = opts.token ?? generateToken();
  const host = opts.host ?? "127.0.0.1";
  const webRoot = findWebRoot(opts.webRoot);

  const clients = new Set<WebSocket>();
  const broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch {
          // klien mati; akan dibersihkan oleh handler 'close'
        }
      }
    }
  };

  const app = await WebApp.create(opts, broadcast);
  const terminals = new TerminalManager({
    cwd: () => app.workspaceRoot,
    onData: (id, data) => broadcast({ type: "terminal.data", id, data }),
    onExit: (id, code) => broadcast({ type: "terminal.exit", id, code }),
  });

  const server = http.createServer((req, res) => {
    void handleHttp(req, res, { app, token, webRoot });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const provided = extractToken(req.headers.authorization, url);
    if (!tokenMatches(token, provided)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    void (async () => {
      send(ws, { type: "ready", state: await app.state() });
      send(ws, {
        type: "terminal.list",
        items: terminals.list().map((t) => ({ id: t.id, running: t.running })),
      });
    })();
    ws.on("message", (raw: Buffer | string) => {
      void handleClientMessage(raw.toString(), ws, app, terminals);
    });
    ws.on("close", () => {
      clients.delete(ws);
      if (clients.size === 0) app.cancelPendingApprovals();
    });
    ws.on("error", () => clients.delete(ws));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Tidak bisa menentukan port server."));
    });
  });

  const urls = buildUrls(host, port, token);

  return {
    url: urls[0]!,
    urls,
    token,
    host,
    port,
    backend: describeBackend(terminals.backendName() as Parameters<typeof describeBackend>[0]),
    async close() {
      terminals.killAll();
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // abaikan
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}
