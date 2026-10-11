import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CommandResult,
  type CommandRunner,
  describeUpdate,
  describeUpdateAvailable,
  describeUpdateSuccess,
  isOwnedLauncher,
  resolveSourceDir,
  runUninstall,
  runUpdate,
  stripRcMarker,
} from "../src/cli/update.js";

type Handlers = Record<string, CommandResult | ((cmd: string, args: string[]) => CommandResult)>;

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function fakeRunner(handlers: Handlers): CommandRunner {
  return {
    async run(cmd, args) {
      const key = [cmd, ...args].join(" ");
      const handler = handlers[key];
      if (!handler) throw new Error(`perintah tak terduga: ${key}`);
      return typeof handler === "function" ? handler(cmd, args) : handler;
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-update-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makeSource(version = "1.2.3"): Promise<string> {
  const dir = path.join(root, "src");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "nex-agent", version }));
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("resolveSourceDir", () => {
  it("menemukan root paket dari lokasi berkas build", async () => {
    const dir = await makeSource();
    const url = pathToFileURL(path.join(dir, "dist", "index.js")).href;
    expect(resolveSourceDir(url)).toBe(dir);
  });

  it("menemukan root paket dari sumber bersarang (src/cli)", async () => {
    const dir = await makeSource();
    const url = pathToFileURL(path.join(dir, "src", "cli", "update.ts")).href;
    expect(resolveSourceDir(url)).toBe(dir);
  });
});

describe("stripRcMarker", () => {
  it("menghapus blok penanda PATH", () => {
    const text = [
      "export FOO=1",
      "# >>> nex-agent >>>",
      'export PATH="$HOME/.local/bin:$PATH"',
      "# <<< nex-agent <<<",
      "export BAR=2",
      "",
    ].join("\n");
    const out = stripRcMarker(text);
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain("nex-agent");
    expect(out.text).toContain("export FOO=1");
    expect(out.text).toContain("export BAR=2");
  });

  it("tidak mengubah apa pun bila penanda tidak ada", () => {
    const text = "export FOO=1\n";
    const out = stripRcMarker(text);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });
});

describe("isOwnedLauncher", () => {
  it("mengenali launcher yang menunjuk dist/index.js milik sumber", () => {
    const src = "/opt/nex-agent";
    const content = `#!/usr/bin/env bash\nexec node "${src}/dist/index.js" "$@"\n`;
    expect(isOwnedLauncher(content, src)).toBe(true);
    expect(isOwnedLauncher("#!/bin/sh\nexec node /other/dist/index.js\n", src)).toBe(false);
  });
});

describe("runUpdate", () => {
  it("melaporkan no-git bila sumber bukan checkout git", async () => {
    const dir = path.join(root, "nogit");
    await fs.mkdir(dir, { recursive: true });
    const outcome = await runUpdate({ cwd: dir, runner: fakeRunner({}) });
    expect(outcome.status).toBe("no-git");
  });

  it("mengatakan sudah versi terbaru bila revisi lokal sama dengan remote", async () => {
    const dir = await makeSource("2.0.0");
    const runner = fakeRunner({
      "git rev-parse --abbrev-ref HEAD": ok("main\n"),
      "git fetch origin main": ok(),
      "git rev-parse HEAD": ok("abc1234def\n"),
      "git rev-parse FETCH_HEAD": ok("abc1234def\n"),
    });
    const outcome = await runUpdate({ cwd: dir, runner });
    expect(outcome.status).toBe("latest");
    expect(outcome.version).toBe("2.0.0");
    expect(describeUpdate(outcome)).toContain("Sudah versi terbaru");
  });

  it("menarik, memasang, dan membangun ulang saat ada revisi baru", async () => {
    const dir = await makeSource("2.1.0");
    const seen: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        const key = [cmd, ...args].join(" ");
        seen.push(key);
        const table: Record<string, CommandResult> = {
          "git rev-parse --abbrev-ref HEAD": ok("main\n"),
          "git fetch origin main": ok(),
          "git rev-parse HEAD": ok("aaaaaaa\n"),
          "git rev-parse FETCH_HEAD": ok("bbbbbbb\n"),
          "git rev-list --count HEAD..bbbbbbb": ok("2\n"),
          "git status --porcelain": ok(""),
          "git merge --ff-only bbbbbbb": ok(),
          "pnpm -v": ok("10.0.0\n"),
          "pnpm install --frozen-lockfile": ok(),
          "pnpm build": ok(),
        };
        const handler = table[key];
        if (!handler) throw new Error(`perintah tak terduga: ${key}`);
        return handler;
      },
    };
    const outcome = await runUpdate({ cwd: dir, runner });
    expect(outcome.status).toBe("updated");
    expect(outcome.version).toBe("2.1.0");
    expect(seen).toContain("git merge --ff-only bbbbbbb");
    expect(seen).toContain("pnpm build");
    expect(describeUpdate(outcome)).toContain("Berhasil diperbarui");
  });

  it("mengatakan sudah terbaru bila lokal lebih baru dari remote (tidak ada yang ditarik)", async () => {
    const dir = await makeSource();
    const runner = fakeRunner({
      "git rev-parse --abbrev-ref HEAD": ok("main\n"),
      "git fetch origin main": ok(),
      "git rev-parse HEAD": ok("bbbbbbb\n"),
      "git rev-parse FETCH_HEAD": ok("aaaaaaa\n"),
      "git rev-list --count HEAD..aaaaaaa": ok("0\n"),
    });
    const outcome = await runUpdate({ cwd: dir, runner });
    expect(outcome.status).toBe("latest");
  });

  it("--check hanya melaporkan ketersediaan tanpa menerapkan", async () => {
    const dir = await makeSource();
    let merged = false;
    const runner: CommandRunner = {
      async run(cmd, args) {
        const key = [cmd, ...args].join(" ");
        if (key === "git merge --ff-only bbbbbbb") merged = true;
        const table: Record<string, CommandResult> = {
          "git rev-parse --abbrev-ref HEAD": ok("main\n"),
          "git fetch origin main": ok(),
          "git rev-parse HEAD": ok("aaaaaaa\n"),
          "git rev-parse FETCH_HEAD": ok("bbbbbbb\n"),
          "git rev-list --count HEAD..bbbbbbb": ok("1\n"),
          "git show bbbbbbb:package.json": ok('{"version":"9.9.9"}'),
        };
        const handler = table[key];
        if (!handler) throw new Error(`perintah tak terduga: ${key}`);
        return handler;
      },
    };
    const outcome = await runUpdate({ cwd: dir, check: true, runner });
    expect(outcome.status).toBe("available");
    expect(outcome.nextVersion).toBe("9.9.9");
    expect(merged).toBe(false);
  });

  it("membatalkan update bila ada perubahan lokal", async () => {
    const dir = await makeSource();
    const runner = fakeRunner({
      "git rev-parse --abbrev-ref HEAD": ok("main\n"),
      "git fetch origin main": ok(),
      "git rev-parse HEAD": ok("aaaaaaa\n"),
      "git rev-parse FETCH_HEAD": ok("bbbbbbb\n"),
      "git rev-list --count HEAD..bbbbbbb": ok("1\n"),
      "git status --porcelain": ok(" M src/index.ts\n"),
    });
    const outcome = await runUpdate({ cwd: dir, runner });
    expect(outcome.status).toBe("dirty");
  });

  it("gagal dengan pesan bila git fetch error", async () => {
    const dir = await makeSource();
    const runner = fakeRunner({
      "git rev-parse --abbrev-ref HEAD": ok("main\n"),
      "git fetch origin main": { code: 1, stdout: "", stderr: "tidak ada jaringan\n" },
    });
    const outcome = await runUpdate({ cwd: dir, runner });
    expect(outcome.status).toBe("error");
    expect(outcome.message).toContain("tidak ada jaringan");
  });
});

