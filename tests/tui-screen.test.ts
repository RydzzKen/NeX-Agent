import { describe, expect, it } from "vitest";
import {
  layoutInput,
  Screen,
  type ScreenFooter,
  type ScreenOptions,
  type ScreenStatus,
} from "../src/cli/tui/screen.js";
import { stripAnsi, visibleWidth } from "../src/util/ansi.js";
import { APP_VERSION } from "../src/version.js";

interface FakeStdout {
  write: (chunk: string) => boolean;
  columns: number;
  rows: number;
  resizeCb?: () => void;
  on: (event: string, cb: () => void) => void;
  off: (event: string, cb: () => void) => void;
  removeListener: (event: string, cb: () => void) => void;
}

interface FakeStdin {
  isTTY: boolean;
  setRawMode: (value: boolean) => void;
  on: (event: string, cb: () => void) => void;
  removeAllListeners: (event: string) => void;
}

function fakeStdout(cols = 80, rows = 24): { out: FakeStdout; writes: string[] } {
  const writes: string[] = [];
  const out: FakeStdout = {
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    columns: cols,
    rows,
    on: (event, cb) => {
      if (event === "resize") out.resizeCb = cb;
    },
    off: (event, cb) => {
      if (event === "resize" && out.resizeCb === cb) out.resizeCb = undefined;
    },
    removeListener: (event, cb) => {
      if (event === "resize" && out.resizeCb === cb) out.resizeCb = undefined;
    },
  };
  return { out, writes };
}

function fakeStdin(): FakeStdin {
  return { isTTY: false, setRawMode: () => {}, on: () => {}, removeAllListeners: () => {} };
}

interface MakeOptions {
  cols?: number;
  rows?: number;
  session?: string;
  status?: Partial<ScreenStatus>;
  footer?: Partial<ScreenFooter>;
}

function makeScreen(opts: MakeOptions = {}): {
  screen: Screen;
  writes: string[];
  out: FakeStdout;
} {
  const { out, writes } = fakeStdout(opts.cols ?? 80, opts.rows ?? 24);
  const screen = new Screen({
    stdin: fakeStdin() as unknown as ScreenOptions["stdin"],
    stdout: out as unknown as ScreenOptions["stdout"],
    status: {
      mode: "build",
      model: "claude-sonnet-4",
      provider: "anthropic",
      ...opts.status,
    },
    footer: {
      folder: "~/Project/NeX-Agent",
      branch: "main",
      version: APP_VERSION,
      ...opts.footer,
    },
  });
  screen.start();
  if (opts.session !== undefined) screen.startSession(opts.session);
  return { screen, writes, out };
}

function lastFrame(writes: string[]): string {
  const frames = writes.filter((write) => write.includes("\u001b[?2026h"));
  return frames[frames.length - 1] ?? "";
}

function plainFrame(writes: string[]): string {
  return stripAnsi(lastFrame(writes));
}

describe("TUI: konten transkrip", () => {
  const DIFF = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-lama\n+baru\n sama";

  it("merender panel pengguna, tool, output, dan diff", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.append("user", "halo");
    const id = screen.appendTool("$ pnpm test");
    screen.finishTool(id, { status: "ok" });
    screen.append("tool-out", "output baris");
    screen.append("edit", "src/a.ts");
    screen.appendDiff(DIFF);
    const plain = plainFrame(writes);
    expect(plain).toContain("█ halo");
    expect(plain).toContain("$ pnpm test ok");
    expect(plain).toContain("output baris");
    expect(plain).toContain("← Edit src/a.ts");
    expect(plain).toContain("+ baru");
    expect(plain).toContain("- lama");
    expectFrameFits(lastFrame(writes), 80, 24);
  });

  it("/details menyembunyikan dan menampilkan kembali output tool", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    const id = screen.appendTool("$ ls");
    screen.finishTool(id, { status: "ok" });
    screen.append("tool-out", "isi folder");
    expect(plainFrame(writes)).toContain("isi folder");
    expect(screen.toggleToolDetails()).toBe(false);
    const hidden = plainFrame(writes);
    expect(hidden).toContain("$ ls ok");
    expect(hidden).not.toContain("isi folder");
    expect(screen.toggleToolDetails()).toBe(true);
    expect(plainFrame(writes)).toContain("isi folder");
  });

  it("snapshot/restore memulihkan transkrip untuk undo/redo", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.append("user", "awal");
    const snapshot = screen.snapshotMainLines();
    screen.append("text", "tambahan");
    expect(plainFrame(writes)).toContain("tambahan");
    screen.restoreMainLines(snapshot);
    const restored = plainFrame(writes);
    expect(restored).toContain("awal");
    expect(restored).not.toContain("tambahan");
  });

  it("diff sempit ditumpuk tanpa nomor baris", () => {
    const { screen, writes } = makeScreen({ cols: 45, rows: 30, session: "uji" });
    screen.appendDiff(DIFF);
    const plain = plainFrame(writes);
    expect(plain).toContain("+ baru");
    expect(plain).not.toMatch(/\d+ \+ baru/);
  });

  it("klik plugin sidebar memanggil handler toggle", () => {
    const { screen } = makeScreen({ cols: 120, rows: 35, session: "uji" });
    screen.setSidebar({
      plugins: [
        { name: "filesystem", enabled: true, connected: true },
        { name: "github", enabled: false },
      ],
      files: [],
    });
    const toggled: string[] = [];
    screen.setSidebarHandler((name) => toggled.push(name));
    // 120 kolom: padding 2 + konten 89 + 2 = kolom 93. Baris 5 = plugin pertama
    // (sesi, judul, kosong, "plugin", lalu item pertama).
    expect(screen.clickSidebar(93, 5)).toBe(true);
    expect(toggled).toEqual(["filesystem"]);
    expect(screen.clickSidebar(20, 5)).toBe(false);
    expect(screen.clickSidebar(93, 2)).toBe(false);
  });
});

