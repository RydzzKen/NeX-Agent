import type { Writable } from "node:stream";
import readline from "node:readline";
import { color } from "../../util/color.js";
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

/** Jenis baris; dipakai untuk pewarnaan dan filter (thinking). */
export type LineKind =
  | "text"
  | "think"
  | "step"
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

export interface OverlayContent {
  title: string;
  body: string[];
  /** Opsi tombol, mis. `[["y","Izinkan"],["n","Tolak"]]` (Enter = yang pertama). */
  keys: Array<[string, string]>;
  /** Mode input rahasia (masked) — mengesampingkan `keys`. */
  secret?: { label: string };
}

interface View {
  id: string;
  name: string;
  main: boolean;
  lines: Array<{ kind: LineKind; text: string }>;
  /** Baris tergulung ke atas dari dasar konten (0 = dasar). */
  scroll: number;
  /** Jenis baris terakhir yang masih "terbuka" untuk sambungan streaming. */
  open?: LineKind;
}

export interface ScreenOptions {
  stdin: NodeJS.ReadStream;
  stdout: Writable & { columns?: number; rows?: number; on?: (e: string, cb: () => void) => void };
  status?: Partial<ScreenStatus>;
  showThinking?: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_MENU = 6;
const MAX_LINES = 5000; // Batasi scrollback biar nggak OOM

type WriteFn = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

/** Lut warna per jenis baris. */
function paint(kind: LineKind, text: string): string {
  switch (kind) {
    case "think":
      return color.dim(text);
    case "info":
      return color.cyan(text);
    case "warn":
      return color.yellow(text);
    case "error":
      return color.red(text);
    case "user":
      return color.bold(color.cyan(text));
    default:
      return text;
  }
}

/**
 * Layar TUI: alternate screen, raw-mode input, intercept `process.stdout.write`
 * agar semua tulis langsung dari app masuk ke frame, multi-view (utama +
 * subagent), input line, overlay modal, dan status bar.
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

  private input = { text: "", caret: 0, mask: false, active: false, prompt: "" };
  private menu?: { token: string; matches: string[]; selected: number; offset: number };
  private overlay?: OverlayContent;
  private overlayInput = "";

  private keyHandler?: (key: Key) => void;
  private drawTimer?: ReturnType<typeof setTimeout>;
  private spinnerTick = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;

  // Seleksi mouse (dalam indeks baris-bungkus `all` + kolom tampilan 0-based).
  private sel?: { aLine: number; aCol: number; fLine: number; fCol: number };
  private selecting = false;
  private lastAll: string[] = [];
  private lastStart = 0;
  private lastContentRows = 0;
  private notice?: string;
  private noticeTimer?: ReturnType<typeof setTimeout>;

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
      process.stdout.on?.("resize", () => this.redraw());
    }
    if (this.emitKeypress) {
      readline.emitKeypressEvents(this.stdin);
      this.stdin.setRawMode(true);
      this.stdin.on("keypress", (str: string, key?: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }) => {
        this.keyHandler?.(normalizeKey(key ?? { sequence: str }));
      });
    }
    const main = this.views.find((v) => v.main) ?? this.views[0]!;
    main.lines.push({ kind: "info", text: color.brightGreen("TUI siap") + " " + color.cyan("— Ketik pesan atau /help. Gunakan Ctrl+X ↑/↓ untuk ganti view, Shift+Tab ganti mode.") });
    if (main.lines.length > MAX_LINES) {
      main.lines.splice(0, main.lines.length - MAX_LINES);
    }
    this.scrollToBottom();
    this.redraw();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.drawTimer) clearTimeout(this.drawTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.spinnerTimer = undefined;
    this.drawTimer = undefined;
    this.noticeTimer = undefined;
    this.sel = undefined;
    this.selecting = false;
    if (this.emitKeypress) {
      this.stdin.removeAllListeners("keypress");
      this.stdin.setRawMode(false);
    }
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
  emitKey(key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }): void {
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

  setMenu(token: string, matches: string[]): void {
    this.menu = matches.length > 0 ? { token, matches, selected: 0, offset: 0 } : undefined;
    this.redraw();
  }

  clearMenu(): void {
    this.menu = undefined;
    this.redraw();
  }

  menuSelect(delta: number): void {
    if (!this.menu || this.menu.matches.length === 0) return;
    const n = this.menu.matches.length;
    const visible = Math.min(n, MAX_MENU);
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

  getOverlayFirstKey(): string {
    return this.overlay?.keys[0]?.[0] ?? "y";
  }

  // ---- konten & view ----

  append(kind: LineKind, text: string): void {
    const view = this.views[this.active]!;
    const parts = String(text).split("\n");
    for (const raw of parts) {
      view.lines.push({ kind, text: kind === "raw" ? raw : paint(kind, raw) });
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
      last.text += kind === "raw" ? first : paint(kind, first);
    } else {
      view.lines.push({ kind, text: kind === "raw" ? first : paint(kind, first) });
    }
    for (const p of parts) view.lines.push({ kind, text: kind === "raw" ? p : paint(kind, p) });
    view.open = kind;
    if (view.lines.length > MAX_LINES) {
      view.lines.splice(0, view.lines.length - MAX_LINES);
    }
    this.follow(view, (continued ? 0 : 1) + (partCount - 1));
    this.redraw();
  }

  /** Tutup baris streaming aktif: blok berikutnya mulai di baris baru. */
  endStream(): void {
    const view = this.views[this.active]!;
    view.open = undefined;
  }

