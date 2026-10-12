import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO, type AgentIO, type SecretRequest } from "../src/core/io.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { TodoStore } from "../src/core/todos.js";
import type { ToolContext } from "../src/tools/types.js";
import {
  isSshCommand,
  runShellTool,
  sshNeedsPassword,
  withSshAskpass,
  withSshNonInteractive,
} from "../src/tools/run_shell.js";

const PASSWORD = "rahasia";

let root: string;
let binDir: string;
let savedPath: string | undefined;

/**
 * ssh tiruan: gagal "perlu password" kecuali dipanggil dengan SSH_ASKPASS dan
 * password benar. Skrip askpass menerima password lewat stdin (sama seperti ssh
 * asli yang menyalurkan stdin-nya ke program askpass).
 */
const FAKE_SSH = `#!/bin/sh
if [ -n "$SSH_LOG" ]; then printf '%s\\n' "$*" >> "$SSH_LOG"; fi
if [ "$SSH_MODE" = "keyonly" ]; then
  echo "user@host: Permission denied (publickey)." >&2
  exit 255
fi
case " $* " in
  *" BatchMode=yes "*) echo "user@host: Permission denied (publickey,password)." >&2; exit 255 ;;
esac
if [ -n "$SSH_ASKPASS" ]; then
  pw=$("$SSH_ASKPASS" "user@host's password:")
  if [ "$pw" = "${PASSWORD}" ]; then echo "selamat datang di host"; exit 0; fi
fi
echo "user@host: Permission denied (publickey,password)." >&2
exit 255
`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-ssh-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-ssh-bin-"));
  const sshPath = path.join(binDir, "ssh");
  await fs.writeFile(sshPath, FAKE_SSH, "utf8");
  await fs.chmod(sshPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  delete process.env.SSH_LOG;
  delete process.env.SSH_MODE;
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

describe("helper ssh", () => {
  it("mengenali klien ssh/scp/sftp, bukan sshpass", () => {
    expect(isSshCommand("ssh user@host uptime")).toBe(true);
    expect(isSshCommand("   scp a b")).toBe(true);
    expect(isSshCommand("sftp user@host")).toBe(true);
    expect(isSshCommand("sshpass -p x ssh y")).toBe(false);
    expect(isSshCommand("echo ssh")).toBe(false);
  });

  it("hanya menandai kegagalan yang mungkin dibantu password", () => {
    expect(sshNeedsPassword("ssh h", "Permission denied (publickey,password).")).toBe(true);
    expect(sshNeedsPassword("ssh h", "Permission denied (keyboard-interactive).")).toBe(true);
    expect(sshNeedsPassword("ssh h", "Permission denied (publickey).")).toBe(false);
    expect(sshNeedsPassword("ssh h", "Host key verification failed.")).toBe(false);
    expect(sshNeedsPassword("ls", "Permission denied (publickey,password).")).toBe(false);
  });

  it("menyiapkan probe BatchMode=yes dan retry BatchMode=no", () => {
    expect(withSshNonInteractive("ssh host")).toBe("ssh -o BatchMode=yes host");
    expect(withSshAskpass("ssh -o BatchMode=yes host")).toBe("ssh -o BatchMode=no host");
    expect(withSshAskpass("ssh -oBatchMode=yes host")).toBe("ssh -o BatchMode=no host");
    expect(withSshNonInteractive("echo ssh")).toBe("echo ssh");
  });
});

describe("run_shell + ssh", () => {
  it("minta password sesaat lalu ulangi lewat SSH_ASKPASS", async () => {
    const spy = vi.fn(async (_req: SecretRequest) => PASSWORD);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "ssh user@host uptime" }, ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ kind: "ssh", detail: "ssh user@host uptime" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("exit code: 0");
    expect(result.content).not.toContain(PASSWORD);
    expect(result.summary ?? "").not.toContain(PASSWORD);
  });

  it("probe BatchMode=yes lebih dulu, lalu retry BatchMode=no", async () => {
    const log = path.join(root, "ssh.log");
    process.env.SSH_LOG = log;
    try {
      const ctx = makeContext(async () => PASSWORD);
      const result = await runShellTool.execute({ command: "ssh user@host uptime" }, ctx);

      expect(result.ok).toBe(true);
      const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(lines[0]).toContain("-o BatchMode=yes user@host uptime");
      expect(lines[1]).toContain("-o BatchMode=no user@host uptime");
    } finally {
      delete process.env.SSH_LOG;
    }
  });

  it("batal saat pengguna tidak memberi password", async () => {
    const spy = vi.fn(async () => null);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "ssh user@host uptime" }, ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Dibatalkan");
    expect(result.summary).toBe("ssh dibatalkan");
  });

  it("tidak minta password bila server hanya mengizinkan publickey", async () => {
    process.env.SSH_MODE = "keyonly";
    const spy = vi.fn(async () => PASSWORD);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "ssh user@host uptime" }, ctx);

    expect(spy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("tidak pernah minta password untuk perintah non-ssh", async () => {
    const spy = vi.fn(async () => PASSWORD);
    const ctx = makeContext(spy);

    const result = await runShellTool.execute({ command: "false" }, ctx);

    expect(spy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