/** Pastikan setiap potongan baris yang ditulis tidak melewati lebar layar. */
function expectFrameFits(frame: string, cols: number, rows: number): void {
  const moves = [...frame.matchAll(/\u001b\[(\d+);(\d+)H/g)];
  expect(moves.length).toBeGreaterThan(0);
  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i]!;
    const row = Number(move[1]);
    const col = Number(move[2]);
    expect(row).toBeGreaterThanOrEqual(1);
    expect(row).toBeLessThanOrEqual(rows);
    expect(col).toBeGreaterThanOrEqual(1);
    expect(col).toBeLessThanOrEqual(cols);
    const start = (move.index ?? 0) + move[0].length;
    const end = i + 1 < moves.length ? (moves[i + 1]!.index ?? frame.length) : frame.length;
    const width = visibleWidth(frame.slice(start, end));
    expect(width + col - 1).toBeLessThanOrEqual(cols);
  }
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
    expect(writes.join("")).toContain("NeX-Agent");
    screen.stop();
  });

  it("membungkus frame dengan sinkronisasi output (anti-kedip)", () => {
    const { screen, writes } = makeScreen();
    screen.redraw();
    const frame = lastFrame(writes);
    expect(frame.startsWith("\u001b[?2026h")).toBe(true);
    expect(frame.endsWith("\u001b[?2026l")).toBe(true);
    screen.stop();
  });
});

describe("Screen: layar awal", () => {
  it("menampilkan logo blok, prompt tengah, tip, dan footer", () => {
    const { screen, writes } = makeScreen();
    const frame = plainFrame(writes);
    expect(frame).toContain("█▄ █ █▀▀ ▀▄▀");
    expect(frame).toContain("A G E N T");
    expect(frame).toContain("tanya apa saja…");
    expect(frame).toContain("tip: ketik /skills");
    expect(frame).toContain(`NeX-Agent v${APP_VERSION}`);
    expect(frame).not.toContain("TUI siap");
    screen.stop();
  });

  it("memakai logo satu baris, meta ringkas, dan footer sempit di 45 kolom", () => {
    const { screen, writes } = makeScreen({ cols: 45, rows: 30 });
    const frame = plainFrame(writes);
    expect(frame).toContain("NeX-Agent");
    expect(frame).not.toContain("█▄ █");
    expect(frame).toContain("build  claude-sonnet-4");
    expect(frame).not.toContain("anthropic");
    expect(frame).toContain(`v${APP_VERSION}`);
    expectFrameFits(lastFrame(writes), 45, 30);
    screen.stop();
  });

  it("menyembunyikan tip saat tinggi terminal di bawah 20 baris", () => {
    const { screen, writes } = makeScreen({ cols: 80, rows: 18 });
    const frame = plainFrame(writes);
    expect(frame).not.toContain("tip:");
    expect(frame).toContain("tanya apa saja…");
    screen.stop();
  });
});

