import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO, type ConfirmDecision } from "../src/core/io.js";
import type { Mode } from "../src/core/types.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";

let root: string;
let permissions: PermissionManager;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-policy-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  permissions = new PermissionManager(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function resolver(decision: ConfirmDecision, mode: Mode) {
  const io = silentIO(decision);
  const approvals = new Approvals(io, { yes: false, interactive: true });
  const workspace = createWorkspace(root);
  return createPathResolver({ workspace, permissions, approvals, getMode: () => mode });
}

/** Resolver dengan allow-all aktif; konfirmasi sensitif tetap harus eksplisit. */
function allowAllResolver(decision: ConfirmDecision, mode: Mode = "build") {
  const io = silentIO(decision);
  const approvals = new Approvals(io, { yes: false, interactive: true, allowAll: true });
  const workspace = createWorkspace(root);
  return createPathResolver({ workspace, permissions, approvals, getMode: () => mode });
}

describe("path resolver (soft workspace boundary)", () => {
  it("mengizinkan akses di dalam workspace tanpa konfirmasi", async () => {
    const resolved = await resolver("no", "build")("src/a.ts", "write");
    expect(resolved.outside).toBe(false);
    expect(resolved.abs).toBe(path.join(root, "src/a.ts"));
  });

  it("meminta konfirmasi sekali untuk baca luar, lalu mengingatnya", async () => {
    const outside = "../rahasia.txt";
    const first = await resolver("yes", "build")(outside, "read");
    expect(first.outside).toBe(true);
    expect(permissions.hasStanding(first.abs, "read")).toBe(true);

    // Instance resolver baru dengan jawaban "no" tetap boleh karena sudah diingat.
    const second = await resolver("no", "build")(outside, "read");
    expect(second.outside).toBe(true);
  });

  it("menolak baca luar bila pengguna menolak", async () => {
    await expect(resolver("no", "build")("../rahasia.txt", "read")).rejects.toThrow(/ditolak/);
  });

  it("selalu menolak tulis luar di mode Plan", async () => {
    await expect(resolver("yes", "plan")("../keluar.txt", "write")).rejects.toThrow(/mode Plan/);
  });

  it("menegosiasikan tulis luar tiap kali (tidak standing)", async () => {
    const outside = "../keluar.txt";
    const granted = await resolver("yes", "build")(outside, "write");
    expect(granted.outside).toBe(true);
    expect(permissions.hasStanding(granted.abs, "write")).toBe(false);

    await expect(resolver("no", "build")(outside, "write")).rejects.toThrow(/ditolak/);
  });

  it("file sensitif di dalam workspace tetap butuh konfirmasi meski allow-all", async () => {
    await expect(allowAllResolver("no")(".env", "read")).rejects.toThrow(/sensitif/);
    const ok = await allowAllResolver("yes")(".env", "read");
    expect(ok.abs).toBe(path.join(root, ".env"));
    expect(ok.outside).toBe(false);
    // Sekali diizinkan, path yang sama tidak ditanya lagi.
    const again = await allowAllResolver("no")(".env", "read");
    expect(again.abs).toBe(path.join(root, ".env"));
  });

  it("allow-all tetap lancar untuk file biasa di dalam workspace", async () => {
    const resolved = await allowAllResolver("no")("src/a.ts", "write");
    expect(resolved.outside).toBe(false);
  });

  it("izin --allow-path melewati konfirmasi sensitif", async () => {
    permissions.allowStanding(path.join(root, ".env"), "read", "allow-path");
    const resolved = await allowAllResolver("no")(".env", "read");
    expect(resolved.abs).toBe(path.join(root, ".env"));
  });
});
