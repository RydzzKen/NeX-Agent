import { describe, expect, it } from "vitest";
import { commandTouchesSensitive, isSensitivePath } from "../src/safety/sensitive.js";
import { TerminalIO } from "../src/cli/render.js";
import type { PrompterLike } from "../src/cli/prompt.js";

function ioWithAnswer(answer: string): { io: TerminalIO; writes: string[] } {
  const writes: string[] = [];
  const prompter: PrompterLike = { question: async () => answer, close: () => {} };
  const io = new TerminalIO(prompter, { thinking: false, json: false }, (s) => writes.push(s));
  return { io, writes };
}

describe("isSensitivePath", () => {
  it("mendeteksi file rahasia umum", () => {
    for (const p of [
      ".env",
      ".env.local",
      ".env.production",
      "config/.env",
      "/home/u/.ssh/id_rsa",
      "/home/u/.ssh/config",
      "/home/u/.aws/credentials",
      "certs/server.pem",
      "private.key",
      "keys/app.p12",
      ".git-credentials",
      ".npmrc",
      "secrets.yaml",
      "credentials.json",
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("tidak menganggap contoh/template sebagai rahasia", () => {
    for (const p of [".env.example", ".env.sample", ".env.template", "src/a.ts", "README.md", "id_rsa.pub"]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe("commandTouchesSensitive", () => {
  it("mendeteksi perintah yang menyentuh file sensitif", () => {
    expect(commandTouchesSensitive("cat .env")).toBe(true);
    expect(commandTouchesSensitive("grep -i key .env.production")).toBe(true);
    expect(commandTouchesSensitive("cp ~/.ssh/id_rsa /tmp/x")).toBe(true);
  });

  it("tidak menandai perintah biasa", () => {
    expect(commandTouchesSensitive("ls -la src")).toBe(false);
    expect(commandTouchesSensitive("pnpm test")).toBe(false);
  });
});

describe("TerminalIO.requestSensitiveAccess", () => {
  it("mengizinkan saat user mengetik y", async () => {
    const { io, writes } = ioWithAnswer("y");
    const ok = await io.requestSensitiveAccess({ kind: "path", detail: "/ws/.env", reason: "file sensitif" });
    expect(ok).toBe(true);
    expect(writes.join("")).toContain("FILE SENSITIF");
  });

  it("menolak saat user mengetik n atau kosong", async () => {
    expect(
      await ioWithAnswer("n").io.requestSensitiveAccess({ kind: "path", detail: "/ws/.env", reason: "x" }),
    ).toBe(false);
    expect(
      await ioWithAnswer("").io.requestSensitiveAccess({ kind: "path", detail: "/ws/.env", reason: "x" }),
    ).toBe(false);
  });
});