describe("Screen: layar sesi", () => {
  it("menampilkan header judul + konteks, transkrip, prompt, dan footer", () => {
    const { screen, writes } = makeScreen();
    screen.startSession("refactor tui");
    screen.append("user", "tolong rapikan tui");
    screen.append("text", "Baik, saya mulai.");
    screen.setSessionInfo({ contextPercent: 42 });
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("# refactor tui");
    expect(frame).toContain("42%");
    expect(frame).toContain("tolong rapikan tui");
    expect(frame).toContain("Baik, saya mulai.");
    expect(frame).toContain("█ build");
    expect(frame).toContain(`NeX-Agent v${APP_VERSION}`);
    expect(frame).not.toContain("█▄ █");
    expectFrameFits(lastFrame(writes), 80, 24);
    screen.stop();
  });

  it("menampilkan sidebar plugin dan file diubah pada 120 kolom", () => {
    const { screen, writes } = makeScreen({ cols: 120, rows: 35 });
    screen.startSession("refactor tui");
    screen.setSidebar({
      plugins: [
        { name: "filesystem", enabled: true, connected: true },
        { name: "github", enabled: true, connected: false },
        { name: "browser", enabled: false },
      ],
      files: [{ path: "src/cli/tui/screen.ts", added: 120, removed: 40 }],
    });
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("sesi");
    expect(frame).toContain("plugin");
    expect(frame).toContain("filesystem");
    expect(frame).toContain("file diubah");
    expect(frame).toContain("src/cli");
    expect(frame).toContain("+120 -40");
    expectFrameFits(lastFrame(writes), 120, 35);
    screen.stop();
  });

  it("menyembunyikan sidebar pada 80 kolom, tetapi header tetap ada", () => {
    const { screen, writes } = makeScreen({ cols: 80, rows: 24 });
    screen.startSession("refactor tui");
    screen.setSidebar({
      plugins: [{ name: "filesystem", enabled: true, connected: true }],
      files: [],
    });
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("# refactor tui");
    expect(frame).not.toContain("plugin");
    screen.stop();
  });

  it("menyembunyikan header saat tinggi terminal di bawah 20 baris", () => {
    const { screen, writes } = makeScreen({ cols: 80, rows: 18, session: "refactor tui" });
    const frame = plainFrame(writes);
    expect(frame).not.toContain("# refactor tui");
    expect(frame).toContain("█ build");
    screen.stop();
  });

  it("menggambar ulang setelah resize tanpa melewati batas layar", async () => {
    const { screen, writes, out } = makeScreen({ cols: 45, rows: 30 });
    expect(plainFrame(writes)).toContain("NeX-Agent");
    out.columns = 120;
    out.rows = 35;
    out.resizeCb?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = lastFrame(writes);
    expect(plainFrame(writes)).toContain("A G E N T");
    expectFrameFits(frame, 120, 35);
    screen.stop();
  });
});

describe("Screen: isi & status", () => {
  it("menampilkan teks yang di-append pada frame berikutnya", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.append("text", "halo dunia");
    expect(plainFrame(writes)).toContain("halo dunia");
    screen.stop();
  });

  it("menyembunyikan/menampilkan baris thinking", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.append("think", "proses-internal");
    screen.setThinkingVisible(false);
    screen.redraw();
    expect(plainFrame(writes)).not.toContain("proses-internal");

    screen.setThinkingVisible(true);
    screen.redraw();
    expect(plainFrame(writes)).toContain("proses-internal");
    screen.stop();
  });

  it("mengubah mode pada badge prompt", () => {
    const { screen, writes } = makeScreen();
    screen.setStatus({ mode: "plan" });
    screen.redraw();
    expect(plainFrame(writes)).toContain("plan");
    expect(plainFrame(writes)).not.toContain("build");
    screen.stop();
  });

  it("output baru saat sedang menggulir tidak menyentak ke bawah", () => {
    const { screen } = makeScreen({ session: "uji" });
    for (let i = 0; i < 40; i += 1) screen.append("text", `baris-${i}`);
    screen.scrollBy(10);
    expect(screen.scrollOffset).toBe(10);
    screen.append("text", "baru");
    expect(screen.scrollOffset).toBe(11); // posisi gulir dipertahankan
    screen.stop();
  });

  it("output baru tetap di bawah saat tidak menggulir", () => {
    const { screen } = makeScreen({ session: "uji" });
    for (let i = 0; i < 40; i += 1) screen.append("text", `baris-${i}`);
    screen.scrollBy(5);
    screen.scrollToBottom();
    screen.append("text", "baru");
    expect(screen.scrollOffset).toBe(0);
    screen.stop();
  });
});