describe("formatter pesan update", () => {
  it("menyusun prompt pembaruan dengan versi lama dan baru", () => {
    const text = describeUpdateAvailable({
      status: "available",
      version: "1.0.5",
      nextVersion: "1.0.6",
      from: "aaaaaaa",
      to: "bbbbbbb",
    });
    expect(text).toBe("Versi Terbaru tersedia: sekarang v1.0.5 → terbaru v1.0.6");
  });

  it("menyusun pesan sukses dengan versi baru dan saran restart", () => {
    const text = describeUpdateSuccess({ status: "updated", version: "1.0.6" });
    expect(text).toBe("Ter-update ke v1.0.6. Jalankan '/restart' untuk menerapkan.");
  });
});

describe("runUninstall", () => {
  it("menghapus launcher milik sumber dan membersihkan penanda PATH", async () => {
    const src = await makeSource();
    const home = path.join(root, "home");
    const bin = path.join(home, ".local", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(src, "dist"), { recursive: true });
    await fs.writeFile(path.join(src, "dist", "index.js"), "// build");

    // launcher symlink + launcher skrip
    await fs.symlink(path.join(src, "dist", "index.js"), path.join(bin, "agent"));
    await fs.writeFile(
      path.join(bin, "nex-agent"),
      `#!/usr/bin/env bash\nexec node "${path.join(src, "dist", "index.js")}" "$@"\n`,
    );
    // launcher asing yang tidak boleh dihapus
    await fs.writeFile(path.join(bin, "other"), "#!/bin/sh\necho lain\n");

    const rc = path.join(home, ".bashrc");
    await fs.writeFile(
      rc,
      ["export FOO=1", "# >>> nex-agent >>>", `export PATH="${bin}:$PATH"`, "# <<< nex-agent <<<", ""].join("\n"),
    );

    const result = await runUninstall({ dir: src, home, binDirs: [bin] });

    expect(result.removedCommands.sort()).toEqual(
      [path.join(bin, "agent"), path.join(bin, "nex-agent")].sort(),
    );
    await expect(fs.access(path.join(bin, "agent"))).rejects.toThrow();
    await expect(fs.access(path.join(bin, "nex-agent"))).rejects.toThrow();
    await expect(fs.access(path.join(bin, "other"))).resolves.toBeUndefined();
    expect(result.removedRcMarkers).toEqual([rc]);
    const rcText = await fs.readFile(rc, "utf8");
    expect(rcText).not.toContain("nex-agent");
    expect(rcText).toContain("export FOO=1");
  });

  it("tidak menghapus apa pun bila tidak ada launcher milik sumber", async () => {
    const src = await makeSource();
    const home = path.join(root, "home2");
    const bin = path.join(home, ".local", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "agent"), "#!/bin/sh\necho halo\n");
    const result = await runUninstall({ dir: src, home, binDirs: [bin] });
    expect(result.removedCommands).toHaveLength(0);
    await expect(fs.access(path.join(bin, "agent"))).resolves.toBeUndefined();
  });
});
