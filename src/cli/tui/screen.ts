import type { Writable } from "node:stream";
import readline from "node:readline";
import {
  highlightColumns,
  normalizeKey,
  sliceByColumns,
  stripAnsi,
  truncateTo,
  visibleWidth,
  wrapAnsi,
  type Key,
} from "../../util/ansi.js";
import { OSC52_MAX_BYTES, osc52Sequence, wrapForMultiplexer } from "../../util/clipboard.js";
import { APP_VERSION } from "../../version.js";
import {
  alignSides,
  centerLine,
  centerPad,
  clipLine,
  contentWidth,
  fitLine,
  formatFooter,
  formatHeader,
  formatPromptMeta,
  layoutMetrics,
  truncateMiddle,
  wrapLine,
  type LayoutMetrics,
} from "./layout.js";
import {
  bg,
  detectColorLevel,
  fg,
  logoNeX,
  modeAccent,
  spinnerFrame,
  themePalette,
  type ColorLevel,
  type ThemeName,
  type ThemePalette,
} from "./theme.js";

/** Jenis baris; dipakai untuk pewarnaan dan filter (thinking). */
export type LineKind =
  | "text"
  | "think"
  | "tool"
  | "tool-out"
  | "edit"
  | "diff-add"
  | "diff-del"
  | "diff-hunk"
  | "diff-context"
  | "info"
  | "warn"
  | "error"
  | "user"
  | "raw"
  | "divider";

export interface ScreenStatus {
  mode: string;
  model: string;
  provider: string;
  busy: boolean;
}

/** Daftar pilihan yang bisa disorot dengan ↑/↓ (mis. `/models`, `/sessions`). */
export interface OverlayList {
  items: string[];
  selected: number;
  /** Indeks item teratas yang terlihat (jendela bergulir). */
  offset: number;
  /** Teks bantuan di kaki overlay (mis. "↑/↓ pilih · Enter · Esc"). */
  hint?: string;
}

export interface OverlayContent {
  title: string;
  body: string[];
  /** Opsi tombol, mis. `[["y","Izinkan"],["n","Tolak"]]` (Enter = yang pertama). */
  keys: Array<[string, string]>;
  /** Mode input rahasia (masked) — mengesampingkan `keys`. */
  secret?: { label: string; masked?: boolean };
  /** Mode daftar pilihan (↑/↓ memindah sorotan, Enter memilih). */
  list?: OverlayList;
  /** Baris teratas body yang ditampilkan untuk konten panjang (viewer). */
  scrollTop?: number;
}

/** Informasi footer: folder:branch di kiri, versi di kanan. */
export interface ScreenFooter {
  folder: string;
  branch: string;
  version: string;
}

export interface SidebarPlugin {
  name: string;
  enabled: boolean;
  connected?: boolean;
}

export interface SidebarFile {
  path: string;
  added: number;
  removed: number;
}

export interface SidebarData {
  plugins: SidebarPlugin[];
  files: SidebarFile[];
}

interface View {
  id: string;
  name: string;
  main: boolean;
  lines: Line[];
  /** Baris tergulung ke atas dari dasar konten (0 = dasar). */
  scroll: number;
  /** Jenis baris terakhir yang masih "terbuka" untuk sambungan streaming. */
  open?: LineKind;
}

export interface ScreenLine {
  kind: LineKind;
  text: string;
  /** ID unik untuk baris tool yang bisa diperbarui saat selesai. */
  id?: number;
  /** Nomor baris sumber (diff). */
  num?: number;
  running?: boolean;
  status?: "ok" | "error" | "denied";
}

type Line = ScreenLine;

export interface ScreenOptions {
  stdin: NodeJS.ReadStream;
  stdout: Writable & {
    columns?: number;
    rows?: number;
    on?: (e: string, cb: () => void) => void;
    off?: (e: string, cb: () => void) => void;
    removeListener?: (e: string, cb: () => void) => void;
  };
  status?: Partial<ScreenStatus>;
  showThinking?: boolean;
  footer?: Partial<ScreenFooter>;
  theme?: ThemeName;
}

/** Baris daftar yang terlihat sekaligus di overlay. */
const MAX_OVERLAY_LIST = 10;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LINES = 5000; // Batasi scrollback biar nggak OOM

type WriteFn = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

interface PromptRender {
  lines: string[];
  /** Indeks baris input di dalam `lines`. */
  inputIndex: number;
  /** Kolom kursor 0-based relatif terhadap kotak prompt. */
  cursorCol: number;
}

/**
 * Layar TUI: alternate screen, raw-mode input, intercept `process.stdout.write`
 * agar semua tulis langsung dari app masuk ke frame, multi-view (utama +
 * subagent), input line, overlay modal, layar awal, dan layar sesi.
 */
export class Screen {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: ScreenOptions["stdout"];
  private readonly write: WriteFn;
  private readonly emitKeypress: boolean;
  private views: View[] = [];
  private active = 0;
  private status: ScreenStatus = { mode: "build", model: "", provider: "", busy: false };
  private showThinking: boolean;
  private started = false;
  private intercepted = false;
  private origWrite?: WriteFn;
  private theme: ThemeName;
  private palette: ThemePalette;
  private colorLevel: ColorLevel;

  private home = true;
  private sessionTitle = "";
  private contextPercent = 0;
  private footer: ScreenFooter;
  private sidebar: SidebarData = { plugins: [], files: [] };
  private sidebarPluginHits: Array<{ line: number; name: string }> = [];
  private sidebarHandler?: (name: string) => void;
  private lastSidebarLeft = 0;
  private lastSidebarWidth = 0;
  private showToolOutput = true;
  private toolSeq = 0;

  private input = { text: "", caret: 0, mask: false, active: false, prompt: "" };
  private menu?: {
    token: string;
    matches: string[];
    descriptions?: string[];
    selected: number;
    offset: number;
  };
  private overlay?: OverlayContent;
  private overlayInput = "";

  private keyHandler?: (key: Key) => void;
  private drawTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private spinnerTick = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;

  // Seleksi mouse (dalam indeks baris-bungkus `all` + kolom tampilan 0-based).
  private sel?: { aLine: number; aCol: number; fLine: number; fCol: number };
  private selecting = false;
  private lastAll: string[] = [];
  private lastStart = 0;
  private lastContentRows = 0;
  private lastContentTop = 1;
  private lastContentLeft = 1;
  private lastContentWidth = 1;
  private notice?: string;
  private noticeTimer?: ReturnType<typeof setTimeout>;

