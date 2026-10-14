import { describe, expect, it } from "vitest";
import { layoutInput, Screen, type ScreenOptions } from "../src/cli/tui/screen.js";

interface FakeStdout {
  write: (chunk: string) => boolean;
  columns: number;
  rows: number;
  on: (event: string, cb: () => void) => void;
}

interface FakeStdin {
  isTTY: boolean;
  setRawMode: (value: boolean) => void;
  on: (event: string, cb: () => void) => void;
  removeAllListeners: (event: string) => void;
}

/** Stdout palsu yang menampung setiap frame untuk diperiksa. */
function fakeStdout(): { out: FakeStdout; writes: string[] } {
  const writes: string[] = [];
  const out: FakeStdout = {
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    columns: 40,
    rows: 12,
    on: () => {},
  };
  return { out, writes };
}

function fakeStdin(): FakeStdin {
  return { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
}

function makeScreen(): { screen: Screen; writes: string[]; out: FakeStdout } {
  const { out, writes } = fakeStdout();
  const screen = new Screen({
    stdin: fakeStdin() as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
  });
  return { screen, writes, out };
}

describe("Screen: rute tulis", () => {
  it("mengirim frame ke stdout asli walau .write ditimpa (intercept)", () => {
    const { screen, writes, out } = makeScreen();
    // Simulasikan installIntercept(): process.stdout.write diganti.
    // Tulis frame TIDAK boleh kembali masuk ke interceptor (penyebab layar gelap).
    out.write = () => {
      throw new Error("frame salah rute: memanggil write yang sudah di-intercept");
    };
    screen.start();
    expect(writes.join("")).toContain("TUI siap");
    screen.stop();
  });
});

describe("Screen: isi & status", () => {
  it("menampilkan teks yang di-append pada frame berikutnya", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    writes.length = 0;
    screen.append("text", "halo dunia");
    expect(writes.join("")).toContain("halo dunia");
  });

  it("menyembunyikan/menampilkan baris thinking", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    screen.append("think", "proses-internal");
    screen.setThinkingVisible(false);
    writes.length = 0;
    screen.redraw();
    expect(writes.join("")).not.toContain("proses-internal");

    screen.setThinkingVisible(true);
    writes.length = 0;
    screen.redraw();
    expect(writes.join("")).toContain("proses-internal");
  });

  it("mengubah mode pada status bar", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    screen.setStatus({ mode: "plan" });
    writes.length = 0;
    screen.redraw();
    expect(writes.join("")).toContain("PLAN");
  });
});

describe("Screen: input", () => {
  it("mengelola kursor, sisip, dan hapus", () => {
    const { screen } = makeScreen();
    screen.start();
    screen.setInput("abc", 3, false, "› ");
    screen.insertInput("d");
    expect(screen.getInputText()).toBe("abcd");
    screen.moveCaret(-2);
    screen.insertInput("X");
    expect(screen.getInputText()).toBe("abXcd");
    screen.deleteInput();
    expect(screen.getInputText()).toBe("abcd");
    screen.forwardDeleteInput();
    expect(screen.getInputText()).toBe("abd");
  });

  it("menyembunyikan isi input rahasia (mask)", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    screen.setInput("rahasia", 7, true, "pw: ");
    writes.length = 0;
    screen.redraw();
    const frame = writes.join("");
    expect(frame).toContain("*******");
    expect(frame).not.toContain("rahasia");
  });

  it("menggeser pilihan menu", () => {
    const { screen } = makeScreen();
    screen.start();
    screen.setMenu("/", ["/help", "/diff", "/search"]);
    screen.menuSelect(1);
    expect(screen.getMenuSelected()).toBe("/diff");
    screen.menuSelect(-1);
    expect(screen.getMenuSelected()).toBe("/help");
  });

  it("menu bergulir sehingga pilihan ke-7+ tetap terlihat", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    screen.setMenu("tok", items);
    for (let i = 0; i < 7; i++) screen.menuSelect(1);
    expect(screen.getMenuSelected()).toBe("item7");
    writes.length = 0;
    screen.redraw();
    const frame = writes.join("");
    expect(frame).toContain("item7"); // pilihan terlihat
    expect(frame).not.toContain("item0"); // sudah tergulir keluar
    expect(frame).toContain("item2"); // jendela bergeser
  });

  it("menu bergulir ke atas saat memilih dari bawah (bungkus)", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    screen.setMenu("tok", items);
    screen.menuSelect(-1); // 0 → 9 (bungkus ke belakang)
    expect(screen.getMenuSelected()).toBe("item9");
    writes.length = 0;
    screen.redraw();
    const frame = writes.join("");
    expect(frame).toContain("item9");
    expect(frame).not.toContain("item0");
  });

  it("tidak keluar layar saat input panjang (horizontal scroll)", () => {
    const { screen, writes } = makeScreen();
    screen.start();
    const long = "kata-".repeat(40); // 200 karakter > 40 kolom
    screen.setInput(long, long.length, false, "› ");
    const frame = writes.join("");
    // Hanya jendela (≤ lebar) yang tampil, bukan seluruh 200 karakter.
    const visible = frame.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
    expect(visible).not.toContain(long);
    // Kursor tetap berada di dalam layar.
    const move = /;([0-9]+)H/g;
    let m: RegExpExecArray | null;
    while ((m = move.exec(frame)) !== null) {
      expect(Number(m[1])).toBeLessThanOrEqual(40);
    }
  });
});

