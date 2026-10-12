import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError } from "./errors.js";
import { classifyShell } from "../safety/classifier.js";
import { commandTouchesSensitive } from "../safety/sensitive.js";

const schema = z.object({
  command: z.string().describe("Perintah shell yang dijalankan lewat shell POSIX."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout dalam ms (default 60000)."),
});

const DEFAULT_TIMEOUT = 60_000;
const MAX_OUTPUT = 40_000;

/**
 * Pilih shell POSIX yang benar-benar ada.
 *
 * Node memakai `/bin/sh` secara default, tetapi di Termux (Android) path itu
 * tidak ada: shell-nya berada di `${PREFIX}/bin/sh`. Kalau tidak ada kandidat
 * absolut, kembalikan `sh` agar dicari lewat PATH.
 */
export function resolveShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  if (env.PREFIX) candidates.push(`${env.PREFIX}/bin/sh`);
  candidates.push("/bin/sh", "/usr/bin/sh", "/usr/local/bin/sh");
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // abaikan kandidat yang tidak bisa diperiksa
    }
  }
  return env.SHELL || "sh";
}

interface ShellOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function runShell(
  command: string,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal,
  secret?: string,
): Promise<ShellOutput> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: resolveShell(), cwd, env: process.env });
    if (secret !== undefined && child.stdin) {
      // Rahasia hanya lewat stdin — tak pernah masuk argv/env/log — lalu stdin
      // ditutup agar perintah setelah sudo tidak bisa membacanya.
      child.stdin.on("error", () => {});
      child.stdin.end(`${secret}\n`);
    }
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

/** True bila perintah dimulai dengan `sudo` (bukan `sudoedit`/path lain). */
export function isSudoCommand(command: string): boolean {
  return /^\s*sudo\b/.test(command);
}

/** True bila stderr menandakan sudo gagal karena tidak ada TTY untuk password. */
export function sudoNeedsPassword(command: string, stderr: string): boolean {
  if (!isSudoCommand(command)) return false;
  return /no tty present|a terminal is required|a password is required|must have a tty|askpass helper/i.test(
    stderr,
  );
}

/**
 * Sisipkan `-S -k` pada `sudo` terdepan agar membaca password dari stdin, dan
 * buang `-n` yang menghalangi (baik dari model maupun probe kita) supaya sudo
 * benar-benar membaca password.
 */
export function withSudoStdin(command: string): string {
  return command
    .replace(/^(\s*)sudo\b/, "$1sudo -S -k")
    .replace(/^(\s*sudo(?:\s+-\S+)*?)\s+-n\b/, "$1");
}

/**
 * Sisipkan `-n` pada `sudo` terdepan agar percobaan pertama tidak pernah
 * menggantung menunggu password di TTY (`/dev/tty`). Bila memang butuh
 * password, sudo gagal cepat dan kita menawarkan input sesaat.
 */
export function withSudoNonInteractive(command: string): string {
  return command.replace(/^(\s*)sudo\b/, "$1sudo -n");
}

export const runShellTool: ToolDefinition<typeof schema> = {
  name: "run_shell",
  description:
    "Jalankan perintah shell. Perintah read-only boleh tanpa konfirmasi; mutating butuh persetujuan; berbahaya diblokir. Untuk perintah berhak istimewa, tulis `sudo <perintah>` apa adanya (tanpa `-n`/`-S` atau fallback `|| echo`) — password akan diminta ke pengguna bila perlu.",
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
    // Percobaan pertama dibuat non-interaktif (`-n`) supaya sudo tidak pernah
    // menggantung menunggu password di TTY; bila butuh password, kita yang
    // menawarkan input sesaat di bawah ini.
    const probe = isSudoCommand(input.command) ? withSudoNonInteractive(input.command) : input.command;
    let result = await runShell(probe, timeoutMs, ctx.workspace.root, ctx.signal);

    // sudo tanpa TTY gagal meminta password; tawarkan input sesaat (masked).
    // Deteksi dari gabungan stdout+stderr (bukan exit code) karena model kadang
    // menambahkan `2>&1` atau fallback `|| echo` yang menyamarkan kegagalan.
    const combinedOutput = `${result.stderr}\n${result.stdout}`;
    if (
      ctx.requestSecret &&
      !result.timedOut &&
      !result.aborted &&
      sudoNeedsPassword(input.command, combinedOutput)
    ) {
      const password = await ctx.requestSecret({
        kind: "sudo",
        detail: input.command,
        reason: "sudo membutuhkan password di sistem ini.",
      });
      if (password === null) {
        return {
          content: `Dibatalkan: password sudo tidak diberikan untuk: ${input.command}`,
          ok: false,
          summary: "sudo dibatalkan",
        };
      }
      result = await runShell(
        withSudoStdin(input.command),
        timeoutMs,
        ctx.workspace.root,
        ctx.signal,
        password,
      );
    }

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
