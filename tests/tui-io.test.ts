import { afterEach, describe, expect, it, vi } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";
import { TuiIO } from "../src/cli/tui/io.js";
import { normalizeKey, stripAnsi } from "../src/util/ansi.js";

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

afterEach(() => {
  vi.useRealTimers();
});

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

describe("TuiIO: input teks overlay", () => {
  it("menerima ketikan dan mengembalikan nilainya (tidak masked)", async () => {
    const { io, screen } = setup();
    const pending = io.inputText({ title: "Model custom", label: "Nama model" });
    for (const ch of ["t", "e", "s"]) io.handleOverlayKey(key({ name: ch, sequence: ch }));
    expect(screen.getOverlayInput()).toBe("tes");
    io.handleOverlayKey(key({ name: "backspace", sequence: "\u007f" }));
    io.handleOverlayKey(key({ name: "return", sequence: "\r" }));
    await expect(pending).resolves.toBe("te");
    expect(screen.overlayActive).toBe(false);
  });

  it("initial mengisi input sejak overlay dibuka", async () => {
    const { io, screen } = setup();
    const pending = io.inputText({ title: "Model custom", label: "Nama", initial: "abc" });
    expect(screen.getOverlayInput()).toBe("abc");
    io.handleOverlayKey(key({ name: "escape", sequence: "\u001b" }));
    await expect(pending).resolves.toBeNull();
    expect(screen.overlayActive).toBe(false);
  });
});

describe("TuiIO: streaming teks & thinking", () => {
  function setupCapture(opts: { thinking?: boolean; typewriter?: boolean } = { thinking: true }): {
    io: TuiIO;
    screen: Screen;
    writes: string[];
  } {
    const writes: string[] = [];
    const out: FakeStdout = {
      write: (chunk: string) => {
        writes.push(chunk);
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
    });
    return { io: new TuiIO(screen, opts), screen, writes };
  }

  it("efek mengetik menahan output bertahap dan textEnd menunggu", async () => {
    vi.useFakeTimers();
    const { io, screen, writes } = setupCapture({ typewriter: true });
    io.setMarkdown(false);
    screen.start();

    io.text("halo");
    let settled = false;
    const done = io.textEnd().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(settled).toBe(true);

    writes.length = 0;
    screen.redraw();
    expect(stripAnsi(writes.join(""))).toContain("halo");
  });

  it("setTypewriter(false) menulis sisa antrean seketika", () => {
    vi.useFakeTimers();
    const { io, screen, writes } = setupCapture({ typewriter: true });
    io.setMarkdown(false);
    screen.start();

    io.text("halo dunia");
    io.setTypewriter(false);

    writes.length = 0;
    screen.redraw();
    expect(stripAnsi(writes.join(""))).toContain("halo dunia");
  });

  it("chunk thinking berurutan tampil dalam satu baris", () => {
    const { io, screen, writes } = setupCapture();
    screen.start();
    for (const c of ["Let", " me", " summarize", "."]) io.thinking(c);
    writes.length = 0;
    screen.redraw();
    expect(stripAnsi(writes.join(""))).toContain("Let me summarize.");
  });

  it("teks (markdown nonaktif) juga menyambung antar chunk", () => {
    const { io, screen, writes } = setupCapture();
    screen.start();
    io.setMarkdown(false);
    io.text("halo");
    io.text(" dunia");
    io.textEnd();
    writes.length = 0;
    screen.redraw();
    expect(stripAnsi(writes.join(""))).toContain("halo dunia");
  });

  it("blok thinking yang dipisah endStream tidak menyambung", () => {
    const { io, screen, writes } = setupCapture();
    screen.start();
    io.thinking("pertama");
    io.thinkingEnd();
    io.thinking("kedua");
    writes.length = 0;
    screen.redraw();
    expect(stripAnsi(writes.join(""))).not.toContain("pertamakedua");
  });

  it("setThinking menyinkronkan indikator thinking di status bar", () => {
    const { io, screen } = setup();
    screen.start();
    expect(screen.thinkingVisible).toBe(true);
    io.setThinking(false);
    expect(screen.thinkingVisible).toBe(false);
    io.setThinking(true);
    expect(screen.thinkingVisible).toBe(true);
  });
});

