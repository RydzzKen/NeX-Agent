import { describe, expect, it } from "vitest";
import { restartArgs } from "../src/cli/restart_args.js";

describe("restartArgs", () => {
  it("menambahkan --resume <id> di akhir", () => {
    expect(restartArgs(["/app/index.js"], "ses_1")).toEqual(["/app/index.js", "--resume", "ses_1"]);
  });

  it("membuang --resume lama beserta nilainya", () => {
    expect(restartArgs(["/app/index.js", "--resume", "lama", "--thinking"], "baru")).toEqual([
      "/app/index.js",
      "--thinking",
      "--resume",
      "baru",
    ]);
  });

  it("membuang bentuk --resume=<id>", () => {
    expect(restartArgs(["/app/index.js", "--resume=lama", "--debug"], "baru")).toEqual([
      "/app/index.js",
      "--debug",
      "--resume",
      "baru",
    ]);
  });

  it("membuang --continue", () => {
    expect(restartArgs(["/app/index.js", "--continue", "--model", "m"], "baru")).toEqual([
      "/app/index.js",
      "--model",
      "m",
      "--resume",
      "baru",
    ]);
  });

  it("mempertahankan urutan flag lain apa adanya", () => {
    expect(restartArgs(["/app/index.js", "--allow-all", "--cwd", "/tmp/x"], "s")).toEqual([
      "/app/index.js",
      "--allow-all",
      "--cwd",
      "/tmp/x",
      "--resume",
      "s",
    ]);
  });

  it("tanpa sessionId hanya membersihkan resume/continue", () => {
    expect(restartArgs(["/app/index.js", "--resume", "a", "--continue"])).toEqual(["/app/index.js"]);
  });

  it("menangani --resume tanpa nilai di akhir", () => {
    expect(restartArgs(["/app/index.js", "--resume"], "s")).toEqual(["/app/index.js", "--resume", "s"]);
  });

  it("meneruskan id apa adanya (tanpa parsing ulang)", () => {
    expect(restartArgs(["/app/index.js"], "sesi aneh")).toEqual(["/app/index.js", "--resume", "sesi aneh"]);
  });
});
