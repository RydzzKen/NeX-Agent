import { describe, expect, it } from "vitest";
import { Screen, type ScreenOptions } from "../src/cli/tui/screen.js";

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