describe("Screen: layoutInput", () => {
  const width = (s: { before: string; at: string; after: string }): number =>
    s.before.length + s.at.length + s.after.length;

  it("menampilkan seluruh teks pendek tanpa penanda potong", () => {
    const l = layoutInput("hello", 5, 20);
    expect(l.before).toBe("hello");
    expect(l.at).toBe(" ");
    expect(l.after).toBe("");
    expect(l.clippedLeft).toBe(false);
    expect(l.clippedRight).toBe(false);
  });

  it("menggeser jendela agar kursor di ujung kanan tetap terlihat", () => {
    const l = layoutInput("abcdefghij", 10, 6);
    expect(l.clippedLeft).toBe(true);
    expect(l.at).toBe(" ");
    expect(width(l)).toBeLessThanOrEqual(6);
    // Karakter terakhir sebelum kursor ikut tampil.
    expect(l.before.endsWith("j")).toBe(true);
  });

  it("menjaga kursor tetap berada di dalam jendela saat di tengah", () => {
    const text = "abcdefghij";
    for (let caret = 0; caret <= text.length; caret++) {
      const l = layoutInput(text, caret, 6);
      expect(width(l)).toBeLessThanOrEqual(6);
      // `at` mewakili karakter pada posisi kursor (atau spasi di ujung).
      if (caret < text.length) expect(l.at).toBe(text[caret]);
    }
  });

  it("menandai potongan di kanan bila masih ada teks setelah jendela", () => {
    const l = layoutInput("abcdefghij", 1, 6);
    expect(l.clippedLeft).toBe(false);
    expect(l.clippedRight).toBe(true);
  });
});

describe("Screen: overlay", () => {
  it("aktif/nonaktif dan mode rahasia", () => {
    const { screen } = makeScreen();
    screen.start();
    expect(screen.overlayActive).toBe(false);
    screen.setOverlay({ title: "Konfirmasi", body: ["yakin?"], keys: [["y", "ya"]] });
    expect(screen.overlayActive).toBe(true);
    expect(screen.isOverlaySecret()).toBe(false);
    screen.setOverlay({ title: "Password", body: [], keys: [], secret: { label: "Password" } });
    expect(screen.isOverlaySecret()).toBe(true);
    screen.pushOverlayChar("a");
    expect(screen.getOverlayInput()).toBe("a");
    screen.popOverlayChar();
    expect(screen.getOverlayInput()).toBe("");
    screen.setOverlay(undefined);
    expect(screen.overlayActive).toBe(false);
  });
});

describe("Screen: view", () => {
  it("membuka dan menutup view subagent", () => {
    const { screen } = makeScreen();
    screen.start();
    expect(screen.viewCount()).toBe(1);
    const id = screen.openSubtaskView("subtask");
    expect(screen.viewCount()).toBe(2);
    expect(screen.activeViewId).toBe(id);
    screen.closeSubtaskView(id);
    expect(screen.viewCount()).toBe(1);
  });

  it("meneruskan key lewat emitKey (jalur test)", () => {
    const { screen } = makeScreen();
    screen.start();
    const seen: string[] = [];
    screen.setKeyHandler((key) => seen.push(key.name ?? key.sequence));
    screen.emitKey({ name: "up", sequence: "\u001b[A" });
    expect(seen).toContain("up");
  });
});