  private readonly onResize = (): void => {
    if (this.resizeTimer) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.redraw();
    }, 16);
    (this.resizeTimer as { unref?: () => void }).unref?.();
  };

  constructor(opts: ScreenOptions) {
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    // Tangkap fungsi tulis ASLI *saat ini* (di-bind), bukan dibaca ulang tiap
    // panggil: `installIntercept()` menimpa `process.stdout.write` setelahnya,
    // jadi membaca ulang akan mengarahkan frame kembali ke interceptor →
    // `appendRaw` → `redraw` → rekursi, dan layar tetap kosong.
    const originalWrite = (opts.stdout.write as WriteFn).bind(opts.stdout);
    this.write = (s) => {
      originalWrite(s);
      return true;
    };
    this.emitKeypress = Boolean(opts.stdin.isTTY);
    this.showThinking = opts.showThinking ?? true;
    this.theme = opts.theme ?? "opencode";
    this.palette = themePalette(this.theme);
    this.colorLevel = detectColorLevel();
    this.footer = {
      folder: "",
      branch: "",
      version: APP_VERSION,
      ...opts.footer,
    };
    if (opts.status) this.status = { ...this.status, ...opts.status };
    this.views.push({ id: "main", name: "utama", main: true, lines: [], scroll: 0 });
  }

  // ---- siklus hidup ----

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.stdout === process.stdout) {
      this.write("\u001b[?1049h"); // alternate screen
      this.write("\u001b[?25l"); // sembunyikan kursor
      // Aktifkan pelaporan mouse (mode 1000) + gerak saat tombol ditahan
      // (mode 1002) dengan koordinat SGR (mode 1006): roda dipetakan ke gulir
      // transkrip, seret tombol kiri menyeleksi teks, dan tombol ↑/↓ tetap
      // untuk riwayat input.
      this.write("\u001b[?1000h");
      this.write("\u001b[?1002h");
      this.write("\u001b[?1006h");
      this.installIntercept();
    }
    this.stdout.on?.("resize", this.onResize);
    if (this.emitKeypress) {
      readline.emitKeypressEvents(this.stdin);
      this.stdin.setRawMode(true);
      this.stdin.on(
        "keypress",
        (
          str: string,
          key?: {
            name?: string;
            ctrl?: boolean;
            meta?: boolean;
            shift?: boolean;
            sequence?: string;
          },
        ) => {
          this.keyHandler?.(normalizeKey(key ?? { sequence: str }));
        },
      );
    }
    this.redraw();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.drawTimer) clearTimeout(this.drawTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.spinnerTimer = undefined;
    this.drawTimer = undefined;
    this.resizeTimer = undefined;
    this.noticeTimer = undefined;
    this.sel = undefined;
    this.selecting = false;
    if (this.emitKeypress) {
      this.stdin.removeAllListeners("keypress");
      this.stdin.setRawMode(false);
    }
    this.stdout.off?.("resize", this.onResize);
    this.stdout.removeListener?.("resize", this.onResize);
    if (this.stdout === process.stdout) {
      this.restoreIntercept();
      this.write("\u001b[?1006l"); // matikan mode SGR mouse
      this.write("\u001b[?1002l"); // matikan pelaporan gerak
      this.write("\u001b[?1000l"); // matikan pelaporan mouse
      this.write("\u001b[?25h"); // tampilkan kursor
      this.write("\u001b[?1049l"); // kembali ke buffer utama
    }
  }

  private installIntercept(): void {
    if (this.intercepted) return;
    this.intercepted = true;
    this.origWrite = (process.stdout.write as unknown as WriteFn).bind(process.stdout);
    (process.stdout.write as unknown as WriteFn) = (chunk, ..._rest) => {
      if (typeof chunk === "string" && this.started) this.appendRaw(chunk);
      return true;
    };
  }

  private restoreIntercept(): void {
    if (!this.intercepted || !this.origWrite) return;
    this.intercepted = false;
    (process.stdout.write as unknown as WriteFn) = this.origWrite;
    this.origWrite = undefined;
  }

  // ---- key ----

  setKeyHandler(handler: (key: Key) => void): void {
    this.keyHandler = handler;
  }

  /** Jalur test: kirim key tanpa stdin sungguhan. */
  emitKey(key: {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    sequence?: string;
  }): void {
    this.keyHandler?.(normalizeKey(key));
  }

  // ---- input state ----

  setInput(text: string, caret: number, mask: boolean, prompt: string): void {
    this.input = {
      text,
      caret: Math.max(0, Math.min(caret, text.length)),
      mask: mask === true,
      active: true,
      prompt,
    };
    this.redraw();
  }

  getInputText(): string {
    return this.input.text;
  }

  getInputPrompt(): string {
    return this.input.prompt;
  }

  /** True bila baris input sedang terfokus (bisa diketik). */
  get inputActive(): boolean {
    return this.input.active;
  }

  clearInput(): void {
    this.input.active = false;
    this.input.text = "";
    this.input.caret = 0;
    this.menu = undefined;
    this.redraw();
  }

  insertInput(ch: string): void {
    const { text, caret, mask, prompt } = this.input;
    // Tetap sisipkan walau `mask` aktif: mask hanya menyembunyikan tampilan,
    // bukan melarang pengetikan (mis. prompt API key lewat `secretQuestion`).
    this.setInput(text.slice(0, caret) + ch + text.slice(caret), caret + ch.length, mask, prompt);
  }

  deleteInput(): void {
    const { text, caret, mask, prompt } = this.input;
    if (caret <= 0) return;
    this.setInput(text.slice(0, caret - 1) + text.slice(caret), caret - 1, mask, prompt);
  }

  forwardDeleteInput(): void {
    const { text, caret, mask, prompt } = this.input;
    if (caret >= text.length) return;
    this.setInput(text.slice(0, caret) + text.slice(caret + 1), caret, mask, prompt);
  }

  moveCaret(delta: number): void {
    const { text, caret, mask, prompt } = this.input;
    this.setInput(text, caret + delta, mask, prompt);
  }

  caretToStart(): void {
    this.setInput(this.input.text, 0, this.input.mask, this.input.prompt);
  }

  caretToEnd(): void {
    this.setInput(this.input.text, this.input.text.length, this.input.mask, this.input.prompt);
  }

  setMenu(token: string, matches: string[], descriptions?: string[]): void {
    this.menu =
      matches.length > 0
        ? { token, matches, ...(descriptions ? { descriptions } : {}), selected: 0, offset: 0 }
        : undefined;
    this.redraw();
  }

  clearMenu(): void {
    this.menu = undefined;
    this.redraw();
  }

  menuSelect(delta: number): void {
    if (!this.menu || this.menu.matches.length === 0) return;
    const n = this.menu.matches.length;
    const visible = Math.min(n, this.menuVisibleRows());
    this.menu.selected = (this.menu.selected + delta + n) % n;
    // Geser jendela agar item terpilih selalu terlihat (menu ikut bergulir).
    if (this.menu.selected < this.menu.offset) {
      this.menu.offset = this.menu.selected;
    } else if (this.menu.selected >= this.menu.offset + visible) {
      this.menu.offset = this.menu.selected - visible + 1;
    }
    this.menu.offset = Math.max(0, Math.min(this.menu.offset, Math.max(0, n - visible)));
    this.redraw();
  }

  getMenuSelected(): string | undefined {
    return this.menu?.matches[this.menu.selected];
  }

  getMenuToken(): string | undefined {
    return this.menu?.token;
  }

  // ---- layar awal / sesi ----

  /** Pindah dari layar awal ke layar sesi (dipanggil saat pesan pertama). */
  startSession(title?: string): void {
    const clean = title?.split("\n")[0]?.trim();
    if (clean) this.sessionTitle = clean;
    this.revealSession();
    this.menu = undefined;
    this.scrollToBottom();
  }

  /** Salinan baris view utama untuk undo/redo transkrip. */
  snapshotMainLines(): ScreenLine[] {
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    return main.lines.map((line) => ({ ...line }));
  }

  /** Pulihkan baris view utama (dipakai undo/redo). */
  restoreMainLines(lines: ScreenLine[]): void {
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    main.lines = lines.map((line) => ({ ...line }));
    main.open = undefined;
    main.scroll = 0;
    this.active = this.views.indexOf(main);
    this.sel = undefined;
    this.selecting = false;
    this.redraw();
  }

  /** Kembali ke layar awal dan kosongkan transkrip sesi. */
  showHome(): void {
    this.home = true;
    this.sessionTitle = "";
    this.contextPercent = 0;
    this.sidebar = { plugins: [], files: [] };
    this.sidebarPluginHits = [];
    this.lastSidebarWidth = 0;
    this.sel = undefined;
    this.selecting = false;
    this.menu = undefined;
    this.lastAll = [];
    this.lastStart = 0;
    this.lastContentRows = 0;
    this.lastContentTop = 1;
    this.lastContentLeft = 1;
    this.lastContentWidth = 1;
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    this.views = [main];
    main.lines = [];
    main.scroll = 0;
    main.open = undefined;
    this.active = 0;
    this.redraw();
  }

  /** Output langsung (mis. daftar model saat init) membuka layar sesi. */
  private revealSession(): void {
    if (!this.home) return;
    this.home = false;
    this.menu = undefined;
  }

  get isHome(): boolean {
    return this.home;
  }

  get currentSessionTitle(): string {
    return this.sessionTitle;
  }

  setSessionInfo(info: { title?: string; contextPercent?: number }, redraw = true): void {
    if (info.title !== undefined) this.sessionTitle = info.title.trim();
    if (info.contextPercent !== undefined) {
      this.contextPercent = Math.max(0, Math.min(100, Math.round(info.contextPercent)));
    }
    if (redraw) this.redraw();
  }

  setFooter(info: Partial<ScreenFooter>, redraw = true): void {
    this.footer = { ...this.footer, ...info };
    if (redraw) this.redraw();
  }

  setSidebar(data: Partial<SidebarData>, redraw = true): void {
    this.sidebar = {
      plugins: data.plugins ?? this.sidebar.plugins,
      files: data.files ?? this.sidebar.files,
    };
    if (redraw) this.redraw();
  }

  /** Klik plugin di sidebar (baris 1-based, kolom 1-based). */
  setSidebarHandler(handler: (name: string) => void): void {
    this.sidebarHandler = handler;
  }

  /**
   * Tangani klik pada daftar plugin sidebar. Mengembalikan `true` bila klik
   * mengenai plugin sehingga pemanggil tidak memulai seleksi teks.
   */
  clickSidebar(x: number, y: number): boolean {
    if (this.home || this.lastSidebarWidth <= 0) return false;
    if (x < this.lastSidebarLeft || x >= this.lastSidebarLeft + this.lastSidebarWidth) return false;
    const hit = this.sidebarPluginHits.find((item) => item.line === y - 1);
    if (!hit || !this.sidebarHandler) return false;
    this.sidebarHandler(hit.name);
    return true;
  }

  setTheme(name: ThemeName): void {
    this.theme = name;
    this.palette = themePalette(name);
    this.redraw();
  }

  // ---- overlay ----

  setOverlay(overlay: OverlayContent | undefined): void {
    this.overlay = overlay;
    this.overlayInput = "";
    this.menu = undefined;
    this.redraw();
  }

  get overlayActive(): boolean {
    return this.overlay !== undefined;
  }

  isOverlaySecret(): boolean {
    return this.overlay?.secret !== undefined;
  }

  pushOverlayChar(ch: string): void {
    if (this.isOverlaySecret()) this.overlayInput += ch;
    this.redraw();
  }

  popOverlayChar(): void {
    this.overlayInput = this.overlayInput.slice(0, -1);
    this.redraw();
  }

  getOverlayInput(): string {
    return this.overlayInput;
  }

  /** Isi overlay input dengan teks awal (untuk mode input teks biasa). */
  setOverlayInput(text: string): void {
    this.overlayInput = text;
    this.redraw();
  }

  getOverlayFirstKey(): string {
    return this.overlay?.keys[0]?.[0] ?? "y";
  }

  /** True bila overlay sedang menampilkan daftar pilihan. */
  hasOverlayList(): boolean {
    return this.overlay?.list !== undefined;
  }

  /** Indeks item yang sedang disorot (atau -1 bila bukan mode daftar). */
  getOverlaySelected(): number {
    return this.overlay?.list?.selected ?? -1;
  }

  /** Pindahkan sorotan daftar overlay (jendela ikut bergulir). */
  overlaySelect(delta: number): void {
    const list = this.overlay?.list;
    if (!list || list.items.length === 0) return;
    const n = list.items.length;
    const visible = Math.min(n, MAX_OVERLAY_LIST);
    list.selected = (list.selected + delta + n) % n;
    if (list.selected < list.offset) list.offset = list.selected;
    else if (list.selected >= list.offset + visible) list.offset = list.selected - visible + 1;
    list.offset = Math.max(0, Math.min(list.offset, Math.max(0, n - visible)));
    this.redraw();
  }

  /** Gulir body overlay (mode viewer); delta > 0 = turun. */
  overlayScrollBy(delta: number): void {
    const o = this.overlay;
    if (!o || o.list) return;
    // `renderOverlay` meng-clamp nilai ini ke rentang yang valid.
    o.scrollTop = Math.max(0, (o.scrollTop ?? 0) + delta);
    this.redraw();
  }

  // ---- konten & view ----

  append(kind: LineKind, text: string): void {
    if ((kind === "warn" || kind === "error") && String(text).trim()) this.revealSession();
    const view = this.views[this.active]!;
    const parts = String(text).split("\n");
    for (const raw of parts) {
      view.lines.push({ kind, text: raw });
    }
    view.open = undefined;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, parts.length);
    this.redraw();
  }

  /**
   * Tambahkan potongan **streaming**: lanjutkan baris terakhir bila jenisnya
   * sama (mis. token thinking berurutan tidak lagi menjadi satu baris per kata),
   * dan mulai baris baru hanya saat potongan mengandung `\n`.
   */
  appendStream(kind: LineKind, text: string): void {
    const view = this.views[this.active]!;
    const parts = String(text).split("\n");
    const partCount = parts.length;
    const first = parts.shift() ?? "";
    const last = view.lines[view.lines.length - 1];
    const continued = view.open === kind && last !== undefined && last.kind === kind;
    if (continued && last) {
      last.text += first;
    } else {
      view.lines.push({ kind, text: first });
    }
    for (const p of parts) view.lines.push({ kind, text: p });
    view.open = kind;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, (continued ? 0 : 1) + (partCount - 1));
    this.redraw();
  }

  /** Baris tool yang sedang berjalan; kembalikan ID untuk diperbarui nanti. */
  appendTool(text: string): number {
    if (this.home) this.revealSession();
    const view = this.views[this.active]!;
    const id = ++this.toolSeq;
    view.lines.push({ kind: "tool", text, id, running: true });
    view.open = undefined;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, 1);
    this.redraw();
    return id;
  }

  /** Ubah baris tool menjadi hasil akhir (edit/diff/status). */
  finishTool(
    id: number,
    opts: { text?: string; kind?: LineKind; status?: "ok" | "error" | "denied" } = {},
  ): void {
    for (const view of this.views) {
      const line = view.lines.find((entry) => entry.id === id);
      if (!line) continue;
      line.running = false;
      if (opts.status) line.status = opts.status;
      if (opts.text !== undefined) line.text = opts.text;
      if (opts.kind) line.kind = opts.kind;
      this.redraw();
      return;
    }
  }

  /**
   * Tambahkan diff unified. Header file dilewati (path ditampilkan terpisah),
   * nomor baris dihitung dari header hunk, dan baris +/- diberi latar warna.
   */
  appendDiff(text: string): void {
    const plain = stripAnsi(String(text)).split("\n");
    const lines: Line[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (const raw of plain) {
      const line = raw.replace(/\r$/, "");
      if (
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("Index: ") ||
        line.startsWith("===") ||
        line.startsWith("\\ No newline")
      ) {
        continue;
      }
      if (line.startsWith("@@")) {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (match) {
          oldLine = Number(match[1]);
          newLine = Number(match[2]);
        }
        lines.push({ kind: "diff-hunk", text: line });
        continue;
      }
      if (line.startsWith("+")) {
        lines.push({ kind: "diff-add", text: line.slice(1), num: newLine });
        newLine += 1;
        continue;
      }
      if (line.startsWith("-")) {
        lines.push({ kind: "diff-del", text: line.slice(1), num: oldLine });
        oldLine += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        lines.push({ kind: "diff-context", text: line.slice(1), num: newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
    if (lines.length === 0) {
      this.append("raw", text);
      return;
    }
    if (this.home) this.revealSession();
    const view = this.views[this.active]!;
    view.lines.push(...lines);
    view.open = undefined;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, lines.length);
    this.redraw();
  }

  /** Tampilkan/sembunyikan panel output tool (perintah `/details`). */
  setToolDetailsVisible(visible: boolean): void {
    this.showToolOutput = visible;
    this.redraw();
  }

  toggleToolDetails(): boolean {
    this.showToolOutput = !this.showToolOutput;
    this.redraw();
    return this.showToolOutput;
  }

  get toolDetailsVisible(): boolean {
    return this.showToolOutput;
  }

  /** Tutup baris streaming aktif: blok berikutnya mulai di baris baru. */
  endStream(): void {
    const view = this.views[this.active]!;
    view.open = undefined;
  }

  /** Saluran untuk tulis langsung ke stdout (intercept) — selalu ke view utama. */
  appendRaw(text: string): void {
    if (String(text).trim()) this.revealSession();
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    const parts = text.split("\n");
    for (const raw of parts) main.lines.push({ kind: "raw", text: raw });
    main.open = undefined;
    if (main.lines.length > MAX_LINES) {
      main.lines.splice(0, main.lines.length - MAX_LINES);
    }
    this.follow(main, parts.length);
    this.redraw();
  }

  lineBreak(): void {
    const view = this.views[this.active]!;
    view.lines.push({ kind: "divider", text: "" });
    view.open = undefined;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, 1);
    this.redraw();
  }

  setThinkingVisible(visible: boolean): void {
    this.showThinking = visible;
    this.redraw();
  }

  get thinkingVisible(): boolean {
    return this.showThinking;
  }

  /** Jumlah baris yang digulir dari bawah (0 = paling bawah). */
  get scrollOffset(): number {
    return this.views[this.active]!.scroll;
  }

  /**
   * Sesuaikan gulir setelah baris baru ditambahkan. Bila pengguna sedang
   * menggulir ke atas (`scroll > 0`), posisinya dipertahankan supaya output
   * baru (mis. saat agent berpikir/streaming) tidak menyentak ke bawah.
   */
  private follow(view: View, deltaLines: number): void {
    if (view.scroll > 0 && deltaLines > 0) view.scroll += deltaLines;
  }

  scrollBy(delta: number): void {
    const view = this.views[this.active]!;
    view.scroll = Math.max(0, view.scroll + delta);
    this.redraw();
  }

  scrollToBottom(): void {
    this.views[this.active]!.scroll = 0;
    this.redraw();
  }

  // ---- seleksi teks ----

  /** True bila ada seleksi aktif (sedang dipilih atau sudah dipilih). */
  get hasSelection(): boolean {
    return this.sel !== undefined;
  }

  /**
   * Mulai seleksi pada sel layar (`x`,`y`; 1-based). Koordinat di luar area
   * konten diabaikan (header/prompt/footer/sidebar tidak bisa dipilih).
   */
  beginSelection(x: number, y: number): void {
    const row = y - this.lastContentTop;
    const col = x - this.lastContentLeft;
    if (row < 0 || row >= this.lastContentRows || col < 0 || col >= this.lastContentWidth) {
      this.clearSelection();
      return;
    }
    const line = this.lastStart + row;
    this.sel = { aLine: line, aCol: col, fLine: line, fCol: col };
    this.selecting = true;
    this.setNotice(undefined);
    this.redraw();
  }

  /** Perbarui ujung seleksi selama tombol digeser (mode 1002). */
  updateSelection(x: number, y: number): void {
    if (!this.sel || !this.selecting) return;
    const row = Math.max(
      0,
      Math.min(y - this.lastContentTop, Math.max(0, this.lastContentRows - 1)),
    );
    const col = Math.max(
      0,
      Math.min(x - this.lastContentLeft, Math.max(0, this.lastContentWidth - 1)),
    );
    this.sel.fLine = this.lastStart + row;
    this.sel.fCol = col;
    this.redraw();
  }

  /**
   * Akhiri seleksi: salin teks terpilih ke clipboard lewat OSC 52. Klik tanpa
   * geser (seleksi satu sel / kosong) dianggap bukan seleksi.
   */
  endSelection(): void {
    if (!this.sel || !this.selecting) return;
    this.selecting = false;
    const { aLine, aCol, fLine, fCol } = this.sel;
    if (aLine === fLine && aCol === fCol) {
      this.clearSelection();
      return;
    }
    const text = this.selectedText();
    if (text.length === 0) {
      this.clearSelection();
      return;
    }
    this.copyToClipboard(text);
    this.setNotice(`✓ ${text.length} karakter disalin`);
    this.redraw();
  }

  /** Buang seleksi (mis. saat pengguna mengetik). */
  clearSelection(): void {
    if (!this.sel) return;
    this.sel = undefined;
    this.selecting = false;
    this.redraw();
  }

  /** Teks polos dari rentang seleksi saat ini (dinormalisasi atas→bawah). */
  private selectedText(): string {
    const sel = this.sel;
    if (!sel) return "";
    let { aLine, aCol, fLine, fCol } = sel;
    if (fLine < aLine || (fLine === aLine && fCol < aCol)) {
      [aLine, fLine] = [fLine, aLine];
      [aCol, fCol] = [fCol, aCol];
    }
    const out: string[] = [];
    for (let li = aLine; li <= fLine; li += 1) {
      const line = this.lastAll[li];
      if (line === undefined) continue;
      const width = visibleWidth(line);
      const from = li === aLine ? aCol : 0;
      const last = Math.max(0, width - 1);
      const to = li === fLine ? Math.min(fCol, last) : last;
      if (to < from) continue;
      out.push(sliceByColumns(line, from, to));
    }
    return out.join("\n");
  }

  /** Tulis teks ke clipboard terminal (OSC 52, dibungkus untuk tmux/screen). */
  private copyToClipboard(text: string): void {
    if (text.length === 0) return;
    let seq = osc52Sequence(text);
    if (seq.length > OSC52_MAX_BYTES) return; // terlalu panjang; jangan kirim
    seq = wrapForMultiplexer(seq);
    this.write(seq);
  }

  /** Setel pesan sementara (mis. "disalin"); otomatis hilang setelah 2,5 detik. */
  private setNotice(text?: string): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.notice = text;
    if (text) {
      this.noticeTimer = setTimeout(() => {
        this.notice = undefined;
        this.noticeTimer = undefined;
        this.redraw();
      }, 2500);
      (this.noticeTimer as { unref?: () => void }).unref?.();
    }
  }

  viewForward(): string {
    if (this.views.length <= 1) return this.currentViewId();
    this.active = (this.active + 1) % this.views.length;
    this.redraw();
    return this.currentViewId();
  }

  viewBack(): string {
    if (this.views.length <= 1) return this.currentViewId();
    this.active = (this.active - 1 + this.views.length) % this.views.length;
    this.redraw();
    return this.currentViewId();
  }

  activateMainView(): void {
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    this.active = this.views.indexOf(main);
    this.redraw();
  }

  openSubtaskView(label: string): string {
    const id = `sub:${Date.now().toString(36)}`;
    this.views.push({ id, name: label, main: false, lines: [], scroll: 0 });
    this.active = this.views.length - 1;
    this.redraw();
    return id;
  }

  closeSubtaskView(id: string): void {
    const idx = this.views.findIndex((v) => v.id === id);
    if (idx === -1) return;
    this.views.splice(idx, 1);
    if (this.active >= this.views.length) this.active = this.views.length - 1;
    if (!this.views[this.active]?.main) {
      const main = this.views.find((v) => v.main);
      if (main) this.active = this.views.indexOf(main);
    }
    this.redraw();
  }

  get activeViewId(): string {
    return this.currentViewId();
  }

  currentViewId(): string {
    return this.views[this.active]!.id;
  }

  viewCount(): number {
    return this.views.length;
  }

  clearView(): void {
    this.views[this.active]!.lines = [];
    this.views[this.active]!.scroll = 0;
    this.views[this.active]!.open = undefined;
    this.redraw();
  }

  // ---- status ----

  setStatus(partial: Partial<ScreenStatus>, redraw = true): void {
    this.status = { ...this.status, ...partial };
    if (redraw) this.redraw();
  }

  setBusy(busy: boolean): void {
    this.status.busy = busy;
    if (busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerTick += 1;
        this.redraw();
      }, 120);
    } else if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.redraw();
  }

  // ---- render ----

  private cols(): number {
    const c = this.stdout.columns;
    return c && c > 0 ? c : DEFAULT_COLS;
  }

  private rows(): number {
    const r = this.stdout.rows;
    return r && r > 0 ? r : DEFAULT_ROWS;
  }

  private menuVisibleRows(): number {
    return layoutMetrics(this.cols(), this.rows()).menuRows;
  }

  redraw(): void {
    if (!this.started) return;
    // Draw synchronously to avoid timing issues in non-interactive captures
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = undefined;
    }
    this.draw();
  }

  private draw(): void {
    if (!this.started) return;
    const cols = this.cols();
    const rows = this.rows();
    if (this.overlay) {
      const body = `\u001b[2J\u001b[H${this.renderOverlay(cols, rows)}`;
      this.write(this.frame(body));
      return;
    }
    const body = this.home ? this.renderHome(cols, rows) : this.renderSession(cols, rows);
    this.write(this.frame(`\u001b[2J\u001b[H${body}`));
  }

  /** Bungkus satu frame: sinkronisasi output agar resize tidak berkedip. */
  private frame(body: string): string {
    return `\u001b[?2026h${bg(this.palette.bg, body, this.colorLevel)}\u001b[0m\u001b[?2026l`;
  }

  private renderHome(cols: number, rows: number): string {
    const metrics = layoutMetrics(cols, rows);
    const palette = this.palette;
    const pad = metrics.paddingX;
    const boxWidth = Math.max(8, Math.min(72, cols - pad * 2));
    const left = Math.max(0, Math.floor((cols - boxWidth) / 2));
    const prompt = this.renderPrompt(boxWidth, metrics);
    const menu = this.renderMenu(boxWidth, metrics);

    const place = (line: string): string => fitLine(" ".repeat(left) + line, cols);
    const build = (logoLines: string[]): { lines: string[]; promptStart: number } => {
      const lines: string[] = [];
      for (const line of logoLines) lines.push(centerLine(line, cols));
      if (logoLines.length > 0) lines.push(" ".repeat(cols));
      for (const line of menu) lines.push(place(line));
      const promptStart = lines.length;
      for (const line of prompt.lines) lines.push(place(line));
      if (!metrics.hideTip) {
        lines.push(" ".repeat(cols));
        const hintText =
          cols < 60
            ? "tab mode · / perintah · @ file"
            : "tab mode/lengkapi · / perintah · @ file · ! shell";
        const hint = fg(palette.dim, hintText, this.colorLevel);
        lines.push(place(rightAlign(hint, boxWidth)));
        const tipText =
          cols < 60 ? " tip: /skills" : " tip: ketik /skills untuk melihat skill terpasang";
        const tip =
          fg(palette.tip, "●", this.colorLevel) + fg(palette.muted, tipText, this.colorLevel);
        lines.push(centerLine(tip, cols));
      }
      return { lines, promptStart };
    };

    let built = build(logoNeX({ cols, level: this.colorLevel, palette }));
    const maxRows = Math.max(1, rows - 1);
    if (built.lines.length > maxRows) {
      built = build(logoNeX({ cols: 59, level: this.colorLevel, palette }));
    }
    if (built.lines.length > maxRows) {
      built = build([]);
    }
    if (built.lines.length > maxRows) {
      built = {
        lines: prompt.lines.map((line) => place(line)),
        promptStart: 0,
      };
    }

    const top = centerPad(maxRows, built.lines.length);
    const out: string[] = [];
    for (let i = 0; i < built.lines.length; i += 1) {
      out.push(`\u001b[${top + i + 1};1H${fitLine(built.lines[i]!, cols)}`);
    }
    if (rows > 1) out.push(`\u001b[${rows};1H${this.renderFooterLine(cols, metrics)}`);

    if (this.input.active || this.input.text.length > 0) {
      const row = top + built.promptStart + prompt.inputIndex + 1;
      const col = left + prompt.cursorCol + 1;
      out.push(`\u001b[${clamp(row, 1, rows)};${clamp(col, 1, cols)}H`);
    }
    return out.join("");
  }

  private renderSession(cols: number, rows: number): string {
    const metrics = layoutMetrics(cols, rows);
    const palette = this.palette;
    const pad = metrics.paddingX;
    const mainWidth = Math.max(1, contentWidth(cols, metrics));
    const prompt = this.renderPrompt(mainWidth, metrics);
    const menu = this.renderMenu(mainWidth, metrics);
    const headerHeight = metrics.hideHeader ? 0 : 1;
    const footerHeight = rows > 1 ? 1 : 0;
    const promptHeight = menu.length + prompt.lines.length;
    const promptTop = Math.max(headerHeight, rows - footerHeight - promptHeight);
    const contentTop = headerHeight;
    const contentRows = Math.max(0, promptTop - contentTop);

    const view = this.views[this.active] ?? this.views[0]!;
    const all = this.wrappedAll(view, mainWidth);
    const maxScroll = Math.max(0, all.length - contentRows);
    const scroll = Math.min(view.scroll, maxScroll);
    view.scroll = scroll;
    const end = all.length - scroll;
    const start = Math.max(0, end - contentRows);
    const slice = all.slice(start, end);

    this.lastAll = all;
    this.lastStart = start;
    this.lastContentRows = contentRows;
    this.lastContentTop = contentTop + 1;
    this.lastContentLeft = pad + 1;
    this.lastContentWidth = mainWidth;

    const out: string[] = [];
    if (!metrics.hideHeader && mainWidth >= 3) {
      const title = view.main
        ? this.sessionTitle
          ? `# ${this.sessionTitle}`
          : "# sesi baru"
        : `# ${view.name}`;
      const headerWidth = mainWidth - 2;
      const header =
        fg(palette.border, "│", this.colorLevel) +
        " " +
        formatHeader(title, this.contextPercent, headerWidth, {
          palette,
          level: this.colorLevel,
        });
      out.push(`\u001b[1;1H${fitLine(" ".repeat(pad) + header, cols)}`);
    }

    for (let i = 0; i < slice.length; i += 1) {
      const row = contentTop + i + 1;
      const line = this.applySelection(start + i, slice[i]!);
      out.push(`\u001b[${row};${pad + 1}H${fitLine(line, mainWidth)}`);
    }

    let promptRow = promptTop;
    for (const line of menu) {
      out.push(`\u001b[${promptRow + 1};${pad + 1}H${fitLine(line, mainWidth)}`);
      promptRow += 1;
    }
    for (const line of prompt.lines) {
      out.push(`\u001b[${promptRow + 1};${pad + 1}H${fitLine(line, mainWidth)}`);
      promptRow += 1;
    }

    if (metrics.sidebar) {
      const sideLeft = pad + mainWidth + 2;
      const sideHeight = Math.max(0, rows - footerHeight);
      this.lastSidebarLeft = sideLeft;
      this.lastSidebarWidth = metrics.sidebarWidth;
      const sideLines = this.renderSidebar(metrics.sidebarWidth, sideHeight, metrics);
      this.sidebarPluginHits = this.sidebarPluginHits.filter((hit) => hit.line < sideLines.length);
      for (let i = 0; i < sideLines.length; i += 1) {
        out.push(`\u001b[${i + 1};${sideLeft}H${fitLine(sideLines[i]!, metrics.sidebarWidth)}`);
      }
    }

    if (footerHeight) out.push(`\u001b[${rows};1H${this.renderFooterLine(cols, metrics)}`);

    if (this.input.active || this.input.text.length > 0) {
      const row = promptTop + menu.length + prompt.inputIndex + 1;
      const col = pad + prompt.cursorCol + 1;
      out.push(`\u001b[${clamp(row, 1, rows)};${clamp(col, 1, cols)}H`);
    }
    return out.join("");
  }

  /** Kotak prompt: latar panel + garis aksen 1 kolom di kiri + meta. */
  private renderPrompt(width: number, metrics: LayoutMetrics): PromptRender {
    const palette = this.palette;
    const level = this.colorLevel;
    const boxWidth = Math.max(6, Math.floor(width));
    const inner = Math.max(1, boxWidth - 3);
    const accent = modeAccent(this.status.mode, palette);
    const prompt = this.input.prompt || "› ";
    const promptWidth = visibleWidth(prompt);
    const text = this.input.mask ? "*".repeat(this.input.text.length) : this.input.text;
    const caret = Math.min(this.input.caret, text.length);
    const available = Math.max(1, inner - promptWidth - 2);
    const layout = layoutInput(text, caret, available);

    let content: string;
    let cursorCol: number;
    if (this.home && text.length === 0) {
      content = fg(palette.muted, prompt, level) + fg(palette.dim, "tanya apa saja…", level);
      cursorCol = 2 + promptWidth;
    } else {
      const leftMark = layout.clippedLeft ? fg(palette.dim, "‹", level) : "";
      const rightMark = layout.clippedRight ? fg(palette.dim, "›", level) : "";
      const cursor = bg(accent, fg(palette.bg, layout.at, level), level);
      content =
        fg(palette.muted, prompt, level) +
        leftMark +
        layout.before +
        cursor +
        layout.after +
        rightMark;
      cursorCol = 2 + promptWidth + (layout.clippedLeft ? 1 : 0) + visibleWidth(layout.before);
    }

    let meta = formatPromptMeta(
      { mode: this.status.mode, model: this.status.model, provider: this.status.provider },
      inner,
      {
        showProvider: metrics.showProvider,
        palette,
        level,
      },
    );
    if (this.status.busy) {
      const spinner = spinnerFrame(this.spinnerTick, SPINNER, accent, level);
      meta = alignSides(meta, spinner, inner);
    }

    return {
      lines: [
        this.promptBoxLine(content, boxWidth, inner, accent),
        this.promptBoxLine(meta, boxWidth, inner, accent),
      ],
      inputIndex: 0,
      cursorCol,
    };
  }

  private promptBoxLine(content: string, width: number, inner: number, accent: string): string {
    const palette = this.palette;
    const line = fg(accent, "█", this.colorLevel) + " " + fitLine(content, inner) + " ";
    return bg(palette.panel, fitLine(line, width), this.colorLevel);
  }

  private renderMenu(width: number, metrics: LayoutMetrics): string[] {
    const menu = this.menu;
    if (!menu || menu.matches.length === 0) return [];
    const palette = this.palette;
    const level = this.colorLevel;
    const accent = modeAccent(this.status.mode, palette);
    const total = menu.matches.length;
    const visible = Math.min(total, metrics.menuRows);
    const offset = Math.max(0, Math.min(menu.offset, Math.max(0, total - visible)));
    const lines: string[] = [];
    for (let i = 0; i < visible; i += 1) {
      const index = offset + i;
      const text = menu.matches[index] ?? "";
      const desc = metrics.menuDescriptions ? (menu.descriptions?.[index] ?? "") : "";
      const label = clipLine(text, Math.max(1, width - 4));
      const labelWidth = visibleWidth(label);
      const descSpace = Math.max(0, width - 3 - labelWidth);
      const description = desc && descSpace >= 6 ? truncateTo(desc, descSpace - 1) : "";
      const gap = Math.max(1, width - 2 - labelWidth - visibleWidth(description));
      const padded = fitLine(` ${label}${" ".repeat(gap)}${description} `, width);
      lines.push(
        index === menu.selected
          ? bg(accent, fg(palette.bg, padded, level), level)
          : bg(palette.panel, fg(palette.muted, padded, level), level),
      );
    }
    return lines;
  }

  private renderSidebar(width: number, height: number, metrics: LayoutMetrics): string[] {
    void metrics;
    if (width <= 1 || height <= 0) return [];
    const palette = this.palette;
    const level = this.colorLevel;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    const blank = (): void => {
      lines.push(fg(palette.border, "│", level) + " ".repeat(Math.max(0, width - 1)));
    };
    const push = (content: string): void => {
      lines.push(fg(palette.border, "│", level) + " " + fitLine(content, inner));
    };

    push(fg(palette.muted, "sesi", level));
    const view = this.views[this.active] ?? this.views[0]!;
    const title = view.main ? this.sessionTitle || "sesi baru" : view.name;
    for (const line of wrapLine(title, inner).slice(0, 3)) {
      push(fg(palette.text, line, level));
    }
    blank();

    push(fg(palette.muted, "plugin", level));
    const pluginHits: Array<{ line: number; name: string }> = [];
    if (this.sidebar.plugins.length === 0) {
      push(fg(palette.dim, "belum ada", level));
    } else {
      for (const plugin of this.sidebar.plugins) {
        const marker = plugin.enabled ? (plugin.connected ? "●" : "◐") : "○";
        const markerColor = plugin.enabled
          ? plugin.connected
            ? palette.success
            : palette.error
          : palette.dim;
        const name = clipLine(plugin.name, Math.max(1, inner - 2));
        push(alignSides(fg(palette.text, name, level), fg(markerColor, marker, level), inner));
        pluginHits.push({ line: lines.length - 1, name: plugin.name });
      }
    }
    this.sidebarPluginHits = pluginHits;
    blank();

    push(fg(palette.muted, "file diubah", level));
    if (this.sidebar.files.length === 0) {
      push(fg(palette.dim, "belum ada", level));
    } else {
      for (const file of this.sidebar.files) {
        const stats = `${fg(palette.success, `+${file.added}`, level)} ${fg(
          palette.error,
          `-${file.removed}`,
          level,
        )}`;
        const statsWidth = visibleWidth(`+${file.added} -${file.removed}`);
        const name = truncateMiddle(file.path, Math.max(1, inner - statsWidth - 1));
        push(alignSides(fg(palette.text, name, level), stats, inner));
      }
    }

    return lines.slice(0, height);
  }

  private renderFooterLine(cols: number, metrics: LayoutMetrics): string {
    const info = this.notice ? { ...this.footer, folder: this.notice, branch: "" } : this.footer;
    const footer = formatFooter(info, cols, {
      compact: metrics.tier === "narrow",
      paddingX: metrics.paddingX,
      palette: this.palette,
      level: this.colorLevel,
    });
    return fitLine(" ".repeat(metrics.paddingX) + footer + " ".repeat(metrics.paddingX), cols);
  }

  /** Semua baris view (sudah difilter + dibungkus + diwarnai), dari atas ke bawah. */
  private wrappedAll(view: View, cols: number): string[] {
    const wrapped: string[] = [];
    for (const line of view.lines) {
      if (line.kind === "think" && !this.showThinking) continue;
      if (line.kind === "tool-out" && !this.showToolOutput) continue;
      if (line.kind === "divider") {
        wrapped.push("");
        continue;
      }
      if (line.kind === "user") {
        wrapped.push(...this.userBlock(line.text, cols));
        continue;
      }
      if (line.kind === "tool-out") {
        wrapped.push(...this.toolOutputBlock(line.text, cols));
        continue;
      }
      if (line.kind === "diff-add" || line.kind === "diff-del" || line.kind === "diff-context") {
        wrapped.push(...this.diffBlock(line, cols));
        continue;
      }
      if (line.kind === "diff-hunk") {
        for (const w of wrapAnsi(line.text, cols)) {
          wrapped.push(fg(this.palette.tip, w.line, this.colorLevel));
        }
        continue;
      }
      for (const w of wrapAnsi(line.text, cols)) {
        wrapped.push(this.paint(line.kind, w.line, line));
      }
    }
    return wrapped;
  }

  /** Panel pesan pengguna: latar panel + aksen mode 1 kolom di kiri. */
  private userBlock(text: string, cols: number): string[] {
    const palette = this.palette;
    const level = this.colorLevel;
    const accent = modeAccent(this.status.mode, palette);
    const inner = Math.max(1, cols - 2);
    const parts = wrapAnsi(text, inner).map((part) => part.line);
    if (parts.length === 0) parts.push("");
    const widest = Math.max(...parts.map((part) => visibleWidth(part)));
    const width = Math.max(8, Math.min(cols, widest + 2));
    return parts.map((part) =>
      bg(
        palette.panel,
        fg(accent, "█", level) + " " + fitLine(fg(palette.text, part, level), width - 2),
        level,
      ),
    );
  }

  /** Panel output tool: latar panel, teks redup, selebar area konten. */
  private toolOutputBlock(text: string, cols: number): string[] {
    const palette = this.palette;
    const level = this.colorLevel;
    const inner = Math.max(1, cols - 2);
    const parts = wrapAnsi(text, inner).map((part) => part.line);
    if (parts.length === 0) parts.push("");
    return parts.map((part) =>
      bg(palette.panel, fitLine(" " + fg(palette.muted, part, level), cols), level),
    );
  }

  /** Satu baris diff dengan nomor baris (kecuali terminal sempit) + latar. */
  private diffBlock(line: Line, cols: number): string[] {
    const palette = this.palette;
    const level = this.colorLevel;
    const narrow = cols < 60;
    const marker = line.kind === "diff-add" ? "+" : line.kind === "diff-del" ? "-" : " ";
    const number = narrow || line.num === undefined ? "" : `${String(line.num).padStart(4)} `;
    const prefix = `${number}${marker} `;
    const bgColor =
      line.kind === "diff-add"
        ? palette.diffAddBg
        : line.kind === "diff-del"
          ? palette.diffDelBg
          : undefined;
    const fgColor =
      line.kind === "diff-add"
        ? palette.success
        : line.kind === "diff-del"
          ? palette.error
          : palette.muted;
    const bodyWidth = Math.max(1, cols - visibleWidth(prefix));
    const parts = wrapAnsi(line.text, bodyWidth).map((part) => part.line);
    if (parts.length === 0) parts.push("");
    return parts.map((part, index) => {
      const head = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
      const content = fitLine(head + fg(fgColor, part, level), cols);
      return bgColor ? bg(bgColor, content, level) : content;
    });
  }

  private paint(kind: LineKind, text: string, line?: Line): string {
    const palette = this.palette;
    const level = this.colorLevel;
    switch (kind) {
      case "think":
        return fg(palette.dim, text, level);
      case "tool": {
        const command = text.startsWith("$ ") ? text.slice(2) : text;
        const prefix = text.startsWith("$ ") ? "$ " : "";
        let out = fg(palette.tool, prefix, level) + fg(palette.muted, command, level);
        out += this.statusSuffix(line);
        return out;
      }
      case "edit": {
        let out =
          fg(palette.dim, "← ", level) +
          fg(palette.text, "Edit ", level) +
          fg(palette.tool, text, level);
        out += this.statusSuffix(line);
        return out;
      }
      case "info":
        return fg(palette.muted, text, level);
      case "warn":
        return fg(palette.tip, text, level);
      case "error":
        return fg(palette.error, text, level);
      case "user":
        return fg(palette.text, text, level);
      case "text":
        return fg(palette.text, text, level);
      default:
        return text;
    }
  }

  private statusSuffix(line?: Line): string {
    if (!line) return "";
    const palette = this.palette;
    const level = this.colorLevel;
    if (line.running) {
      const blink = this.spinnerTick % 2 === 0 ? "▌" : " ";
      return " " + fg(modeAccent(this.status.mode, palette), blink, level);
    }
    if (!line.status) return "";
    if (line.status === "ok") return " " + fg(palette.success, "ok", level);
    if (line.status === "denied") return " " + fg(palette.tip, "ditolak", level);
    return " " + fg(palette.error, "gagal", level);
  }

  /** Sorot bagian baris yang termasuk seleksi (bila ada). */
  private applySelection(lineIndex: number, line: string): string {
    const sel = this.sel;
    if (!sel) return line;
    let { aLine, aCol, fLine, fCol } = sel;
    if (fLine < aLine || (fLine === aLine && fCol < aCol)) {
      [aLine, fLine] = [fLine, aLine];
      [aCol, fCol] = [fCol, aCol];
    }
    if (lineIndex < aLine || lineIndex > fLine) return line;
    const width = visibleWidth(line);
    const c0 = lineIndex === aLine ? aCol : 0;
    const last = Math.max(0, width - 1);
    const c1 = lineIndex === fLine ? Math.min(fCol, last) : last;
    if (c1 < c0) return line;
    return highlightColumns(line, c0, c1);
  }

  private renderOverlay(cols: number, rows: number): string {
    const o = this.overlay;
    if (!o) return "";
    const palette = this.palette;
    const level = this.colorLevel;
    const accent = modeAccent(this.status.mode, palette);
    const inner = Math.max(1, cols - 4);
    const list = o.list;

    // Isi: daftar item (satu baris per item) atau body viewer yang dibungkus.
    const body: string[] = [];
    if (!list) {
      for (const line of o.body) {
        for (const w of wrapAnsi(fg(palette.muted, line, level), inner)) body.push(w.line);
      }
    }
    const listVisible = list ? Math.min(list.items.length, MAX_OVERLAY_LIST) : 0;
    const contentLen = list ? listVisible : body.length;

    let height = contentLen + 3;
    if (o.secret) height += 1;
    height = Math.max(4, Math.min(height, Math.max(4, rows - 2)));
    const top = Math.max(1, Math.floor((rows - height) / 2));

    const out: string[] = [];
    for (let i = 0; i < height; i += 1) {
      out.push(`\u001b[${top + i + 1};1H${" ".repeat(cols)}`);
    }
    out.push(`\u001b[${top + 1};1H${fg(accent, truncateTo(o.title, cols - 4), level)}`);

    const bodyRows = Math.max(0, height - 3 - (o.secret ? 1 : 0));
    if (list) {
      const n = list.items.length;
      // Jendela efektif dibatasi tinggi yang benar-benar tersedia, lalu digeser
      // agar item terpilih selalu terlihat (walau layar pendek).
      const visible = Math.max(1, Math.min(listVisible, Math.max(1, bodyRows)));
      let offset = Math.max(0, Math.min(list.offset, Math.max(0, n - visible)));
      if (list.selected < offset) offset = list.selected;
      else if (list.selected >= offset + visible) offset = list.selected - visible + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, n - visible)));
      list.offset = offset;
      for (let i = 0; i < Math.min(visible, bodyRows); i += 1) {
        const idx = offset + i;
        const selected = idx === list.selected;
        const text = truncateTo((selected ? "› " : "  ") + list.items[idx]!, inner);
        const styled = selected
          ? bg(accent, fg(palette.bg, fitLine(text, inner), level), level)
          : fg(palette.text, text, level);
        out.push(`\u001b[${top + i + 2};3H${fitLine(styled, inner)}`);
      }
    } else {
      // Viewer: klem offset gulir ke rentang valid lalu tampilkan jendelanya.
      const maxTop = Math.max(0, body.length - bodyRows);
      const scrollTop = Math.max(0, Math.min(o.scrollTop ?? 0, maxTop));
      o.scrollTop = scrollTop;
      for (let i = 0; i < Math.min(bodyRows, body.length - scrollTop); i += 1) {
        out.push(`\u001b[${top + i + 2};3H${fitLine(body[scrollTop + i]!, inner)}`);
      }
    }

    const footRow = top + height;
    if (o.secret) {
      const masked = o.secret.masked !== false;
      const shown = masked ? "*".repeat(this.overlayInput.length) : this.overlayInput;
      out.push(`\u001b[${footRow};3H${fg(palette.dim, o.secret.label + ": ", level)}${shown}`);
    } else if (list) {
      const hint = list.hint ?? "↑/↓ pilih · Enter pilih · Esc batal";
      out.push(`\u001b[${footRow};3H${fg(palette.dim, truncateTo(hint, cols - 6), level)}`);
    } else {
      const keys = o.keys.map(([k, label]) => `${fg(palette.text, k, level)} ${label}`).join("   ");
      out.push(`\u001b[${footRow};3H${truncateTo(keys, cols - 6)}`);
    }
    return out.join("");
  }
}

