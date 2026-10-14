import { describe, expect, it } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";
import { TuiIO } from "../src/cli/tui/io.js";
import { normalizeKey } from "../src/util/ansi.js";

interface FakeStdout {
  write: (chunk: string) => boolean;
  columns: number;
  rows: number;
  on: (event: string, cb: () => void) => void;
}

function setup(): { io: TuiIO; screen: Screen } {
  const out: FakeStdout = { write: () => true, columns: 60, rows: 20, on: () => {} };
  const stdin = { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
  const screen = new Screen({
    stdin: stdin as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
  });
  return { io: new TuiIO(screen), screen };
}

const key = (k: {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}): ReturnType<typeof normalizeKey> => normalizeKey(k);

describe("TuiIO: konfirmasi overlay", () => {
  it("huruf 'y' menyetujui (name terisi readline, bukan undefined)", async () => {
    const { io } = setup();
    const pending = io.confirm({ kind: "shell", title: "Jalankan?", detail: "rm -rf /tmp/x" });
    io.handleOverlayKey(key({ name: "y", sequence: "y" }));
    await expect(pending).resolves.toBe("yes");
  });

  it("huruf 'n' menolak", async () => {
    const { io } = setup();
    const pending = io.confirm({ kind: "shell", title: "Jalankan?", detail: "x" });
    io.handleOverlayKey(key({ name: "n", sequence: "n" }));
    await expect(pending).resolves.toBe("no");
  });

  it("huruf besar 'A' menyetujui semua (case-insensitive)", async () => {
    const { io } = setup();
    const pending = io.confirm({ kind: "write", title: "Tulis?", detail: "x" });
    io.handleOverlayKey(key({ name: "a", sequence: "A", shift: true }));
    await expect(pending).resolves.toBe("all");
  });

  it("Enter memilih opsi pertama", async () => {
    const { io } = setup();
    const pending = io.confirm({ kind: "shell", title: "Jalankan?", detail: "x" });
    io.handleOverlayKey(key({ name: "return", sequence: "\r" }));
    await expect(pending).resolves.toBe("yes");
  });
});

describe("TuiIO: overlay rahasia", () => {
  it("menerima ketikan huruf/angka dan mengembalikan nilainya", async () => {
    const { io, screen } = setup();
    const pending = io.requestSecret({ kind: "sudo", detail: "sudo true", reason: "butuh sudo" });
    for (const ch of ["s", "3", "c", "r", "3", "t"]) {
      io.handleOverlayKey(key({ name: ch, sequence: ch }));
    }
    expect(screen.getOverlayInput()).toBe("s3cr3t");
    io.handleOverlayKey(key({ name: "backspace", sequence: "\u007f" }));
    io.handleOverlayKey(key({ name: "return", sequence: "\r" }));
    await expect(pending).resolves.toBe("s3cr3");
  });

  it("Escape membatalkan", async () => {
    const { io } = setup();
    const pending = io.requestSecret({ kind: "ssh", detail: "ssh host", reason: "butuh ssh" });
    io.handleOverlayKey(key({ name: "escape", sequence: "\u001b" }));
    await expect(pending).resolves.toBeNull();
  });
});
