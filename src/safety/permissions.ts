import path from "node:path";
import type { AccessKind } from "../core/io.js";

export type PermissionOrigin = "interactive" | "allow-path";

export interface PermissionRecord {
  /** Path absolut. */
  path: string;
  access: AccessKind;
  origin: PermissionOrigin;
  /** True bila izin diingat untuk sisa sesi. */
  standing: boolean;
}

/**
 * Izin akses path diper-sesi.
 *
 * Aturan (PRD §5):
 * - Baca di luar workspace: konfirmasi sekali, diingat selama sesi.
 * - Tulis di luar workspace: selalu konfirmasi, tidak pernah "standing".
 * - `--allow-path` menyetujui path sebelum sesi (read + write), standing.
 */
export class PermissionManager {
  private readonly grants: PermissionRecord[] = [];

  constructor(readonly workspaceRoot: string) {}

  private key(p: string): string {
    return path.resolve(this.workspaceRoot, p);
  }

  /** Tambah izin standing (diingat untuk sesi). */
  allowStanding(target: string, access: AccessKind, origin: PermissionOrigin): void {
    const abs = this.key(target);
    this.removeAccess(abs, access);
    this.grants.push({ path: abs, access, origin, standing: true });
  }

  /** Catat izin sekali-pakai untuk keperluan tampilan. */
  record(target: string, access: AccessKind, origin: PermissionOrigin): void {
    const abs = this.key(target);
    if (this.hasStanding(abs, access)) return;
    this.grants.push({ path: abs, access, origin, standing: false });
  }

  /** True bila path punya izin standing untuk akses tertentu. */
  hasStanding(target: string, access: AccessKind): boolean {
    const abs = this.key(target);
    return this.grants.some((g) => g.path === abs && g.access === access && g.standing);
  }

  /** Cabut semua izin untuk path. */
  revoke(target: string): boolean {
    return this.remove(target) > 0;
  }

  private removeAccess(abs: string, access: AccessKind): number {
    let removed = 0;
    for (let i = this.grants.length - 1; i >= 0; i--) {
      if (this.grants[i]!.path === abs && this.grants[i]!.access === access) {
        this.grants.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  private remove(abs: string): number {
    let removed = 0;
    for (let i = this.grants.length - 1; i >= 0; i--) {
      if (this.grants[i]!.path === abs) {
        this.grants.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  list(): PermissionRecord[] {
    return [...this.grants];
  }
}
