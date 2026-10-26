import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/util/ansi.js";
import {
  centerLine,
  centerPad,
  clipLine,
  contentWidth,
  fitLine,
  formatFooter,
  formatHeader,
  formatPromptMeta,
  layoutMetrics,
  layoutTier,
  sidebarWidth,
  truncateMiddle,
  wrapLine,
} from "../src/cli/tui/layout.js";

describe("layout TUI responsif", () => {
  it("tiga breakpoint: ≥100, 60–99, <60", () => {
    expect(layoutTier(120)).toBe("wide");
    expect(layoutTier(100)).toBe("wide");
    expect(layoutTier(99)).toBe("medium");
    expect(layoutTier(60)).toBe("medium");
    expect(layoutTier(59)).toBe("narrow");
    expect(layoutTier(20)).toBe("narrow");
  });

  it("lebar sidebar proporsional dan hanya muncul di layar lebar", () => {
    expect(sidebarWidth(99)).toBe(0);
    expect(sidebarWidth(100)).toBe(22);
    expect(sidebarWidth(120)).toBe(26);
    expect(sidebarWidth(200)).toBe(28);
  });

  it("metrik layar lebar menampilkan sidebar dan provider", () => {
    const m = layoutMetrics(120, 35);
    expect(m.tier).toBe("wide");
    expect(m.paddingX).toBe(2);
    expect(m.sidebar).toBe(true);
    expect(m.sidebarWidth).toBe(26);
    expect(m.showProvider).toBe(true);
    expect(m.menuRows).toBe(6);
    expect(m.menuDescriptions).toBe(true);
    expect(m.diffStacked).toBe(false);
    expect(m.diffLineNumbers).toBe(true);
    expect(m.hideTip).toBe(false);
    expect(m.hideHeader).toBe(false);
  });

  it("layar sedang menyembunyikan sidebar tetapi masih menampilkan provider", () => {
    const m = layoutMetrics(80, 24);
    expect(m.tier).toBe("medium");
    expect(m.sidebar).toBe(false);
    expect(m.sidebarWidth).toBe(0);
    expect(m.paddingX).toBe(2);
    expect(m.showProvider).toBe(true);
    expect(m.menuDescriptions).toBe(true);
  });

  it("layar sempit memakai padding 1, logo satu baris, dan menu 5 baris", () => {
    const m = layoutMetrics(45, 30);
    expect(m.tier).toBe("narrow");
    expect(m.paddingX).toBe(1);
    expect(m.compactLogo).toBe(true);
    expect(m.showProvider).toBe(false);
    expect(m.menuRows).toBe(5);
    expect(m.menuDescriptions).toBe(false);
    expect(m.diffStacked).toBe(true);
    expect(m.diffLineNumbers).toBe(false);
  });

  it("tinggi <20 menyembunyikan tip dan header", () => {
    const low = layoutMetrics(120, 19);
    expect(low.hideTip).toBe(true);
    expect(low.hideHeader).toBe(true);
    expect(layoutMetrics(120, 20).hideTip).toBe(false);
    expect(layoutMetrics(120, 20).hideHeader).toBe(false);
  });

  it("lebar isi memperhitungkan padding dan sidebar", () => {
    const wide = layoutMetrics(120, 35);
    expect(contentWidth(120, wide)).toBe(120 - 4 - wide.sidebarWidth - 1);
    expect(contentWidth(80, layoutMetrics(80, 24))).toBe(76);
    expect(contentWidth(45, layoutMetrics(45, 30))).toBe(43);
  });

  it("clipLine dan fitLine tidak melewati lebar, termasuk karakter lebar", () => {
    expect(clipLine("abcdef", 4)).toBe("abc…");
    expect(clipLine("abc", 10)).toBe("abc");
    expect(clipLine("abc", 0)).toBe("");

    expect(fitLine("abc", 5)).toBe("abc  ");
    expect(fitLine("abcdef", 4)).toBe("abc…");
    expect(fitLine("abc", 0)).toBe("");
    expect(visibleWidth(fitLine("霓虹", 3))).toBe(3);
    expect(visibleWidth(fitLine("霓虹", 5))).toBe(5);
  });

  it("centerLine memusatkan teks dan aman untuk karakter lebar", () => {
    expect(centerLine("ab", 6)).toBe("  ab  ");
    expect(visibleWidth(centerLine("霓", 4))).toBe(4);
    expect(visibleWidth(centerLine("abcdef", 4))).toBe(4);
  });

  it("truncateMiddle memotong folder tanpa melewati lebar", () => {
    expect(truncateMiddle("abcdef", 10)).toBe("abcdef");
    expect(truncateMiddle("abcdef", 5)).toBe("ab…ef");
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 0)).toBe("");
    for (const width of [2, 3, 4, 5, 6, 7]) {
      expect(visibleWidth(truncateMiddle("霓虹灯火", width))).toBeLessThanOrEqual(width);
    }
  });

  it("centerPad dan wrapLine membantu penempatan blok", () => {
    expect(centerPad(24, 10)).toBe(7);
    expect(centerPad(10, 24)).toBe(0);
    expect(centerPad(-1, 5)).toBe(0);
    expect(wrapLine("abcdef", 3)).toEqual(["abc", "def"]);
    expect(wrapLine("a\nb", 5)).toEqual(["a", "b"]);
  });

  it("baris meta prompt: mode, model, provider; provider hilang di sempit", () => {
    const wide = formatPromptMeta(
      { mode: "Build", model: "claude-sonnet-4", provider: "anthropic" },
      80,
      { level: 0 },
    );
    expect(wide).toBe("build  claude-sonnet-4  anthropic");

    const narrow = formatPromptMeta(
      { mode: "build", model: "claude-sonnet-4", provider: "anthropic" },
      20,
      { showProvider: false, level: 0 },
    );
    expect(visibleWidth(narrow)).toBe(20);
    expect(narrow).toContain("build");
    expect(narrow).toContain("claude");
    expect(narrow).not.toContain("anthropic");
  });

  it("warna badge prompt mengikuti mode", () => {
    const build = formatPromptMeta(
      { mode: "build", model: "m", provider: "p" },
      40,
      { level: 3 },
    );
    expect(build).toContain("38;2;92;156;245");

    const plan = formatPromptMeta({ mode: "plan", model: "m", provider: "p" }, 40, { level: 3 });
    expect(plan).toContain("38;2;245;167;66");
  });

  it("header menaruh persentase konteks di kanan dan tidak melewati lebar", () => {
    const header = formatHeader("Sesi baru", 42, 40, { level: 0 });
    expect(visibleWidth(header)).toBe(40);
    expect(header.startsWith("Sesi baru")).toBe(true);
    expect(header.trimEnd().endsWith("42%")).toBe(true);

    const tight = formatHeader("Judul yang sangat panjang sekali", 100, 20, { level: 0 });
    expect(visibleWidth(tight)).toBe(20);
    expect(tight.trimEnd().endsWith("100%")).toBe(true);
  });

  it("footer lebar: folder:branch kiri, versi kanan", () => {
    const footer = formatFooter(
      { folder: "NeX-Agent", branch: "main", version: "1.21.0" },
      80,
      { level: 0 },
    );
    expect(visibleWidth(footer)).toBe(76);
    expect(footer.startsWith("NeX-Agent:main")).toBe(true);
    expect(footer.trimEnd().endsWith("NeX-Agent v1.21.0")).toBe(true);
  });

  it("footer sempit memotong folder di tengah dan memendekkan versi", () => {
    const footer = formatFooter(
      { folder: "proyek-yang-panjang-sekali", branch: "main", version: "1.21.0" },
      30,
      { compact: true, level: 0 },
    );
    expect(visibleWidth(footer)).toBe(28);
    expect(footer).toContain("…");
    expect(footer).toContain(":main");
    expect(footer.trimEnd().endsWith("v1.21.0")).toBe(true);

    const short = formatFooter(
      { folder: "repo", branch: "main", version: "1.0.0" },
      40,
      { compact: true, level: 0 },
    );
    expect(short.startsWith("repo:main")).toBe(true);
    expect(short.trimEnd().endsWith("v1.0.0")).toBe(true);
  });
});
