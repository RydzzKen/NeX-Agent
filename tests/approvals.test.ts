import { describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO, type AgentIO, type ConfirmRequest, type PathAccessRequest } from "../src/core/io.js";

interface Recorder {
  io: AgentIO;
  /** Urutan masuk/keluar tiap prompt. */
  events: string[];
  /** True bila dua prompt pernah berjalan bersamaan. */
  overlapped(): boolean;
}

function recorder(delayMs = 5): Recorder {
  const base = silentIO("yes");
  const events: string[] = [];
  let active = 0;
  let overlapped = false;

  async function track(label: string): Promise<void> {
    active++;
    if (active > 1) overlapped = true;
    events.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, delayMs));
    events.push(`end:${label}`);
    active--;
  }

  const io: AgentIO = {
    ...base,
    confirm: async (req: ConfirmRequest) => {
      await track(req.title);
      return "yes";
    },
    requestPathAccess: async (req: PathAccessRequest) => {
      await track(req.path);
      return true;
    },
  };
  return { io, events, overlapped: () => overlapped };
}

describe("Approvals", () => {
  it("menjalankan prompt izin secara berurutan walau dipanggil paralel", async () => {
    const rec = recorder();
    const approvals = new Approvals(rec.io, { yes: false, interactive: true });

    const results = await Promise.all([
      approvals.requestPathAccess({ path: "/luar/a", access: "read", outsideWorkspace: true }),
      approvals.requestPathAccess({ path: "/luar/b", access: "read", outsideWorkspace: true }),
    ]);

    expect(results).toEqual([true, true]);
    expect(rec.overlapped()).toBe(false);
    // Mulai A selesai, baru B mulai.
    expect(rec.events).toEqual([
      "start:/luar/a",
      "end:/luar/a",
      "start:/luar/b",
      "end:/luar/b",
    ]);
  });

  it("menjalankan konfirmasi secara berurutan", async () => {
    const rec = recorder();
    const approvals = new Approvals(rec.io, { yes: false, interactive: true });

    await Promise.all([
      approvals.confirm({ kind: "write", title: "tulis a", detail: "" }),
      approvals.confirm({ kind: "write", title: "tulis b", detail: "" }),
    ]);

    expect(rec.overlapped()).toBe(false);
    expect(rec.events).toEqual([
      "start:tulis a",
      "end:tulis a",
      "start:tulis b",
      "end:tulis b",
    ]);
  });

  it("menyetujui otomatis dengan --yes tanpa memanggil prompt", async () => {
    let called = 0;
    const base = silentIO("no");
    const io: AgentIO = {
      ...base,
      confirm: async () => {
        called++;
        return "no";
      },
      requestPathAccess: async () => {
        called++;
        return false;
      },
    };
    const approvals = new Approvals(io, { yes: true, interactive: true });
    expect(await approvals.confirm({ kind: "read", title: "x", detail: "" })).toBe("yes");
    expect(
      await approvals.requestPathAccess({ path: "/x", access: "read", outsideWorkspace: true }),
    ).toBe(true);
    expect(called).toBe(0);
  });

  it("menolak otomatis saat non-interaktif tanpa --yes", async () => {
    const approvals = new Approvals(silentIO("yes"), { yes: false, interactive: false });
    expect(await approvals.confirm({ kind: "read", title: "x", detail: "" })).toBe("no");
    expect(
      await approvals.requestPathAccess({ path: "/x", access: "read", outsideWorkspace: true }),
    ).toBe(false);
  });

  it("mengizinkan semua saat allow-all aktif tanpa memanggil prompt", async () => {
    let called = 0;
    const base = silentIO("no");
    const io: AgentIO = {
      ...base,
      confirm: async () => {
        called++;
        return "no";
      },
      requestPathAccess: async () => {
        called++;
        return false;
      },
    };
    const approvals = new Approvals(io, { yes: false, interactive: true, allowAll: true });
    expect(approvals.allowAll()).toBe(true);
    expect(await approvals.confirm({ kind: "write", title: "x", detail: "" })).toBe("yes");
    expect(
      await approvals.requestPathAccess({ path: "/x", access: "write", outsideWorkspace: true }),
    ).toBe(true);
    expect(called).toBe(0);

    // Toggle saat sesi berjalan.
    approvals.setAllowAll(false);
    expect(approvals.allowAll()).toBe(false);
    expect(await approvals.confirm({ kind: "write", title: "x", detail: "" })).toBe("no");
  });

  it("requestSensitiveAccess tidak dilewati allow-all dan butuh interaktif", async () => {
    let asked = 0;
    const base = silentIO("no");
    const io: AgentIO = {
      ...base,
      requestSensitiveAccess: async () => {
        asked++;
        return false;
      },
    };
    const approvals = new Approvals(io, { yes: false, interactive: true, allowAll: true });
    expect(
      await approvals.requestSensitiveAccess({ kind: "path", detail: "/w/.env", reason: "sensitif" }),
    ).toBe(false);
    expect(asked).toBe(1);

    // Non-interaktif selalu ditolak, tidak peduli allow-all.
    const offline = new Approvals(silentIO("yes"), { yes: true, interactive: false, allowAll: true });
    expect(
      await offline.requestSensitiveAccess({ kind: "path", detail: "/w/.env", reason: "sensitif" }),
    ).toBe(false);
  });
});