describe("Screen: streaming", () => {
  it("appendStream menyambung potongan kata jadi satu baris (bukan satu kata per baris)", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    for (const c of ["Let", " me", " present", " the", " contents", "."]) {
      screen.appendStream("think", c);
    }
    screen.redraw();
    expect(plainFrame(writes)).toContain("Let me present the contents.");
    screen.stop();
  });

  it("appendStream mulai baris baru saat potongan memuat '\\n'", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.appendStream("text", "baris1\nbaris2");
    screen.redraw();
    const visible = plainFrame(writes);
    expect(visible).toContain("baris1");
    expect(visible).toContain("baris2");
    expect(visible).not.toContain("baris1baris2");
    screen.stop();
  });

  it("endStream memisahkan dua blok dengan jenis sama", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.appendStream("text", "aaa");
    screen.endStream();
    screen.appendStream("text", "bbb");
    screen.redraw();
    expect(plainFrame(writes)).not.toContain("aaabbb");
    screen.stop();
  });

  it("append biasa menutup baris streaming sebelumnya", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.appendStream("text", "aaa");
    screen.append("info", "info");
    screen.appendStream("text", "bbb");
    screen.redraw();
    expect(plainFrame(writes)).not.toContain("aaabbb");
    screen.stop();
  });
});

describe("Screen: input", () => {
  it("mengelola kursor, sisip, dan hapus", () => {
    const { screen } = makeScreen();
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
    screen.stop();
  });

  it("menyembunyikan isi input rahasia (mask)", () => {
    const { screen, writes } = makeScreen();
    screen.setInput("rahasia", 7, true, "pw: ");
    screen.redraw();
    const frame = lastFrame(writes);
    expect(frame).toContain("*******");
    expect(frame).not.toContain("rahasia");
    screen.stop();
  });

  it("menggeser pilihan menu", () => {
    const { screen } = makeScreen();
    screen.setMenu("/", ["/help", "/diff", "/search"]);
    screen.menuSelect(1);
    expect(screen.getMenuSelected()).toBe("/diff");
    screen.menuSelect(-1);
    expect(screen.getMenuSelected()).toBe("/help");
    screen.stop();
  });

  it("menu bergulir sehingga pilihan ke-7+ tetap terlihat", () => {
    const { screen, writes } = makeScreen();
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    screen.setMenu("tok", items);
    for (let i = 0; i < 7; i++) screen.menuSelect(1);
    expect(screen.getMenuSelected()).toBe("item7");
    screen.redraw();
    const frame = lastFrame(writes);
    expect(frame).toContain("item7"); // pilihan terlihat
    expect(frame).not.toContain("item0"); // sudah tergulir keluar
    expect(frame).toContain("item2"); // jendela bergeser
    screen.stop();
  });

  it("menu sempit hanya menampilkan lima baris", () => {
    const { screen, writes } = makeScreen({ cols: 45, rows: 30 });
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    screen.setMenu("tok", items);
    for (let i = 0; i < 7; i++) screen.menuSelect(1);
    screen.redraw();
    const frame = lastFrame(writes);
    expect(frame).toContain("item7");
    expect(frame).toContain("item3");
    expect(frame).not.toContain("item2");
    screen.stop();
  });

  it("menu bergulir ke atas saat memilih dari bawah (bungkus)", () => {
    const { screen, writes } = makeScreen();
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    screen.setMenu("tok", items);
    screen.menuSelect(-1); // 0 → 9 (bungkus ke belakang)
    expect(screen.getMenuSelected()).toBe("item9");
    screen.redraw();
    const frame = lastFrame(writes);
    expect(frame).toContain("item9");
    expect(frame).not.toContain("item0");
    screen.stop();
  });

  it("tidak keluar layar saat input panjang (horizontal scroll)", () => {
    const { screen, writes } = makeScreen();
    const long = "kata-".repeat(40); // 200 karakter > 80 kolom
    screen.setInput(long, long.length, false, "› ");
    const frame = lastFrame(writes);
    expect(stripAnsi(frame)).not.toContain(long);
    expectFrameFits(frame, 80, 24);
    screen.stop();
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
    screen.stop();
  });

  it("input overlay tidak masked menampilkan teks apa adanya", () => {
    const { screen, writes } = makeScreen();
    screen.setOverlay({
      title: "Model custom",
      body: [],
      keys: [],
      secret: { label: "Nama", masked: false },
    });
    screen.setOverlayInput("my-model");
    screen.redraw();
    expect(plainFrame(writes)).toContain("Nama: my-model");
    screen.stop();
  });

  it("input overlay masked (default) menyembunyikan teks", () => {
    const { screen, writes } = makeScreen();
    screen.setOverlay({ title: "Password", body: [], keys: [], secret: { label: "pw" } });
    screen.pushOverlayChar("x");
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("pw: *");
    expect(frame).not.toContain("pw: x");
    screen.stop();
  });

  it("mengelola sorotan daftar overlay (↑/↓, bungkus)", () => {
    const { screen } = makeScreen();
    screen.setOverlay({
      title: "Pilih",
      body: [],
      keys: [],
      list: { items: ["a", "b", "c"], selected: 0, offset: 0 },
    });
    expect(screen.hasOverlayList()).toBe(true);
    expect(screen.getOverlaySelected()).toBe(0);
    screen.overlaySelect(1);
    screen.overlaySelect(1);
    expect(screen.getOverlaySelected()).toBe(2);
    screen.overlaySelect(1); // bungkus ke awal
    expect(screen.getOverlaySelected()).toBe(0);
    screen.overlaySelect(-1); // bungkus ke akhir
    expect(screen.getOverlaySelected()).toBe(2);
    screen.stop();
  });

  it("daftar overlay bergulir sehingga item ke-7+ tetap terlihat", () => {
    const { screen, writes } = makeScreen({ rows: 12 });
    const items = Array.from({ length: 12 }, (_, i) => `item${i}`);
    screen.setOverlay({
      title: "Pilih",
      body: [],
      keys: [],
      list: { items, selected: 0, offset: 0 },
    });
    for (let i = 0; i < 7; i++) screen.overlaySelect(1);
    expect(screen.getOverlaySelected()).toBe(7);
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("item7");
    expect(frame).not.toContain("item0");
    screen.stop();
  });

  it("viewer overlay menggulir konten panjang", () => {
    const { screen, writes } = makeScreen();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    screen.setOverlay({ title: "Diff", body: lines, keys: [["Esc", "tutup"]], scrollTop: 0 });
    screen.redraw();
    expect(plainFrame(writes)).toContain("line-0");

    screen.overlayScrollBy(10);
    screen.redraw();
    const frame = plainFrame(writes);
    expect(frame).toContain("line-10");
    expect(frame).not.toContain("line-0");
    screen.stop();
  });
});

