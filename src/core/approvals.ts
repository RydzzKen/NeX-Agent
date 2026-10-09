import type {
  AgentIO,
  ConfirmDecision,
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
} from "./io.js";

export interface ApprovalOptions {
  /** Setujui semua kategori konfirmasi sejak awal (flag `--yes`). */
  yes: boolean;
  /** Interaksi memungkinkan (TTY, bukan mode JSON). */
  interactive: boolean;
  /**
   * Izinkan semua permintaan persetujuan untuk sesi ini (`--allow-all`).
   * Aksi yang diblokir di kode (mis. tulis luar workspace di mode Plan) tetap
   * ditolak sebelum sampai ke sini.
   */
  allowAll?: boolean;
}

/**
 * Menyatukan kebijakan persetujuan:
 * - `--yes`/`--allow-all` menyetujui semua kategori konfirmasi (tetapi tidak aksi
 *   yang diblokir di kode).
 * - Mode non-interaktif tanpa keduanya menolak.
 * - "setujui semua" interaktif (`a`) hanya berlaku bila `allowAll` diizinkan.
 * - Prompt interaktif diserialisasi agar tidak saling menimpa saat tool paralel.
 */
export class Approvals {
  private autoAllWrites = false;
  private sessionAllowAll: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: AgentIO,
    private readonly opts: ApprovalOptions,
  ) {
    this.sessionAllowAll = opts.yes || Boolean(opts.allowAll);
  }

  /** True bila semua permintaan persetujuan diizinkan untuk sesi ini. */
  allowAll(): boolean {
    return this.sessionAllowAll;
  }

  /** Ubah mode izinkan-semua untuk sesi berjalan (toggle `/allow-all`). */
  setAllowAll(value: boolean): void {
    this.sessionAllowAll = value;
  }

  /** Jalankan satu tindakan setelah tindakan interaktif sebelumnya selesai. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  confirm(req: ConfirmRequest, o: { allowAll?: boolean } = {}): Promise<ConfirmDecision> {
    if (this.sessionAllowAll) return Promise.resolve("yes");
    if (o.allowAll && this.autoAllWrites) return Promise.resolve("yes");
    if (!this.opts.interactive) return Promise.resolve("no");
    return this.serialize(async () => {
      const decision = await this.io.confirm(req);
      if (decision === "all" && o.allowAll) this.autoAllWrites = true;
      return decision;
    });
  }

  requestPathAccess(req: PathAccessRequest): Promise<boolean> {
    if (this.sessionAllowAll) return Promise.resolve(true);
    if (!this.opts.interactive) return Promise.resolve(false);
    return this.serialize(() => this.io.requestPathAccess(req));
  }

  /**
   * Konfirmasi file sensitif. Selalu butuh prompt interaktif eksplisit dan
   * TIDAK pernah dilewati oleh allow-all/--yes. Non-interaktif → ditolak.
   */
  requestSensitiveAccess(req: SensitiveAccessRequest): Promise<boolean> {
    if (!this.opts.interactive) return Promise.resolve(false);
    return this.serialize(async () => {
      if (this.io.requestSensitiveAccess) return this.io.requestSensitiveAccess(req);
      return false;
    });
  }

  reset(): void {
    this.autoAllWrites = false;
  }
}
