import path from "node:path";
import type { AccessKind } from "../core/io.js";
import type { Approvals } from "../core/approvals.js";
import type { Mode } from "../core/types.js";
import type { PermissionManager } from "./permissions.js";
import type { ResolvedPath } from "../tools/types.js";
import { ToolDeniedError } from "../tools/errors.js";
import { isSensitivePath } from "./sensitive.js";
import { isInside, type Workspace } from "./workspace.js";

export interface PathResolverDeps {
  workspace: Workspace;
  permissions: PermissionManager;
  approvals: Approvals;
  getMode(): Mode;
}

/**
 * Terapkan soft workspace boundary (PRD §5):
 * - Di dalam workspace: selalu boleh.
 * - Baca luar: konfirmasi sekali, diingat sesi.
 * - Tulis luar: konfirmasi tiap kali, dilarang di mode Plan.
 * - File sensitif (.env, kredensial, private key): selalu konfirmasi eksplisit,
 *   tidak bisa dilewati allow-all/--yes (di dalam maupun luar workspace).
 */
export function createPathResolver(
  deps: PathResolverDeps,
): (raw: string, access: AccessKind) => Promise<ResolvedPath> {
  const { workspace, permissions, approvals, getMode } = deps;

  return async (raw: string, access: AccessKind): Promise<ResolvedPath> => {
    const abs = path.resolve(workspace.root, raw);
    const outside = !isInside(workspace.root, abs);
    const display = outside ? abs : path.relative(workspace.root, abs) || ".";

    if (access === "write" && getMode() === "plan") {
      throw new ToolDeniedError(
        outside
          ? `Menulis di luar workspace (${display}) dilarang di mode Plan.`
          : `Menulis di mode Plan dilarang: ${display}`,
        "mode Plan",
      );
    }

    const sensitive = isSensitivePath(abs);
    const alreadyStanding =
      (access === "read" && permissions.hasStanding(abs, "read")) ||
      (access === "write" && permissions.hasStanding(abs, "write"));

    if (!sensitive && !outside) {
      return { abs, display, outside: false };
    }
    if (alreadyStanding) {
      return { abs, display, outside };
    }

    if (sensitive) {
      const ok = await approvals.requestSensitiveAccess({
        kind: "path",
        detail: abs,
        access,
        outsideWorkspace: outside,
        reason: "file sensitif (mis. .env, kredensial, private key)",
      });
      if (!ok) {
        throw new ToolDeniedError(
          `Akses ${access} ke file sensitif ditolak: ${display}`,
          "file sensitif ditolak",
        );
      }
      // Ingat agar tidak ditanya ulang untuk path yang sama di sesi ini.
      if (access === "read") permissions.allowStanding(abs, "read", "interactive");
      else permissions.record(abs, "write", "interactive");
      return { abs, display, outside };
    }

    const ok = await approvals.requestPathAccess({
      path: abs,
      access,
      outsideWorkspace: true,
    });
    if (!ok) {
      throw new ToolDeniedError(
        `Akses ${access} ke luar workspace ditolak: ${display}`,
        "akses luar workspace ditolak",
      );
    }

    if (access === "read") {
      permissions.allowStanding(abs, "read", "interactive");
    } else {
      permissions.record(abs, "write", "interactive");
    }
    return { abs, display, outside: true };
  };
}