function rightAlign(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  const visible = visibleWidth(text);
  if (visible >= w) return fitLine(text, w);
  return " ".repeat(w - visible) + text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface InputLayout {
  /** Teks sebelum kursor yang terlihat. */
  before: string;
  /** Karakter pada posisi kursor (spasi bila kursor di ujung). */
  at: string;
  /** Teks setelah kursor yang terlihat. */
  after: string;
  /** Ada bagian terpotong di kiri kursor. */
  clippedLeft: boolean;
  /** Ada bagian terpotong di kanan jendela. */
  clippedRight: boolean;
}

/**
 * Hitung jendela horizontal untuk baris input agar kursor selalu terlihat saat
 * teks lebih panjang dari `width` (input panjang tidak lagi keluar layar).
 * Murni supaya mudah diuji.
 */
export function layoutInput(text: string, caret: number, width: number): InputLayout {
  const w = Math.max(1, width);
  const len = text.length;
  const pos = Math.max(0, Math.min(caret, len));
  // Sisakan sampai 2 kolom untuk penanda potong '‹'/'›'.
  const inner = Math.max(1, w - 2);
  let start = Math.max(0, pos - inner + 1);
  if (start + inner > len) start = Math.max(0, len - inner);
  const end = Math.min(len, start + inner);
  return {
    before: text.slice(start, pos),
    at: text.slice(pos, pos + 1) || " ",
    after: text.slice(pos + 1, end),
    clippedLeft: start > 0,
    clippedRight: end < len,
  };
}
