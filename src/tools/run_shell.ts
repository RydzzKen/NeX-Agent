import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError } from "./errors.js";
import { classifyShell } from "../safety/classifier.js";
import { commandTouchesSensitive } from "../safety/sensitive.js";

const schema = z.object({
  command: z.string().describe("Perintah shell yang dijalankan lewat /bin/sh."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout dalam ms (default 60000)."),
});

const DEFAULT_TIMEOUT = 60_000;
const MAX_OUTPUT = 40_000;

interface ShellOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function runShell(command: string, timeoutMs: number, cwd: string, signal: AbortSignal): Promise<ShellOutput> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const cap = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...(dipotong)" : s);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code: -1, signal: null, stdout, stderr: cap(stderr + "\n" + err.message), timedOut, aborted });
    });

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, signal: sig, stdout: cap(stdout), stderr: cap(stderr), timedOut, aborted });
    });
  });
}

export const runShellTool: ToolDefinition<typeof schema> = {
  name: "run_shell",
  description:
    "Jalankan perintah shell. Perintah read-only boleh tanpa konfirmasi; mutating butuh persetujuan; berbahaya diblokir.",
  risk: "mutate",
  schema,
  summarize: (i) => (i.command.length > 60 ? i.command.slice(0, 57) + "..." : i.command),
  async execute(input, ctx) {
    const classification = classifyShell(input.command);

    if (classification.risk === "block") {
      throw new ToolDeniedError(
        `Perintah diblokir (${classification.reason}): ${input.command}`,
        classification.reason ?? "perintah berbahaya",
      );
    }

    if (classification.risk === "confirm") {
      if (ctx.mode === "plan") {
        throw new ToolDeniedError(
          `Mode Plan hanya mengizinkan perintah read-only: ${input.command}`,
          "mode Plan + perintah mutating",
        );
      }
      const decision = await ctx.confirm({
        kind: "shell",
        title: "Jalankan perintah shell",
        detail: input.command,
        irreversible: true,
      });
      if (decision === "no") throw new ToolDeniedError(`Pengguna menolak perintah: ${input.command}`);
    }

    // Perintah yang menyentuh file sensitif tetap butuh izin eksplisit,
    // termasuk saat allow-all/--yes aktif.
    if (commandTouchesSensitive(input.command)) {
      const ok = await ctx.confirmSensitive({
        kind: "shell",
        detail: input.command,
        reason: "perintah menyentuh file sensitif (mis. .env, kredensial)",
      });
      if (!ok) {
        throw new ToolDeniedError(
          `Akses file sensitif lewat shell ditolak: ${input.command}`,
          "file sensitif ditolak",
        );
      }
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
    const result = await runShell(input.command, timeoutMs, ctx.workspace.root, ctx.signal);

    const parts: string[] = [];
    parts.push(`exit code: ${result.code ?? "null"}`);
    if (result.timedOut) parts.push(`(timeout ${timeoutMs}ms)`);
    if (result.aborted) parts.push("(dibatalkan pengguna)");
    if (result.signal) parts.push(`signal: ${result.signal}`);
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);

    const ok = result.code === 0 && !result.timedOut && !result.aborted;
    return {
      content: parts.join("\n"),
      ok,
      summary: `exit ${result.code ?? "?"}${result.timedOut ? " (timeout)" : ""}`,
    };
  },
};
