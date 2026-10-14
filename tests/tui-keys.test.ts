import { afterEach, describe, expect, it } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";
import { TuiPrompter } from "../src/cli/tui/prompt.js";
import { TuiIO } from "../src/cli/tui/io.js";
import { attachTui, type TuiPair } from "../src/cli/tui/index.js";
import { normalizeKey } from "../src/util/ansi.js";

interface Harness {
  pair: TuiPair;
  screen: Screen;
  writes: string[];
  toggles: { mode: number; thinking: number };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Bangun pair TUI palsu (tanpa stdin/stdout sungguhan) + dispatcher terpasang. */
function attach(): Harness {
  const writes: string[] = [];
  const out = {
    write: (s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    },
    columns: 60,
    rows: 20,
    on: () => {},
  };
  const stdin = { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
  const screen = new Screen({
    stdin: stdin as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
    status: { mode: "build" },
  });
  const prompter = new TuiPrompter(screen, ["/help"], "/tmp");
  const io = new TuiIO(screen, { thinking: true });
  const pair: TuiPair = { screen, prompter, io };
  const toggles = { mode: 0, thinking: 0 };
  const { detach } = attachTui(pair, {
    toggleMode: () => {
      toggles.mode += 1;
    },
  });
  cleanups.push(detach);
  return { pair, screen, writes, toggles };
}

/** Teks yang terakhir disalin lewat OSC 52 (atau undefined bila tak ada). */
function copiedText(writes: string[]): string | undefined {
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const match = /\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/.exec(writes[i]!);
    if (match) return Buffer.from(match[1]!, "base64").toString("utf8");
  }
  return undefined;
}

describe("TUI: Ctrl+T & Ctrl+Tab", () => {
  it("Ctrl+T menyalakan/mematikan tampilan thinking", () => {
    const { screen, toggles } = attach();
    expect(screen.thinkingVisible).toBe(true);
    // Bentuk persis dari readline: name "t", ctrl true.
    screen.emitKey({ name: "t", ctrl: true, sequence: "\u0014" });
    expect(screen.thinkingVisible).toBe(false);
    screen.emitKey({ name: "t", ctrl: true, sequence: "\u0014" });
    expect(screen.thinkingVisible).toBe(true);
    expect(toggles.mode).toBe(0);
  });

  it("Ctrl+Tab mengganti mode walau readline memberi name 'undefined'", () => {
    const { screen, toggles } = attach();
    // readline mengirim name sebagai string "undefined" untuk CSI tak dikenal.
    screen.emitKey({ name: "undefined", ctrl: true, sequence: "\u001b[9;5~" });
    expect(toggles.mode).toBe(1);
  });

  it("Ctrl+Tab lewat urutan CSI yang dikenali mengganti mode", () => {
    const { screen, toggles } = attach();
    screen.emitKey({ sequence: "\u001b[1;5I" });
    expect(toggles.mode).toBe(1);
    screen.emitKey({ sequence: "\u001b[1;5z" });
    expect(toggles.mode).toBe(2);
  });

  it("Shift+Tab mengganti mode (alternatif andal)", () => {
    const { screen, toggles } = attach();
    screen.emitKey({ name: "tab", shift: true, sequence: "\u001b[Z" });
    expect(toggles.mode).toBe(1);
  });

  it("Tab biasa tidak mengganti mode", () => {
    const { screen, toggles } = attach();
    screen.emitKey({ name: "tab", sequence: "\t" });
    expect(toggles.mode).toBe(0);
  });

  it("merakit urutan modifyOtherKeys yang dipecah readline (tanpa bocor '9~')", () => {
    const { screen, toggles } = attach();
    // Persis tiga event yang dikirim readline untuk ESC [ 27 ; 5 ; 9 ~.
    screen.emitKey({ name: "undefined", sequence: "\u001b[27;5;" });
    screen.emitKey({ name: "9", sequence: "9" });
    screen.emitKey({ sequence: "~" });
    expect(toggles.mode).toBe(1);
    expect(screen.getInputText()).toBe("");
  });

  it("urutan modifyOtherKeys lengkap sekali jalan juga mengganti mode", () => {
    const { screen, toggles } = attach();
    screen.emitKey({ name: "undefined", sequence: "\u001b[27;5;9~" });
    expect(toggles.mode).toBe(1);
    expect(screen.getInputText()).toBe("");
  });
});

describe("TUI: gulir riwayat chat (roda mouse)", () => {
  it("roda naik/turun menggulir transkrip", () => {
    const { screen } = attach();
    for (let i = 0; i < 40; i += 1) screen.append("text", `baris-${i}`);
    screen.scrollToBottom();
    expect(screen.scrollOffset).toBe(0);

    screen.emitKey({ sequence: "\u001b[<64;10;5M" }); // roda naik
    expect(screen.scrollOffset).toBe(3);
    screen.emitKey({ sequence: "\u001b[<65;10;5M" }); // roda turun
    expect(screen.scrollOffset).toBe(0);
  });

  it("merakit urutan mouse yang dipecah readline (tidak bocor ke input)", () => {
    const { screen } = attach();
    for (let i = 0; i < 40; i += 1) screen.append("text", `b-${i}`);
    screen.scrollToBottom();
    // readline memecah `ESC [ < 6 4 ; 1 0 ; 5 M` menjadi beberapa event.
    for (const part of ["\u001b[<", "6", "4", ";", "1", "0", ";", "5", "M"]) {
      screen.emitKey({ sequence: part });
    }
    expect(screen.scrollOffset).toBe(3);
    expect(screen.getInputText()).toBe("");
  });

  it("roda menggulir walau input berisi draf dan agent bekerja", () => {
    const { pair, screen } = attach();
    for (let i = 0; i < 40; i += 1) screen.append("text", `b-${i}`);
    screen.scrollToBottom();
    pair.prompter.consume(normalizeKey({ sequence: "z" }));
    screen.clearMenu();

    screen.emitKey({ sequence: "\u001b[<64;10;5M" });
    expect(screen.scrollOffset).toBe(3);
    expect(screen.getInputText()).toBe("z");
  });

  it("↑/↓ tidak lagi menggulir (dipakai untuk riwayat input)", () => {
    const { screen } = attach();
    for (let i = 0; i < 40; i += 1) screen.append("text", `b-${i}`);
    screen.scrollToBottom();
    screen.emitKey({ name: "up", sequence: "\u001b[A" });
    screen.emitKey({ name: "down", sequence: "\u001b[B" });
    expect(screen.scrollOffset).toBe(0);
  });

  it("tombol gulir khas Termux (PgUp/PgDn/Home/End) berfungsi dan tidak bocor ke input", () => {
    const { screen } = attach();
    for (let i = 0; i < 40; i += 1) screen.append("text", `b-${i}`);
    screen.scrollToBottom();

    screen.emitKey({ name: "pageup", sequence: "\u001b[5~" });
    expect(screen.scrollOffset).toBe(10);
    screen.emitKey({ name: "pagedown", sequence: "\u001b[6~" });
    expect(screen.scrollOffset).toBe(0);
    screen.emitKey({ name: "home", sequence: "\u001b[H" });
    expect(screen.scrollOffset).toBeGreaterThan(0);
    screen.emitKey({ name: "end", sequence: "\u001b[F" });
    expect(screen.scrollOffset).toBe(0);
    expect(screen.getInputText()).toBe("");
  });
});

describe("TUI: seleksi teks mouse (seret kiri) + salin OSC 52", () => {
  /** Siapkan layar dengan 30 baris dan gulir ke dasar; kosongkan buffer tulis. */
  function setup(): Harness {
    const h = attach();
    h.screen.start();
    h.screen.clearView();
    for (let i = 0; i < 30; i += 1) h.screen.append("text", `baris-${i}`);
    h.screen.scrollToBottom();
    h.writes.length = 0;
    return h;
  }

  it("seret dalam satu baris menyalin potongan kolom terpilih", () => {
    const { screen, writes } = setup();
    screen.emitKey({ sequence: "\u001b[<0;1;1M" }); // tekan kiri di kolom 1, baris 1
    screen.emitKey({ sequence: "\u001b[<32;5;1M" }); // seret ke kolom 5
    screen.emitKey({ sequence: "\u001b[<0;5;1m" }); // lepas
    // Baris 1 (dasar layar) = baris ke-13; kolom 1..5 = "baris".
    expect(copiedText(writes)).toBe("baris");
  });

  it("seret lintas baris menyalin beberapa baris dengan newline", () => {
    const { screen, writes } = setup();
    screen.emitKey({ sequence: "\u001b[<0;1;1M" });
    screen.emitKey({ sequence: "\u001b[<32;3;2M" });
    screen.emitKey({ sequence: "\u001b[<0;3;2m" });
    expect(copiedText(writes)).toBe("baris-13\nbar");
  });

  it("klik tanpa geser tidak menyalin apa pun", () => {
    const { screen, writes } = setup();
    screen.emitKey({ sequence: "\u001b[<0;2;2M" });
    screen.emitKey({ sequence: "\u001b[<0;2;2m" });
    expect(copiedText(writes)).toBeUndefined();
  });

  it("menekan tombol membatalkan seleksi yang tersorot", () => {
    const { screen } = setup();
    screen.emitKey({ sequence: "\u001b[<0;1;1M" });
    screen.emitKey({ sequence: "\u001b[<32;5;1M" });
    expect(screen.hasSelection).toBe(true);
    screen.emitKey({ name: "a", sequence: "a" });
    expect(screen.hasSelection).toBe(false);
  });

  it("seret ke atas (mundur) menormalkan urutan baris", () => {
    const { screen, writes } = setup();
    screen.emitKey({ sequence: "\u001b[<0;3;2M" }); // tekan di baris bawah
    screen.emitKey({ sequence: "\u001b[<32;1;1M" }); // seret ke atas
    screen.emitKey({ sequence: "\u001b[<0;1;1m" });
    expect(copiedText(writes)).toBe("baris-13\nbar");
  });
});
