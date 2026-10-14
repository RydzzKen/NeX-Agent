import { describe, expect, it } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";
import { TuiPrompter } from "../src/cli/tui/prompt.js";
import { normalizeKey } from "../src/util/ansi.js";

/** Bentuk `Key` persis seperti yang dikirim readline (lihat perilaku nyata). */
type RawKey = Parameters<typeof normalizeKey>[0];

interface FakeStdout {
  write: (chunk: string) => boolean;
  columns: number;
  rows: number;
  on: (event: string, cb: () => void) => void;
}

function setup(): { screen: Screen; prompter: TuiPrompter } {
  const out: FakeStdout = { write: () => true, columns: 40, rows: 12, on: () => {} };
  const stdin = { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
  const screen = new Screen({
    stdin: stdin as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
  });
  screen.start();
  const prompter = new TuiPrompter(screen, ["/help", "/diff"], "/tmp");
  return { screen, prompter };
}

/** Ketik deretan key mentah dan kembalikan hasil konsumsi terakhir. */
function type(prompter: TuiPrompter, keys: RawKey[]): boolean {
  let consumed = false;
  for (const raw of keys) consumed = prompter.consume(normalizeKey(raw));
  return consumed;
}

const letter = (ch: string): RawKey => ({ name: ch.toLowerCase(), sequence: ch, shift: ch !== ch.toLowerCase() });
const symbol = (ch: string): RawKey => ({ sequence: ch });
const space: RawKey = { name: "space", sequence: " " };
const backspace: RawKey = { name: "backspace", sequence: "\u007f" };
const enter: RawKey = { name: "return", sequence: "\r" };
const up: RawKey = { name: "up", sequence: "\u001b[A" };

describe("TuiPrompter: pengetikan", () => {
  it("mengetik huruf kecil masuk ke input", () => {
    const { screen, prompter } = setup();
    void prompter.question("› ");
    type(prompter, ["h", "a", "l", "o"].map(letter));
    expect(screen.getInputText()).toBe("halo");
  });

  it("mempertahankan huruf besar/kecil (pakai sequence, bukan name)", () => {
    const { screen, prompter } = setup();
    void prompter.question("› ");
    // "A" dikirim readline dengan name "a" tapi sequence "A".
    type(prompter, [{ name: "a", sequence: "A", shift: true }]);
    type(prompter, [letter("b"), letter("c")]);
    expect(screen.getInputText()).toBe("Abc");
  });

  it("menerima simbol slash dan spasi", () => {
    const { screen, prompter } = setup();
    void prompter.question("› ");
    type(prompter, [symbol("/"), letter("h"), letter("e"), letter("l"), letter("p")]);
    type(prompter, [space, letter("x")]);
    expect(screen.getInputText()).toBe("/help x");
  });

  it("backspace menghapus karakter terakhir", () => {
    const { screen, prompter } = setup();
    void prompter.question("› ");
    type(prompter, [letter("a"), letter("b"), letter("c")]);
    type(prompter, [backspace]);
    expect(screen.getInputText()).toBe("ab");
  });

  it("tombol panah tidak dikonsumsi (diteruskan untuk scroll)", () => {
    const { prompter } = setup();
    void prompter.question("› ");
    expect(prompter.consume(normalizeKey(up))).toBe(false);
  });

  it("Enter mengirim isi input", async () => {
    const { prompter } = setup();
    const pending = prompter.question("› ");
    type(prompter, [letter("h"), letter("i")]);
    type(prompter, [enter]);
    await expect(pending).resolves.toBe("hi");
  });
});

describe("TuiPrompter: input rahasia", () => {
  it("menerima ketikan walau tampilan di-mask", async () => {
    const { screen, prompter } = setup();
    const pending = prompter.secretQuestion("API key: ");
    type(prompter, ["s", "3", "c", "r", "3", "t"].map(symbol));
    expect(screen.getInputText()).toBe("s3cr3t");
    type(prompter, [enter]);
    await expect(pending).resolves.toBe("s3cr3t");
  });
});
