import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO, type AgentIO, type SecretRequest } from "../src/core/io.js";
import { TerminalIO } from "../src/cli/render.js";
import { PROMPT_EOF, type PrompterLike } from "../src/cli/prompt.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { TodoStore } from "../src/core/todos.js";
import type { ToolContext } from "../src/tools/types.js";
import {
  isSudoCommand,
  runShellTool,
  sudoNeedsPassword,
  withSudoNonInteractive,
  withSudoStdin,
} from "../src/tools/run_shell.js";

const PASSWORD = "rahasia";

let root: string;
let binDir: string;
let savedPath: string | undefined;

/** sudo tiruan: gagal "tanpa TTY" kecuali dipanggil dengan `-S` + password benar. */
const FAKE_SUDO = `#!/bin/sh
if [ -n "$SUDO_LOG" ]; then printf '%s\n' "$*" >> "$SUDO_LOG"; fi
has_s=0; has_n=0
for a in "$@"; do
  [ "$a" = "-S" ] && has_s=1
  [ "$a" = "-n" ] && has_n=1
done
if [ "$has_s" = "1" ]; then
  IFS= read -r pw
  if [ "$pw" = "${PASSWORD}" ]; then exit 0; fi
  echo "sudo: 1 incorrect password attempt" >&2
  exit 1
fi
if [ "$has_n" = "1" ]; then
  echo "sudo: a password is required" >&2
  exit 1
fi
echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
echo "sudo: a password is required" >&2
exit 1
`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-sudo-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-sudo-bin-"));
  const sudoPath = path.join(binDir, "sudo");
  await fs.writeFile(sudoPath, FAKE_SUDO, "utf8");
  await fs.chmod(sudoPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(binDir, { recursive: true, force: true });
});

function makeContext(requestSecret: ToolContext["requestSecret"]): ToolContext {
  const workspace = createWorkspace(root);
  const permissions = new PermissionManager(workspace.root);
  const io: AgentIO = { ...silentIO("yes") };
  const approvals = new Approvals(io, { yes: true, interactive: true });
  const resolvePath = createPathResolver({
    workspace,
    permissions,
    approvals,
    getMode: () => "build",
  });
  return {
    workspace,
    permissions,
    mode: "build",
    signal: new AbortController().signal,
    logger: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    todos: new TodoStore(),
    resolvePath,
    confirm: (req, opts) => approvals.confirm(req, opts),
    confirmSensitive: (req) => approvals.requestSensitiveAccess(req),
    requestSecret,
  };
}

describe("helper sudo", () => {
  it("mengenali perintah sudo tanpa tertipu sudoedit", () => {
    expect(isSudoCommand("sudo apt install x")).toBe(true);
    expect(isSudoCommand("   sudo -k ls")).toBe(true);
    expect(isSudoCommand("sudoedit /etc/hosts")).toBe(false);
    expect(isSudoCommand("echo sudo")).toBe(false);
  });

  it("hanya menandai sudo yang gagal karena tidak ada TTY", () => {
    expect(sudoNeedsPassword("sudo ls", "sudo: a terminal is required to read the password")).toBe(true);
    expect(sudoNeedsPassword("sudo ls", "sudo: no tty present and no askpass program specified")).toBe(true);
    expect(sudoNeedsPassword("sudo ls", "sudo: a password is required")).toBe(true);
    expect(sudoNeedsPassword("ls", "a terminal is required")).toBe(false);
    expect(sudoNeedsPassword("sudo ls", "permission denied")).toBe(false);
  });

  it("menyisipkan -S -k pada sudo terdepan saja", () => {
    expect(withSudoStdin("sudo apt install x")).toBe("sudo -S -k apt install x");
    expect(withSudoStdin("  sudo ls")).toBe("  sudo -S -k ls");
    expect(withSudoStdin("sudoedit /etc/hosts")).toBe("sudoedit /etc/hosts");
    expect(withSudoStdin("echo sudo")).toBe("echo sudo");
  });

  it("membuang -n saat menyiapkan retry agar sudo membaca password", () => {
    expect(withSudoStdin("sudo -n id")).toBe("sudo -S -k id");
    expect(withSudoStdin("sudo -n id 2>&1 || echo x")).toBe("sudo -S -k id 2>&1 || echo x");
  });

  it("menyisipkan -n pada sudo terdepan saja (tanpa menggantung di TTY)", () => {
    expect(withSudoNonInteractive("sudo whoami")).toBe("sudo -n whoami");
    expect(withSudoNonInteractive("  sudo ls")).toBe("  sudo -n ls");
    expect(withSudoNonInteractive("sudoedit /etc/hosts")).toBe("sudoedit /etc/hosts");
    expect(withSudoNonInteractive("echo sudo")).toBe("echo sudo");
  });
});

