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
  withSudoStdin,
} from "../src/tools/run_shell.js";

const PASSWORD = "rahasia";

let root: string;
let binDir: string;
let savedPath: string | undefined;

/** sudo tiruan: gagal "tanpa TTY" kecuali dipanggil dengan `-S` + password benar. */
const FAKE_SUDO = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-S" ]; then
    IFS= read -r pw
    if [ "$pw" = "${PASSWORD}" ]; then exit 0; fi
    echo "sudo: 1 incorrect password attempt" >&2
    exit 1
  fi
done
echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
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
    expect(sudoNeedsPassword("ls", "a terminal is required")).toBe(false);
    expect(sudoNeedsPassword("sudo ls", "permission denied")).toBe(false);
  });

  it("menyisipkan -S -k pada sudo terdepan saja", () => {
    expect(withSudoStdin("sudo apt install x")).toBe("sudo -S -k apt install x");
    expect(withSudoStdin("  sudo ls")).toBe("  sudo -S -k ls");
    expect(withSudoStdin("sudoedit /etc/hosts")).toBe("sudoedit /etc/hosts");
    expect(withSudoStdin("echo sudo")).toBe("echo sudo");
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