  /** Saluran untuk tulis langsung ke stdout (intercept) — selalu ke view utama. */
  appendRaw(text: string): void {
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
   * konten diabaikan (baris status/hint/input tidak bisa dipilih).
   */
  beginSelection(x: number, y: number): void {
    if (y < 1 || y > this.lastContentRows) {
      this.clearSelection();
      return;
    }
    const col = Math.max(0, x - 1);
    const line = this.lastStart + (y - 1);
    this.sel = { aLine: line, aCol: col, fLine: line, fCol: col };
    this.selecting = true;
    this.setNotice(undefined);
    this.redraw();
  }

  /** Perbarui ujung seleksi selama tombol digeser (mode 1002). */
  updateSelection(x: number, y: number): void {
    if (!this.sel || !this.selecting) return;
    const yy = Math.max(1, Math.min(y, Math.max(1, this.lastContentRows)));
    this.sel.fLine = this.lastStart + (yy - 1);
    this.sel.fCol = Math.max(0, x - 1);
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

  setStatus(partial: Partial<ScreenStatus>): void {
    this.status = { ...this.status, ...partial };
    this.redraw();
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
    const cols = this.cols();
    const rows = this.rows();
    const view = this.views[this.active]!;

    if (this.overlay) {
      this.write("\u001b[40m\u001b[2J\u001b[H" + this.renderOverlay(cols, rows) + "\u001b[0m");
      return;
    }

    const all = this.wrappedAll(view, cols);
    const menuHeight = this.menu ? Math.min(this.menu.matches.length, MAX_MENU) : 0;
    const inputRow = rows - 1;
    const hintRow = inputRow - 1;
    const menuTop = hintRow - menuHeight;
    const statusRow = menuTop - 1;
    const contentRows = Math.max(1, statusRow); // baris konten di atas status
    const maxScroll = Math.max(0, all.length - contentRows);
    const sc = Math.min(view.scroll, maxScroll);
    view.scroll = sc; // jaga posisi tetap dalam rentang (mis. setelah Home/End)
    const end = all.length - sc;
    const start = Math.max(0, end - contentRows);
    const slice = all.slice(start, end);

    // Simpan tata letak supaya seleksi mouse (peristiwa sesudah draw) bisa
    // memetakan baris layar → baris konten.
    this.lastAll = all;
    this.lastStart = start;
    this.lastContentRows = contentRows;

    const buffer: string[] = ["\u001b[40m\u001b[2J\u001b[H"];
    for (let i = 0; i < slice.length; i += 1) {
      const line = this.applySelection(start + i, slice[i]!);
      buffer.push(padLine(truncateTo(line, cols), cols));
    }

    // Menu autocomplete tepat di atas input (jendela bergulir mengikuti pilihan).
    if (this.menu) {
      const total = this.menu.matches.length;
      const visible = Math.min(total, MAX_MENU);
      const offset = Math.max(0, Math.min(this.menu.offset, Math.max(0, total - visible)));
      const items = this.menu.matches.slice(offset, offset + visible);
      for (let i = 0; i < visible; i++) {
        const it = items[i]!;
        const styled = offset + i === this.menu.selected ? color.inverse(it) : color.dim(it);
        buffer.push(`\u001b[${menuTop + 1 + i};1H` + padLine(truncateTo(styled, cols), cols));
      }
    }

    // Status (mode/model/view/thinking) dan hint pada baris terpisah.
    buffer.push(`\u001b[${statusRow + 1};1H` + padLine(truncateTo(this.renderStatusLine(statusRow, cols), cols), cols));
    buffer.push(`\u001b[${hintRow + 1};1H` + padLine(truncateTo(this.hint(cols), cols), cols));

    const inputText = this.input.mask ? "*".repeat(this.input.text.length) : this.input.text;
    const caret = Math.min(this.input.caret, inputText.length);
    const promptW = visibleWidth(this.input.prompt);
    const avail = Math.max(1, cols - 2 - promptW);
    const layout = layoutInput(inputText, caret, avail);
    const markerLeft = layout.clippedLeft ? color.dim("‹") : "";
    const markerRight = layout.clippedRight ? color.dim("›") : "";
    const renderedInput = `${color.cyan(this.input.prompt)}${markerLeft}${layout.before}${color.inverse(layout.at)}${layout.after}${markerRight}`;
    const spinner = this.status.busy ? color.brightGreen(SPINNER[this.spinnerTick % SPINNER.length]!) : " ";
    buffer.push(`\u001b[${inputRow + 1};1H` + spinner + " " + padLine(truncateTo(renderedInput, cols - 2), cols - 2));

    // Kursor mengikuti jendela input (tetap terlihat walau input panjang).
    const caretCol = Math.min(
      2 + promptW + (layout.clippedLeft ? 1 : 0) + visibleWidth(layout.before) + 1,
      cols,
    );
    buffer.push(`\u001b[${inputRow + 1};${caretCol}H`);
    this.write(buffer.join("") + "\u001b[0m");
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

  /** Semua baris view (sudah difilter + dibungkus), dari atas ke bawah. */
  private wrappedAll(view: View, cols: number): string[] {
    const wrapped: string[] = [];
    for (const line of view.lines) {
      if (line.kind === "think" && !this.showThinking) continue;
      if (line.kind === "divider") {
        wrapped.push(color.dim("─".repeat(cols)));
        continue;
      }
      for (const w of wrapAnsi(line.text, cols)) wrapped.push(w.line);
    }
    return wrapped;
  }

  private renderStatusLine(_row: number, cols: number): string {
    const s = this.status;
    const mode = s.mode === "build" ? "BUILD" : "PLAN";
    const view = this.views[this.active]!.main ? "utama" : this.views[this.active]!.name;
    const thinking = this.showThinking
      ? color.brightGreen("thinking:on")
      : color.dim("thinking:off");
    const left = `${color.bold(color.yellow(mode))} ${s.model ? color.green(s.model) : ""}${s.provider ? color.cyan(`@${s.provider}`) : ""} · ${color.brightGreen(`view:${view}`)} · ${thinking}`;
    const right = s.busy ? color.cyan("bekerja…") : "";
    const full = left + (right ? "  " + right : "");
    return truncateTo(full, cols);
  }

  private hint(cols: number): string {
    if (this.notice) return color.brightGreen(truncateTo(this.notice, cols));
    const hints = [
      "roda/PgUp/PgDn gulir",
      "seret = pilih & salin",
      "↑/↓ riwayat input",
      "Ctrl+T thinking",
      "Shift+Tab mode",
      "Ctrl+C hentikan (2× keluar)",
    ].join("    ");
    return color.dim(truncateTo(hints, cols));
  }

  private renderOverlay(cols: number, rows: number): string {
    const o = this.overlay;
    if (!o) return "";
    const secret = o.secret !== undefined;
    const body: string[] = [];
    for (const line of o.body) for (const w of wrapAnsi(color.dim(line), cols - 4)) body.push(w.line);
    let height = 2 + body.length + 1;
    if (secret) height += 1;
    else height += 1;
    if (height > rows - 4) height = rows - 4;
    const top = Math.max(1, Math.floor((rows - height) / 2));
    const out: string[] = [];
    for (let i = 0; i < height; i++) out.push(`\u001b[${top + i + 1};1H` + " ".repeat(cols));
    out.push(`\u001b[${top + 1};1H` + color.bold(color.underline(o.title)));
    const maxBody = height - 3;
    for (let i = 0; i < Math.min(body.length, maxBody); i++) {
      out.push(`\u001b[${top + i + 2};3H` + padLine(body[i]!, cols - 4));
    }
    const footRow = top + height;
    if (secret) {
      const shown = "*".repeat(this.overlayInput.length);
      out.push(`\u001b[${footRow};3H` + color.dim(o.secret!.label + ": ") + shown);
    } else {
      const keys = o.keys.map(([k, label]) => color.bold(k) + " " + label).join("   ");
      out.push(`\u001b[${footRow};3H` + truncateTo(keys, cols - 6));
    }
    return out.join("");
  }
}

function padLine(text: string, width: number): string {
  const w = visibleWidth(stripAnsi(text));
  if (w >= width) return text;
  return text + " ".repeat(width - w);
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