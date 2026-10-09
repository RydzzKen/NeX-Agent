import { describe, expect, it } from "vitest";
import { PermissionManager } from "../src/safety/permissions.js";

describe("PermissionManager", () => {
  it("menyimpan izin baca standing dan mencabutnya", () => {
    const manager = new PermissionManager("/ws");
    expect(manager.hasStanding("/etc/hosts", "read")).toBe(false);
    manager.allowStanding("/etc/hosts", "read", "interactive");
    expect(manager.hasStanding("/etc/hosts", "read")).toBe(true);
    expect(manager.hasStanding("/etc/hosts", "write")).toBe(false);

    expect(manager.revoke("/etc/hosts")).toBe(true);
    expect(manager.hasStanding("/etc/hosts", "read")).toBe(false);
  });

  it("mencatat izin non-standing untuk tampilan tanpa memberi akses otomatis", () => {
    const manager = new PermissionManager("/ws");
    manager.record("/tmp/out.txt", "write", "interactive");
    expect(manager.hasStanding("/tmp/out.txt", "write")).toBe(false);
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]!.access).toBe("write");
    expect(manager.list()[0]!.standing).toBe(false);
  });

  it("mendukung izin --allow-path untuk read dan write", () => {
    const manager = new PermissionManager("/ws");
    manager.allowStanding("/data", "read", "allow-path");
    manager.allowStanding("/data", "write", "allow-path");
    expect(manager.hasStanding("/data", "read")).toBe(true);
    expect(manager.hasStanding("/data", "write")).toBe(true);
  });
});
