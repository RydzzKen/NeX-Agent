import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Ragam utilitas `script` yang dipakai untuk mengalokasikan PTY. */
export type ScriptStyle = "util-linux" | "bsd" | "busybox" | "none";

export interface TerminalSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnFn = (spec: TerminalSpawnSpec) => ChildProcess;

export interface TerminalManagerOptions {
  /** Direktori kerja (statis atau dinamis mengikuti workspace aktif). */
  cwd: string | (() => string);
  shell?: string;
  env?: NodeJS.ProcessEnv;
  /** Paksa gaya `script` (dipakai tes). */
  style?: ScriptStyle;
  /** Ganti spawner (dipakai tes). */
  spawnFn?: SpawnFn;
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number | null) => void;
  /** Batas byte yang disimpan untuk replay saat klien menyambung ulang. */
  bufferLimit?: number;
}

export interface TerminalInfo {
  id: string;
  running: boolean;
  cols: number;
  rows: number;
  pid?: number;
}

interface LiveTerminal {
  id: string;
  child: ChildProcess;
  cols: number;
  rows: number;
  buffer: string;
  exited: boolean;
}

const DEFAULT_BUFFER_LIMIT = 256 * 1024;

/** Cari shell default pengguna. */
export function defaultShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  for (const candidate of ["/bin/bash", "/bin/sh"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

/**
 * Deteksi varian `script`:
 * - `util-linux` (Linux umum): `script -qfc "cmd" /dev/null`
 * - `bsd` (macOS): `script -q /dev/null sh -c "cmd"`
 * - `busybox` (mis. Termux): `script /dev/null` (menjalankan $SHELL)
 * - `none` (tanpa `script`, mis. Windows): spawn langsung (tanpa PTY)
 */
export function detectScriptStyle(platform: string = process.platform): ScriptStyle {
  if (platform === "win32") return "none";
  const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (probe.error || (probe.status !== 0 && !probe.stdout && !probe.stderr)) return "none";
  const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (/util-linux/i.test(out)) return "util-linux";
  if (platform === "darwin") return "bsd";
  return "busybox";
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Susun command+args untuk `spawn` sesuai gaya `script`. */
export function buildSpawnSpec(
  style: ScriptStyle,
  opts: { shell: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
): TerminalSpawnSpec {
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    TERM: opts.env.TERM ?? "xterm-256color",
    COLUMNS: String(opts.cols),
    LINES: String(opts.rows),
    SHELL: opts.shell,
  };
  const init = `stty rows ${opts.rows} cols ${opts.cols} 2>/dev/null; exec ${quote(opts.shell)} -i`;
  switch (style) {
    case "util-linux":
      return { command: "script", args: ["-qfc", init, "/dev/null"], cwd: opts.cwd, env };
    case "bsd":
      return {
        command: "script",
        args: ["-q", "/dev/null", "/bin/sh", "-c", init],
        cwd: opts.cwd,
        env,
      };
    case "busybox":
      return { command: "script", args: ["/dev/null"], cwd: opts.cwd, env };
    case "none":
    default:
      return { command: opts.shell, args: ["-i"], cwd: opts.cwd, env };
  }
}

/** Kelola terminal persisten (selama proses server hidup). */
export class TerminalManager {
  private readonly style: ScriptStyle;
  private readonly shell: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly bufferLimit: number;
  private readonly terminals = new Map<string, LiveTerminal>();

  constructor(private readonly opts: TerminalManagerOptions) {
    this.style = opts.style ?? detectScriptStyle();
    this.shell = opts.shell ?? defaultShell();
    this.env = opts.env ?? process.env;
    this.spawnFn = opts.spawnFn ?? ((spec) => spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env }));
    this.bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  backendName(): string {
    return this.style;
  }

  private resolveCwd(): string {
    return typeof this.opts.cwd === "function" ? this.opts.cwd() : this.opts.cwd;
  }

  /**
   * Buka (atau sambung ulang ke) terminal `id`. Bila sudah hidup, kembalikan
   * buffer keluaran sebelumnya agar klien yang menyambung ulang melihat state.
   */
  open(id: string, cols: number, rows: number): { created: boolean; buffer: string } {
    const existing = this.terminals.get(id);
    if (existing && !existing.exited) {
      existing.cols = cols;
      existing.rows = rows;
      return { created: false, buffer: existing.buffer };
    }
    if (existing) this.terminals.delete(id);

    const spec = buildSpawnSpec(this.style, {
      shell: this.shell,
      cols,
      rows,
      cwd: this.resolveCwd(),
      env: this.env,
    });
    const child = this.spawnFn(spec);
    const live: LiveTerminal = { id, child, cols, rows, buffer: "", exited: false };
    this.terminals.set(id, live);

    const onChunk = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      live.buffer += text;
      if (live.buffer.length > this.bufferLimit) {
        live.buffer = live.buffer.slice(live.buffer.length - this.bufferLimit);
      }
      this.opts.onData(id, text);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code) => {
      live.exited = true;
      this.opts.onExit(id, code);
    });
    child.on("error", (err) => {
      live.exited = true;
      this.opts.onData(id, `\r\n[terminal error] ${err.message}\r\n`);
      this.opts.onExit(id, null);
    });

    return { created: true, buffer: "" };
  }

  write(id: string, data: string): boolean {
    const live = this.terminals.get(id);
    if (!live || live.exited || !live.child.stdin) return false;
    live.child.stdin.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.terminals.get(id);
    if (!live) return;
    live.cols = cols;
    live.rows = rows;
    // `script` tidak bisa meneruskan ukuran ke PTY; ukuran dipakai untuk
    // koneksi berikutnya. Signal SIGWINCH tidak berpengaruh tanpa PTY asli.
  }

  close(id: string): boolean {
    const live = this.terminals.get(id);
    if (!live) return false;
    this.terminals.delete(id);
    try {
      live.child.kill("SIGTERM");
    } catch {
      // abaikan
    }
    return true;
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((live) => ({
      id: live.id,
      running: !live.exited,
      cols: live.cols,
      rows: live.rows,
      ...(live.child.pid ? { pid: live.child.pid } : {}),
    }));
  }

  has(id: string): boolean {
    const live = this.terminals.get(id);
    return Boolean(live && !live.exited);
  }
}

/** Label ramah untuk backend terminal. */
export function describeBackend(style: ScriptStyle): string {
  switch (style) {
    case "util-linux":
    case "bsd":
    case "busybox":
      return `pty (${style} script)`;
    default:
      return "pipe (tanpa PTY)";
  }
}

/** Cek cepat apakah direktori ada (dipakai validasi cwd). */
export function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(path.resolve(dir)).isDirectory();
  } catch {
    return false;
  }
}
