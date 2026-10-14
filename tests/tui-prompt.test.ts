import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function setup(cwd = "/tmp"): { screen: Screen; prompter: TuiPrompter } {
  const out: FakeStdout = { write: () => true, columns: 40, rows: 12, on: () => {} };
  const stdin = { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
  const screen = new Screen({
    stdin: stdin as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
  });
  screen.start();
  const prompter = new TuiPrompter(screen, ["/help", "/diff"], cwd);
  return { screen, prompter };
}

/** Folder sementara dengan beberapa entri agar completion punya kandidat. */
const tmpRoots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-tui-"));
  fs.mkdirSync(path.join(dir, "Project", "Sub"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Pemandangan"));
  fs.writeFileSync(path.join(dir, "readme.md"), "x");
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("TuiPrompter: antrean saat agent sibuk", () => {
  it("mengetik tanpa pertanyaan menganggur tetap masuk ke input", () => {
    const { screen, prompter } = setup();
    expect(prompter.hasPending).toBe(false);
    type(prompter, [letter("h"), letter("i")]);
    expect(screen.getInputText()).toBe("hi");
  });

  it("Enter tanpa pertanyaan mengantre pesan dan mengosongkan input", () => {
    const { screen, prompter } = setup();
    type(prompter, [letter("h"), letter("a"), letter("i")]);
    type(prompter, [enter]);
    expect(prompter.takeQueued()).toBe("hai");
    expect(prompter.takeQueued()).toBeUndefined();
    expect(screen.getInputText()).toBe("");
  });

  it("antrean dikembalikan sesuai urutan kirim", () => {
    const { prompter } = setup();
    type(prompter, [letter("a")]);
    type(prompter, [enter]);
    type(prompter, [letter("b")]);
    type(prompter, [enter]);
    expect(prompter.takeQueued()).toBe("a");
    expect(prompter.takeQueued()).toBe("b");
  });

  it("Enter kosong saat menganggur tidak mengantre apa pun", () => {
    const { prompter } = setup();
    type(prompter, [enter]);
    expect(prompter.takeQueued()).toBeUndefined();
  });

  it("Home/End saat menganggur diteruskan ke dispatcher (scroll)", () => {
    const { prompter } = setup();
    expect(prompter.consume(normalizeKey({ name: "home", sequence: "\u001b[H" }))).toBe(false);
    expect(prompter.consume(normalizeKey({ name: "end", sequence: "\u001b[F" }))).toBe(false);
  });
});

describe("TuiPrompter: menu autocomplete", () => {
  it("tidak menampilkan daftar saat input kosong (backspace di awal)", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    type(prompter, [backspace]);
    expect(screen.getMenuSelected()).toBeUndefined();
  });

  it("Tab pada input kosong tidak memunculkan/memilih apa pun", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    expect(prompter.consume(normalizeKey({ name: "tab", sequence: "\t" }))).toBe(true);
    expect(screen.getMenuSelected()).toBeUndefined();
    expect(screen.getInputText()).toBe("");
  });

  it("daftar muncul saat mengetik kata kunci folder", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    type(prompter, [letter("P"), letter("r"), letter("o")]);
    expect(screen.getMenuSelected()).toBe("Project/");
  });

  it("daftar terisi isi folder setelah kata kunci diakhiri '/'", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    for (const ch of "Project/") type(prompter, [symbol(ch)]);
    expect(screen.getMenuSelected()).toBe("Project/Sub/");
  });

  it("kata acak diikuti spasi tidak memunculkan daftar folder", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    for (const ch of "halo ") type(prompter, [symbol(ch)]);
    expect(screen.getMenuSelected()).toBeUndefined();
  });

  it("spasi setelah kata kunci folder tetap menutup daftar", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    for (const ch of "Project") type(prompter, [symbol(ch)]);
    expect(screen.getMenuSelected()).toBe("Project/");
    type(prompter, [space]);
    expect(screen.getMenuSelected()).toBeUndefined();
  });

  it("subperintah tetap muncul setelah '/mcp '", () => {
    const { screen, prompter } = setup(tempDir());
    void prompter.question("› ");
    for (const ch of "/mcp ") type(prompter, [symbol(ch)]);
    expect(screen.getMenuSelected()).toBe("add");
  });
});
