import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/server/protocol.js";
import { parseClientMessage } from "../src/server/protocol.js";
import { extractToken, generateToken, tokenMatches } from "../src/server/auth.js";
import { WebIO } from "../src/server/webio.js";
import { buildSpawnSpec, TerminalManager } from "../src/server/terminal.js";

describe("protokol", () => {
  it("menerima pesan valid", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi" }))).toEqual({
      type: "chat.send",
      text: "hi",
    });
    expect(parseClientMessage(JSON.stringify({ type: "mode.set", mode: "plan" }))).toBeDefined();
    expect(parseClientMessage(JSON.stringify({ type: "terminal.input", id: "a", data: "x" }))).toBeDefined();
  });

  it("menolak pesan tidak valid", () => {
    expect(parseClientMessage("bukan json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "terminal.open", id: "a", cols: 1, rows: 1 }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeUndefined();
  });
});

describe("auth", () => {
  it("membuat token acak yang kuat", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("membandingkan token dengan aman", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", undefined)).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });

  it("mengambil token dari query / header", () => {
    expect(extractToken(undefined, new URL("http://x/ws?token=abc"))).toBe("abc");
    expect(extractToken("Bearer def", new URL("http://x/ws"))).toBe("def");
    expect(extractToken(undefined, new URL("http://x/ws"))).toBeUndefined();
  });
});

describe("terminal", () => {
  const base = { shell: "/bin/bash", cols: 80, rows: 24, cwd: "/tmp", env: {} };

  it("menyusun spawn util-linux", () => {
    const spec = buildSpawnSpec("util-linux", base);
    expect(spec.command).toBe("script");
    expect(spec.args[0]).toBe("-qfc");
    expect(spec.args[1]).toContain("stty rows 24 cols 80");
    expect(spec.args[1]).toContain("/bin/bash");
    expect(spec.args[2]).toBe("/dev/null");
    expect(spec.env.COLUMNS).toBe("80");
  });

  it("menyusun spawn bsd", () => {
    const spec = buildSpawnSpec("bsd", base);
    expect(spec.args.slice(0, 4)).toEqual(["-q", "/dev/null", "/bin/sh", "-c"]);
    expect(spec.args[4]).toContain("stty rows 24 cols 80");
  });

  it("menyusun spawn busybox dan pipe", () => {
    expect(buildSpawnSpec("busybox", base).args).toEqual(["/dev/null"]);
    const none = buildSpawnSpec("none", base);
    expect(none.command).toBe("/bin/bash");
    expect(none.args).toEqual(["-i"]);
  });

  class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 4242;
    written: string[] = [];
    stdin = {
      write: (data: string): boolean => {
        this.written.push(data);
        return true;
      },
    };
    kill(): boolean {
      this.emit("exit", 0);
      return true;
    }
  }

  it("mengelola siklus hidup terminal dan replay buffer", () => {
    const child = new FakeChild();
    const data: Array<{ id: string; value: string }> = [];
    const exits: Array<number | null> = [];
    const manager = new TerminalManager({
      cwd: "/tmp",
      style: "none",
      spawnFn: () => child as unknown as ChildProcess,
      onData: (id, value) => data.push({ id, value }),
      onExit: (_id, code) => exits.push(code),
    });

    expect(manager.open("t1", 80, 24).created).toBe(true);
    child.stdout.emit("data", Buffer.from("hello\n"));
    expect(data).toEqual([{ id: "t1", value: "hello\n" }]);

    expect(manager.write("t1", "echo hi\n")).toBe(true);
    expect(child.written).toEqual(["echo hi\n"]);

    const again = manager.open("t1", 100, 30);
    expect(again.created).toBe(false);
    expect(again.buffer).toContain("hello");

    child.emit("exit", 0);
    expect(exits).toEqual([0]);
    expect(manager.list()[0]!.running).toBe(false);
    expect(manager.has("t1")).toBe(false);

    manager.close("t1");
    expect(manager.list()).toEqual([]);
    expect(manager.write("t1", "x")).toBe(false);
  });
});

import { buildUrls, isLoopbackHost, lanAddresses, reachableUrl } from "../src/server/server.js";
import { renderQr } from "../src/util/qr.js";

describe("URL server & QR", () => {
  it("mengenali host loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });

  it("menyusun URL untuk loopback dan host spesifik", () => {
    expect(buildUrls("127.0.0.1", 8080, "tok")).toEqual(["http://127.0.0.1:8080/#t=tok"]);
    expect(buildUrls("localhost", 8080, "tok")).toEqual(["http://127.0.0.1:8080/#t=tok"]);
    expect(buildUrls("192.168.1.5", 8080, "tok")).toEqual(["http://192.168.1.5:8080/#t=tok"]);
  });

  it("menyertakan loopback + alamat LAN saat bind 0.0.0.0", () => {
    const urls = buildUrls("0.0.0.0", 4170, "tok");
    expect(urls[0]).toBe("http://127.0.0.1:4170/#t=tok");
    expect(urls.every((u) => u.includes("#t=tok"))).toBe(true);
    expect(urls.length).toBeGreaterThanOrEqual(1);
  });

  it("memilih URL yang bisa dijangkau dari LAN", () => {
    const urls = ["http://127.0.0.1:1/#t=t", "http://192.168.1.5:1/#t=t"];
    expect(reachableUrl(urls)).toBe("http://192.168.1.5:1/#t=t");
    expect(reachableUrl(["http://127.0.0.1:1/#t=t", "http://localhost:1/#t=t"])).toBeUndefined();
  });

  it("mengembalikan daftar alamat LAN (tanpa loopback)", () => {
    const addrs = lanAddresses();
    expect(Array.isArray(addrs)).toBe(true);
    expect(addrs.every((a) => !a.startsWith("127."))).toBe(true);
  });

  it("merender URL menjadi kode QR terminal", () => {
    const qr = renderQr("http://192.168.1.5:4170/#t=token");
    expect(qr.length).toBeGreaterThan(0);
    expect(qr).toMatch(/[▀▄█]/);
    expect(qr.split("\n").length).toBeGreaterThan(3);
  });
});

describe("WebIO", () => {
  it("meneruskan peristiwa ke sink", () => {
    const sent: ServerMessage[] = [];
    const io = new WebIO((m) => sent.push(m));
    io.text("hi");
    io.thinking("hmm");
    io.stepStart({ index: 1, total: 2, name: "read_file", argsSummary: "a", risk: "read" });
    expect(sent[0]).toEqual({ type: "text", chunk: "hi" });
    expect(sent[1]).toEqual({ type: "thinking", chunk: "hmm" });
    expect(sent[2]!.type).toBe("stepStart");
  });

  it("menunggu jawaban approval lalu resolve", async () => {
    const sent: ServerMessage[] = [];
    const io = new WebIO((m) => sent.push(m));
    const promise = io.confirm({ kind: "shell", title: "t", detail: "d" });
    const message = sent[0]!;
    expect(message.type).toBe("confirm");
    if (message.type !== "confirm") throw new Error("bukan confirm");
    expect(io.resolve(message.id, "yes")).toBe(true);
    await expect(promise).resolves.toBe("yes");
    expect(io.resolve(message.id, "no")).toBe(false);
  });

  it("menolak semua permintaan yang menggantung", async () => {
    const sent: ServerMessage[] = [];
    const io = new WebIO((m) => sent.push(m));
    const pathPromise = io.requestPathAccess({ path: "/x", access: "read", outsideWorkspace: true });
    const sensitivePromise = io.requestSensitiveAccess({ kind: "path", detail: "/x/.env", reason: "r" });
    expect(sent.map((m) => m.type)).toEqual(["pathAccess", "sensitiveAccess"]);
    io.cancelAll();
    await expect(pathPromise).resolves.toBe(false);
    await expect(sensitivePromise).resolves.toBe(false);
  });
});
