import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, osc52Sequence, wrapForMultiplexer } from "../src/util/clipboard.js";

/** Ambil kembali teks yang disandikan dari satu urutan OSC 52. */
function decodeOsc52(seq: string): string {
  const match = /\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/.exec(seq);
  if (!match) throw new Error("bukan urutan OSC 52");
  return Buffer.from(match[1]!, "base64").toString("utf8");
}

describe("clipboard: OSC 52", () => {
  it("menyandikan teks UTF-8 ke urutan OSC 52 yang bisa didekode ulang", () => {
    const seq = osc52Sequence("halo dunia 日本語");
    expect(decodeOsc52(seq)).toBe("halo dunia 日本語");
    expect(osc52Sequence("hi")).toBe("\u001b]52;c;aGk=\u0007");
  });

  it("memaparkan batas ukuran yang wajar", () => {
    expect(OSC52_MAX_BYTES).toBeGreaterThan(1000);
  });
});

describe("clipboard: pembungkusan multiplexer", () => {
  it("mengembalikan apa adanya di luar tmux/screen", () => {
    const seq = osc52Sequence("x");
    expect(wrapForMultiplexer(seq, {})).toBe(seq);
    expect(wrapForMultiplexer(seq, { TERM: "xterm-256color" })).toBe(seq);
  });

  it("membungkus untuk tmux lewat DCS passthrough (ESC digandakan)", () => {
    const seq = osc52Sequence("x");
    const wrapped = wrapForMultiplexer(seq, { TMUX: "/tmp/tmux-1000/default,1,0" });
    expect(wrapped.startsWith("\u001bPtmux;")).toBe(true);
    expect(wrapped.endsWith("\u001b\\")).toBe(true);
    // ESC pada urutan dalam harus digandakan agar lolos tmux.
    expect(wrapped).toContain("\u001b\u001b]52;c;");
  });

  it("membungkus untuk screen lewat DCS passthrough", () => {
    const seq = osc52Sequence("x");
    const wrapped = wrapForMultiplexer(seq, { TERM: "screen-256color" });
    expect(wrapped).toBe(`\u001bP${seq}\u001b\\`);
  });
});
