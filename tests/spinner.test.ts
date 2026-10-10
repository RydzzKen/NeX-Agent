import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalIO } from "../src/cli/render.js";
import type { PrompterLike } from "../src/cli/prompt.js";

function fakePrompter(question: PrompterLike["question"] = async () => ""): PrompterLike {
  return { question, close: () => {} };
}

function makeIO(opts: { json?: boolean; spinner?: boolean; prompter?: PrompterLike } = {}) {
  const chunks: string[] = [];
  const io = new TerminalIO(
    opts.prompter ?? fakePrompter(),
    { thinking: false, json: Boolean(opts.json), spinner: opts.spinner ?? true },
    (s) => chunks.push(s),
  );
  return { io, chunks, text: () => chunks.join("") };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("spinner CLI", () => {
  it("muncul saat bekerja lalu hilang saat ada output", () => {
    vi.useFakeTimers();
    const { io, text } = makeIO();

    io.busy(true);
    expect(text()).not.toContain("sedang bekerja");

    vi.advanceTimersByTime(300);
    expect(text()).toContain("sedang bekerja");

    io.text("halo dunia");
    io.textEnd();
    expect(text()).toContain("halo dunia");
    // Baris spinner dibersihkan dan jawaban menjadi output terakhir.
    expect(text().endsWith("halo dunia\n")).toBe(true);

    io.busy(false);
  });

  it("spinner berganti bingkai seiring waktu", () => {
    vi.useFakeTimers();
    const { io, chunks } = makeIO();
    io.busy(true);
    vi.advanceTimersByTime(300);
    const before = chunks.length;
    vi.advanceTimersByTime(200);
    expect(chunks.length).toBeGreaterThan(before);
    io.busy(false);
  });

  it("tidak menulis apa pun bila spinner nonaktif", () => {
    vi.useFakeTimers();
    const { io, chunks } = makeIO({ spinner: false });
    io.busy(true);
    vi.advanceTimersByTime(1000);
    io.busy(false);
    expect(chunks.join("")).toBe("");
  });

  it("mode json mematikan spinner", () => {
    vi.useFakeTimers();
    const { io, chunks } = makeIO({ json: true, spinner: true });
    io.busy(true);
    vi.advanceTimersByTime(1000);
    expect(chunks.join("")).toBe("");
  });

  it("berhenti berputar saat menunggu konfirmasi pengguna", async () => {
    vi.useFakeTimers();
    let resolveAnswer: ((value: string) => void) | undefined;
    const prompter = fakePrompter(
      () =>
        new Promise<string>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    const { io, chunks } = makeIO({ prompter });

    io.busy(true);
    vi.advanceTimersByTime(300);
    expect(chunks.join("")).toContain("sedang bekerja");

    const pending = io.confirm({ kind: "shell", title: "Jalankan?", detail: "rm -rf /" });
    const settled = chunks.length;
    vi.advanceTimersByTime(1000);
    // Tidak ada bingkai spinner baru selama menunggu jawaban.
    expect(chunks.length).toBe(settled);

    resolveAnswer?.("n");
    await expect(pending).resolves.toBe("no");
    io.busy(false);
  });
});