describe("run_shell + sudo", () => {
  it("minta password sesaat lalu jalankan ulang lewat stdin", async () => {
    const spy = vi.fn(async (_req: SecretRequest) => PASSWORD);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "sudo true" }, ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ kind: "sudo", detail: "sudo true" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("exit code: 0");
    // Rahasia tidak boleh bocor ke hasil yang dikirim ke model.
    expect(result.content).not.toContain(PASSWORD);
    expect(result.summary ?? "").not.toContain(PASSWORD);
  });

  it("percobaan pertama non-interaktif (-n), lalu jalankan ulang dengan -S", async () => {
    const log = path.join(root, "sudo.log");
    process.env.SUDO_LOG = log;
    try {
      const ctx = makeContext(async () => PASSWORD);
      const result = await runShellTool.execute({ command: "sudo whoami" }, ctx);

      expect(result.ok).toBe(true);
      const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(lines[0]).toBe("-n whoami");
      expect(lines[1]).toBe("-S -k whoami");
    } finally {
      delete process.env.SUDO_LOG;
    }
  });

  it("tetap minta password walau model pakai `-n`, `2>&1`, dan `|| echo`", async () => {
    const log = path.join(root, "sudo.log");
    process.env.SUDO_LOG = log;
    try {
      const spy = vi.fn(async () => PASSWORD);
      const ctx = makeContext(spy);

      const result = await runShellTool.execute(
        { command: "sudo -n id 2>&1 || echo fallback" },
        ctx,
      );

      expect(spy).toHaveBeenCalledTimes(1);
      const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
      // Probe kita menambah -n (jadi -n -n id); retry memakai -S -k tanpa -n.
      expect(lines[0]).toBe("-n -n id");
      expect(lines[1]).toBe("-S -k id");
      expect(result.ok).toBe(true);
      expect(result.content).not.toContain(PASSWORD);
    } finally {
      delete process.env.SUDO_LOG;
    }
  });

  it("batal saat pengguna tidak memberi password", async () => {
    const spy = vi.fn(async () => null);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "sudo true" }, ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Dibatalkan");
    expect(result.summary).toBe("sudo dibatalkan");
  });

  it("tidak pernah minta password untuk perintah non-sudo", async () => {
    const spy = vi.fn(async () => PASSWORD);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "false" }, ctx);

    expect(spy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe("Approvals.requestSecret", () => {
  it("non-interaktif selalu null tanpa memanggil IO", async () => {
    const requestSecret = vi.fn(async () => PASSWORD);
    const approve = new Approvals({ ...silentIO("yes"), requestSecret }, { yes: true, interactive: false });
    expect(await approve.requestSecret({ kind: "sudo", detail: "sudo true", reason: "x" })).toBeNull();
    expect(requestSecret).not.toHaveBeenCalled();
  });

  it("interaktif meneruskan ke IO meski allow-all aktif", async () => {
    const requestSecret = vi.fn(async () => PASSWORD);
    const approve = new Approvals({ ...silentIO("yes"), requestSecret }, { yes: true, interactive: true });
    expect(await approve.requestSecret({ kind: "sudo", detail: "sudo true", reason: "x" })).toBe(PASSWORD);
    expect(requestSecret).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalIO.requestSecret", () => {
  function ioWithSecret(
    answer: string,
    calls: Array<{ query: string; mask?: string }>,
    writes: string[],
  ): TerminalIO {
    const prompter: PrompterLike = {
      question: async () => "y",
      close: () => {},
      secretQuestion: async (query, mask) => {
        calls.push({ query, mask });
        return answer;
      },
    };
    return new TerminalIO(prompter, { thinking: false, json: false }, (s) => writes.push(s));
  }

  it("memakai input bertopeng * dan mengembalikan nilai", async () => {
    const calls: Array<{ query: string; mask?: string }> = [];
    const writes: string[] = [];
    const io = ioWithSecret(PASSWORD, calls, writes);

    const value = await io.requestSecret({ kind: "sudo", detail: "sudo true", reason: "butuh password" });

    expect(value).toBe(PASSWORD);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mask).toBe("*");
    expect(writes.join("")).toContain("tidak disimpan");
  });

  it("menganggap kosong/EOF sebagai batal", async () => {
    expect(await ioWithSecret("", [], []).requestSecret({ kind: "sudo", detail: "d", reason: "r" })).toBeNull();
    expect(await ioWithSecret(PROMPT_EOF, [], []).requestSecret({ kind: "sudo", detail: "d", reason: "r" })).toBeNull();
  });
});
