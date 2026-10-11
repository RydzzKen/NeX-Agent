import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TelegramDaemonError,
  isProcessAlive,
  restartTelegramDaemon,
  runTelegramSupervisor,
  startTelegramDaemon,
  stopTelegramDaemon,
  tailTelegramLog,
  telegramDaemonStatus,
  telegramLogPath,
  telegramPidPath,
  type SpawnFn,
} from "../src/server/telegram_daemon.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-telegram-daemon-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Child palsu yang bisa memicu event `exit`/`error` secara manual. */
class FakeChild extends EventEmitter {
  pid = 424242;
  unrefCalled = false;
  unref(): void {
    this.unrefCalled = true;
  }
  kill(): boolean {
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

describe("telegram daemon: pidfile & status", () => {
  it("menganggap proses sendiri hidup dan proses tak ada sebagai mati", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it("status false bila tidak ada pidfile", async () => {
    const dir = await makeDir();
    expect(await telegramDaemonStatus(dir)).toEqual({ running: false });
  });

  it("status true untuk pid hidup dan membersihkan pid mati", async () => {
    const dir = await makeDir();
    await fs.writeFile(telegramPidPath(dir), String(process.pid));
    expect(await telegramDaemonStatus(dir)).toEqual({ running: true, pid: process.pid });

    // pid besar yang tidak mungkin hidup
    await fs.writeFile(telegramPidPath(dir), "999999999");
    expect(await telegramDaemonStatus(dir)).toEqual({ running: false });
    await expect(fs.access(telegramPidPath(dir))).rejects.toThrow();
  });

  it("stop mengembalikan false bila tidak berjalan", async () => {
    const dir = await makeDir();
    expect(await stopTelegramDaemon({ dir, sleepFn: async () => undefined })).toBe(false);
  });
});

describe("telegram daemon: start/restart", () => {
  it("men-spawn supervisor detached dan menulis pidfile", async () => {
    const dir = await makeDir();
    let captured: { command: string; args: string[]; detached: boolean } | undefined;
    const child = new FakeChild();
    const spawnFn = ((command: string, args: string[], options: { detached?: boolean }) => {
      captured = { command, args, detached: Boolean(options.detached) };
      return child;
    }) as unknown as SpawnFn;

    const started = await startTelegramDaemon(["--cwd", "/tmp/ws"], {
      dir,
      execPath: "/usr/bin/node",
      entry: "/app/dist/index.js",
      spawnFn,
    });

    expect(started.pid).toBe(424242);
    expect(started.logFile).toBe(telegramLogPath(dir));
    expect(child.unrefCalled).toBe(true);
    expect(captured?.command).toBe("/usr/bin/node");
    expect(captured?.args).toEqual([
      "/app/dist/index.js",
      "telegram",
      "supervise",
      "--cwd",
      "/tmp/ws",
    ]);
    expect(captured?.detached).toBe(true);
    expect((await fs.readFile(telegramPidPath(dir), "utf8")).trim()).toBe("424242");
  });

  it("menolak start bila sudah berjalan (pid hidup)", async () => {
    const dir = await makeDir();
    await fs.writeFile(telegramPidPath(dir), String(process.pid));
    await expect(
      startTelegramDaemon([], { dir, spawnFn: (() => new FakeChild()) as unknown as SpawnFn }),
    ).rejects.toBeInstanceOf(TelegramDaemonError);
  });

  it("restart menghentikan lalu menjalankan ulang", async () => {
    const dir = await makeDir();
    const child = new FakeChild();
    const spawnFn = (() => child) as unknown as SpawnFn;
    // pidfile menunjuk proses mati → stop tidak menghalangi start.
    await fs.writeFile(telegramPidPath(dir), "999999999");
    const started = await restartTelegramDaemon([], {
      dir,
      spawnFn,
      sleepFn: async () => undefined,
    });
    expect(started.pid).toBe(424242);
  });
});

describe("telegram daemon: log", () => {
  it("mengembalikan baris terakhir log", async () => {
    const dir = await makeDir();
    await fs.writeFile(telegramLogPath(dir), "a\nb\nc\n");
    expect(await tailTelegramLog(2, dir)).toEqual(["b", "c"]);
  });

  it("mengembalikan array kosong bila belum ada log", async () => {
    const dir = await makeDir();
    expect(await tailTelegramLog(5, dir)).toEqual([]);
  });
});

describe("telegram supervisor", () => {
  function makeSpawn(): { spawnFn: SpawnFn; children: FakeChild[] } {
    const children: FakeChild[] = [];
    const spawnFn = (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as SpawnFn;
    return { spawnFn, children };
  }

  it("me-restart worker setelah keluar tak terduga", async () => {
    const { spawnFn, children } = makeSpawn();
    const supervisor = runTelegramSupervisor({
      execPath: "/usr/bin/node",
      entry: "/app/dist/index.js",
      args: ["telegram", "run"],
      spawnFn,
      baseDelayMs: 1,
      maxDelayMs: 2,
      healthyMs: 1,
    });
    expect(children).toHaveLength(1);
    children[0]?.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children.length).toBeGreaterThanOrEqual(2);
    supervisor.stop();
    await expect(supervisor.done).resolves.toBe(0);
  });

  it("berhenti total (tanpa restart) saat worker keluar dengan kode 2", async () => {
    const { spawnFn, children } = makeSpawn();
    const supervisor = runTelegramSupervisor({
      execPath: "/usr/bin/node",
      entry: "/app/dist/index.js",
      args: ["telegram", "run"],
      spawnFn,
      baseDelayMs: 1,
    });
    children[0]?.emit("exit", 2);
    await expect(supervisor.done).resolves.toBe(2);
    expect(children).toHaveLength(1);
  });

  it("stop meneruskan SIGTERM ke worker dan menyelesaikan done", async () => {
    const { spawnFn, children } = makeSpawn();
    const supervisor = runTelegramSupervisor({
      execPath: "/usr/bin/node",
      entry: "/app/dist/index.js",
      args: ["telegram", "run"],
      spawnFn,
    });
    supervisor.stop();
    await expect(supervisor.done).resolves.toBe(0);
    expect(children).toHaveLength(1);
  });
});
