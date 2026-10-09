/** Dilempar bila aksi ditolak (mode Plan, izin, atau pengguna menolak). */
export class ToolDeniedError extends Error {
  constructor(
    message: string,
    readonly reason = message,
  ) {
    super(message);
    this.name = "ToolDeniedError";
  }
}

/** Dilempar bila input tool tidak valid. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