describe("Screen: view", () => {
  it("membuka dan menutup view subagent", () => {
    const { screen } = makeScreen({ session: "uji" });
    expect(screen.viewCount()).toBe(1);
    const id = screen.openSubtaskView("subtask");
    expect(screen.viewCount()).toBe(2);
    expect(screen.activeViewId).toBe(id);
    screen.closeSubtaskView(id);
    expect(screen.viewCount()).toBe(1);
    screen.stop();
  });

  it("meneruskan key lewat emitKey (jalur test)", () => {
    const { screen } = makeScreen();
    const seen: string[] = [];
    screen.setKeyHandler((key) => seen.push(key.name ?? key.sequence));
    screen.emitKey({ name: "up", sequence: "\u001b[A" });
    expect(seen).toContain("up");
    screen.stop();
  });
});

describe("Screen: seleksi teks", () => {
  it("menyorot kolom terpilih dan menyalinnya saat seleksi berakhir", () => {
    const { screen, writes } = makeScreen({ session: "uji" });
    screen.clearView();
    for (let i = 0; i < 20; i += 1) screen.append("text", `line-${i}`);
    screen.scrollToBottom();
    writes.length = 0;

    screen.beginSelection(3, 2);
    screen.updateSelection(6, 2);
    expect(screen.hasSelection).toBe(true);
    // Frame terakhir memuat penanda video terbalik (sorotan).
    expect(lastFrame(writes)).toContain("\u001b[7m");

    screen.endSelection();
    const match = /\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/.exec(writes.join(""));
    expect(match).toBeTruthy();
    expect(Buffer.from(match![1]!, "base64").toString("utf8")).toBe("line");
    screen.stop();
  });

  it("klik satu sel tidak menghidupkan seleksi setelah dilepas", () => {
    const { screen } = makeScreen({ session: "uji" });
    screen.append("text", "halo");
    screen.scrollToBottom();
    screen.beginSelection(3, 2);
    screen.endSelection();
    expect(screen.hasSelection).toBe(false);
    screen.stop();
  });
});
