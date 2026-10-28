import {
  decodeOtherKeys,
  decodeSgrMouse,
  isOtherKeysPartial,
  isSgrMousePartial,
  type Key,
  type SgrMouseEvent,
} from "../../util/ansi.js";
import { Screen } from "./screen.js";
import { TuiPrompter } from "./prompt.js";
import { TuiIO } from "./io.js";
import { displayFolder, readGitBranch } from "./status.js";
import { APP_VERSION } from "../../version.js";

export interface TuiPairOptions {
  commands: string[];
  descriptions?: Record<string, string>;
  cwd: string;
  initMode: string;
  initModel?: string;
  initProvider?: string;
  thinking?: boolean;
  markdown?: boolean;
  typewriter?: boolean;
  theme?: "opencode" | "mint";
}

/**
 * Pasangan input/output TUI plus layar. `ChatApp.create` membangun ini lalu
 * `attachTui` menghubungkan dispatcher tombol (overlay → input → global).
 */
export interface TuiPair {
  prompter: TuiPrompter;
  io: TuiIO;
  screen: Screen;
}

export interface TuiHooks {
  /** Ganti mode Plan/Build (default Tab; dapat diubah lewat config). */
  toggleMode: () => void;
  /** Buka panel detail sesi (default Ctrl+O). */
  details?: () => void;
  /** Keybind mode, mis. "tab" atau "ctrl+g". */
  modeKey?: string;
  /** Keybind panel detail, mis. "ctrl+o". */
  detailsKey?: string;
  /** Aktif/nonaktifkan plugin dari klik sidebar. */
  togglePlugin?: (name: string) => void;
}

/** Cocokkan key readline dengan binding sederhana seperti `ctrl+o`/`shift+tab`. */
export function matchesKeybinding(key: Key, binding: string): boolean {
  const parts = binding
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const namePart = parts.pop()!;
  const ctrl = parts.includes("ctrl");
  const meta = parts.includes("alt") || parts.includes("meta");
  const shift = parts.includes("shift");
  const aliases: Record<string, string> = {
    esc: "escape",
    enter: "return",
    return: "return",
    space: "space",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
  };
  const wanted = aliases[namePart] ?? namePart;
  const actual = (key.name ?? "").toLowerCase();
  if (actual !== wanted) return false;
  if ((key.ctrl === true) !== ctrl) return false;
  if ((key.meta === true) !== meta) return false;
  if ((key.shift === true) !== shift) return false;
  return true;
}

/** Bangun layar + prompter + io TUI (belum dimulai/diwiring). */
export function createTuiPair(opts: TuiPairOptions): TuiPair {
  const screen = new Screen({
    stdin: process.stdin,
    stdout: process.stdout,
    status: {
      mode: opts.initMode,
      model: opts.initModel ?? "",
      provider: opts.initProvider ?? "",
    },
    showThinking: opts.thinking !== false,
    ...(opts.theme ? { theme: opts.theme } : {}),
    footer: {
      folder: displayFolder(opts.cwd),
      branch: readGitBranch(opts.cwd) ?? "",
      version: APP_VERSION,
    },
  });
  const prompter = new TuiPrompter(screen, opts.commands, opts.cwd, opts.descriptions ?? {});
  const io = new TuiIO(screen, {
    thinking: opts.thinking,
    markdown: opts.markdown,
    typewriter: opts.typewriter,
  });
  return { prompter, io, screen };
}

/**
 * Wiring penuh: mulai layar, pasang interceptor stdout, dan hubungkan
 * dispatcher key. Dipanggil `ChatApp.create` tepat sebelum `init()`.
 */
