import { decodeOtherKeys, isCtrlTab, isOtherKeysPartial, type Key } from "../../util/ansi.js";
import { Screen } from "./screen.js";
import { TuiPrompter } from "./prompt.js";
import { TuiIO } from "./io.js";

export interface TuiPairOptions {
  commands: string[];
  cwd: string;
  initMode: string;
  initModel?: string;
  initProvider?: string;
  thinking?: boolean;
  markdown?: boolean;
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
  /** Ganti mode Plan/Build (Ctrl+Tab / Shift+Tab). */
  toggleMode: () => void;
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
  });
  const prompter = new TuiPrompter(screen, opts.commands, opts.cwd);
  const io = new TuiIO(screen, {
    thinking: opts.thinking,
    markdown: opts.markdown,
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

  const handleGlobal = (key: Key): void => {
    const { name, ctrl } = key;

    if (ctrl && name === "c") {
      prompter.triggerInterrupt();
      return;
    }
    if (isCtrlTab(key)) {
      hooks.toggleMode();
      return;
    }
    // Shift+Tab: alternatif andal untuk ganti mode (Ctrl+Tab tidak dikirim oleh
    // banyak terminal). readline mengurainya bersih sebagai tab + shift.
    if (name === "tab" && key.shift && !ctrl) {
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
    if (name === "up") screen.scrollBy(1);
    else if (name === "down") screen.scrollBy(-1);
    else if (name === "pageup") screen.scrollBy(10);
    else if (name === "pagedown") screen.scrollBy(-10);
    else if (name === "home") screen.scrollBy(Number.MAX_SAFE_INTEGER);
    else if (name === "end") screen.scrollToBottom();
  };

  const dispatch = (key: Key): void => {
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
  screen.setKeyHandler((key) => {
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