describe("TuiIO: pemilih (pick) & penampil (view)", () => {
  it("pick memilih item yang disorot dengan Enter", async () => {
    const { io, screen } = setup();
    const pending = io.pick({
      title: "Model",
      items: [
        { label: "a", value: "a" },
        { label: "b", value: "b" },
      ],
    });
    expect(screen.hasOverlayList()).toBe(true);
    io.handleOverlayKey(key({ name: "down", sequence: "\u001b[B" }));
    expect(screen.getOverlaySelected()).toBe(1);
    io.handleOverlayKey(key({ name: "return", sequence: "\r" }));
    await expect(pending).resolves.toBe("b");
    expect(screen.overlayActive).toBe(false);
  });

  it("pick naik ke atas dan membungkus", async () => {
    const { io, screen } = setup();
    const pending = io.pick({
      title: "Pilih",
      items: [
        { label: "a", value: "a" },
        { label: "b", value: "b" },
      ],
    });
    io.handleOverlayKey(key({ name: "up", sequence: "\u001b[A" }));
    expect(screen.getOverlaySelected()).toBe(1);
    io.handleOverlayKey(key({ name: "return", sequence: "\r" }));
    await expect(pending).resolves.toBe("b");
  });

  it("pick dibatalkan dengan Escape (null)", async () => {
    const { io, screen } = setup();
    const pending = io.pick({ title: "Pilih", items: [{ label: "a", value: "a" }] });
    io.handleOverlayKey(key({ name: "escape", sequence: "\u001b" }));
    await expect(pending).resolves.toBeNull();
    expect(screen.overlayActive).toBe(false);
  });

  it("pick tanpa item langsung null (tidak membuka overlay)", async () => {
    const { io, screen } = setup();
    await expect(io.pick({ title: "Kosong", items: [] })).resolves.toBeNull();
    expect(screen.overlayActive).toBe(false);
  });

  it("view ditutup dengan Enter/Escape/q", async () => {
    for (const closeKey of ["return", "escape", "q"]) {
      const { io, screen } = setup();
      const pending = io.view({ title: "Diff", lines: ["+a", "-b"] });
      expect(screen.overlayActive).toBe(true);
      io.handleOverlayKey(
        key(
          closeKey === "return"
            ? { name: "return", sequence: "\r" }
            : closeKey === "escape"
              ? { name: "escape", sequence: "\u001b" }
              : { name: "q", sequence: "q" },
        ),
      );
      await expect(pending).resolves.toBeUndefined();
      expect(screen.overlayActive).toBe(false);
    }
  });

  it("view bisa digulir dengan tombol panah/PgDn tanpa menutup", async () => {
    const { io, screen } = setup();
    const pending = io.view({ title: "Diff", lines: Array.from({ length: 50 }, (_, i) => `line-${i}`) });
    io.handleOverlayKey(key({ name: "down", sequence: "\u001b[B" }));
    io.handleOverlayKey(key({ name: "pagedown", sequence: "\u001b[6~" }));
    expect(screen.overlayActive).toBe(true);
    io.handleOverlayKey(key({ name: "escape", sequence: "\u001b" }));
    await pending;
  });
});

describe("TuiIO: echo pesan pengguna", () => {
  it("menampilkan pesan pengguna di riwayat, bukan hanya di baris input", () => {
    const writes: string[] = [];
    const out: FakeStdout = {
      write: (chunk: string) => {
        writes.push(chunk);
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
    });
    const io = new TuiIO(screen);
    screen.start();
    writes.length = 0;

    io.userMessage("halo dunia");

    const frame = writes.join("");
    expect(frame).toContain("halo dunia");
    expect(frame).toContain("›");
  });
});