export function attachTui(pair: TuiPair, hooks: TuiHooks): { detach: () => void } {
  const { screen, prompter, io } = pair;
  let chord = false;
  screen.setSidebarHandler((name) => hooks.togglePlugin?.(name));

  // Roda mouse menggulir transkrip; seret tombol kiri menyeleksi teks (disalin
  // ke clipboard lewat OSC 52 saat dilepas). Karena pelaporan mouse aktif, roda
  // bisa dibedakan dari tombol ↑/↓ yang tetap dipakai untuk riwayat input.
  const handleMouse = (event: SgrMouseEvent): void => {
    if (event.wheelUp) {
      screen.scrollBy(3);
      return;
    }
    if (event.wheelDown) {
      screen.scrollBy(-3);
      return;
    }
    if (screen.overlayActive || !event.left) return;
    if (event.press && !event.motion && screen.clickSidebar(event.x, event.y)) return;
    if (event.motion) screen.updateSelection(event.x, event.y);
    else if (event.press) screen.beginSelection(event.x, event.y);
    else screen.endSelection();
  };

  const handleGlobal = (key: Key): void => {
    const { name, ctrl } = key;
    const modeKey = hooks.modeKey ?? "tab";
    const detailsKey = hooks.detailsKey ?? "ctrl+o";

    if (ctrl && name === "c") {
      prompter.triggerInterrupt();
      return;
    }
    if (matchesKeybinding(key, detailsKey)) {
      hooks.details?.();
      return;
    }
    if (
      matchesKeybinding(key, modeKey) ||
      // Alternatif lama saat mode memakai Tab: Ctrl+Tab/Shift+Tab tetap bekerja
      // karena banyak terminal tidak mengirim Ctrl+Tab dengan bersih.
      (modeKey === "tab" && name === "tab" && (ctrl || key.shift))
    ) {
      hooks.toggleMode();
      return;
    }
    if (ctrl && name === "x") {
      chord = true;
      return;
    }
    if (chord) {
      chord = false;
      if (name === "up") screen.viewBack();
      else if (name === "down") screen.viewForward();
      return;
    }
    if (ctrl && name === "t") {
      screen.setThinkingVisible(!screen.thinkingVisible);
      return;
    }
    if (name === "pageup") screen.scrollBy(10);
    else if (name === "pagedown") screen.scrollBy(-10);
    else if (name === "home") screen.scrollBy(Number.MAX_SAFE_INTEGER);
    else if (name === "end") screen.scrollToBottom();
  };

  const dispatch = (key: Key): void => {
    // Menekan tombol membatalkan sorotan seleksi (biar tidak "nyangkut").
    screen.clearSelection();
    if (screen.overlayActive) {
      io.handleOverlayKey(key);
      return;
    }
    // Kord `Ctrl+X` diikuti ↑/↓ harus sampai ke dispatcher (ganti view), jadi
    // jangan biarkan `consume` memakannya sebagai riwayat/scroll.
    if (chord) {
      handleGlobal(key);
      return;
    }
    // `consume` menangani baris input; saat agent sibuk pesan akan diantre
    // sehingga layar tidak beku. Sisa tombol global (Ctrl+C, scroll, …) lewat
    // `handleGlobal`.
    if (prompter.consume(key)) return;
    handleGlobal(key);
  };

  // readline memecah urutan `modifyOtherKeys` xterm (`ESC [ 27 ; mod ; kode ~`)
  // menjadi beberapa event. Rakit kembali agar Ctrl+Tab berfungsi dan sisa
  // karakter (mis. "9~") tidak bocor ke baris input.
  let otherBuf = "";
  // readline juga memecah urutan mouse SGR (`ESC [ <`, digit-digit, lalu M/m).
  // Rakit kembali supaya roda mouse terbaca (bukan bocor sebagai ketikan).
  let mouseBuf = "";
  screen.setKeyHandler((key) => {
    if (mouseBuf) {
      mouseBuf += key.sequence;
      if (!/[Mm]$/.test(mouseBuf)) {
        if (mouseBuf.length > 32) mouseBuf = "";
        return;
      }
      const event = decodeSgrMouse(mouseBuf);
      mouseBuf = "";
      if (event) handleMouse(event);
      return;
    }
    const mouseEvent = decodeSgrMouse(key.sequence);
    if (mouseEvent) {
      handleMouse(mouseEvent);
      return;
    }
    if (isSgrMousePartial(key.sequence)) {
      mouseBuf = key.sequence;
      return;
    }
    if (otherBuf) {
      otherBuf += key.sequence;
      if (!otherBuf.endsWith("~")) {
        if (otherBuf.length > 32) otherBuf = "";
        return;
      }
      const decoded = decodeOtherKeys(otherBuf);
      otherBuf = "";
      if (decoded) dispatch(decoded);
      return;
    }
    const complete = decodeOtherKeys(key.sequence);
    if (complete) {
      dispatch(complete);
      return;
    }
    if (isOtherKeysPartial(key.sequence)) {
      otherBuf = key.sequence;
      return;
    }
    dispatch(key);
  });

  screen.start();

  return {
    detach: () => {
      screen.stop();
    },
  };
}
