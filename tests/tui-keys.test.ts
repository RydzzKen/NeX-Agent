import { afterEach, describe, expect, it } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";
import { TuiPrompter } from "../src/cli/tui/prompt.js";
import { TuiIO } from "../src/cli/tui/io.js";
import { attachTui, type TuiPair } from "../src/cli/tui/index.js";

interface Harness {
  pair: TuiPair;
  screen: Screen;
  toggles: { mode: number; thinking: number };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Bangun pair TUI palsu (tanpa stdin/stdout sungguhan) + dispatcher terpasang. */
function attach(): Harness {
  const out = { write: () => true, columns: 60, rows: 20, on: () => {} };
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
  return { pair, screen, toggles };
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
