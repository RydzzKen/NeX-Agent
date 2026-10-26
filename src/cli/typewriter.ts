/**
 * Efek mengetik untuk output model (dipakai CLI dan TUI).
 *
 * Potongan teks tidak langsung dicetak, melainkan masuk antrean lalu dikuras
 * bertahap. Dua aturan kecepatan membuat efek ini tidak menyiksa:
 *
 * 1. **Teks panjang lebih cepat.** Setelah `longTextChars` (≈1500 kata), jeda
 *    per karakter menyusut proporsional terhadap panjang total giliran.
 * 2. **Backlog besar dipercepat.** Bila antrean menumpuk (model mengirim lebih
 *    cepat daripada animasi), jeda ikut menyusut agar animasi tidak tertinggal.
 *
 * Saat giliran selesai (`end`), sisa antrean dipercepat agar tambahan waktu
 * tunggu tidak melebihi `maxTailMs`. Modul ini murni soal waktu + string;
 * penulisan ke layar diserahkan lewat callback `write`.
 */

/** Ambang "teks panjang" dalam kata. Di atas ini animasi makin cepat. */
export const LONG_TEXT_WORDS = 1500;
/** Perkiraan karakter per kata (termasuk spasi) untuk menghitung ambang. */
export const CHARS_PER_WORD = 6;
/** Ambang teks panjang dalam karakter (≈1500 kata). */
export const LONG_TEXT_CHARS = LONG_TEXT_WORDS * CHARS_PER_WORD;

/** Batas antrean; di atas ini animasi dilewati agar memori/waktu tetap wajar. */
const MAX_PENDING = 50_000;

export interface TypewriterSpeed {
  /** Jeda per karakter untuk teks pendek (ms). */
  baseDelayMs?: number;
  /** Jeda per karakter paling cepat (ms). */
  minDelayMs?: number;
  /** Ambang teks panjang dalam karakter (default ≈1500 kata). */
  longTextChars?: number;
  /** Backlog (karakter) yang memicu percepatan. */
  maxBacklogChars?: number;
  /** Interval pengurasan antrean (ms). */
  tickMs?: number;
  /** Batas tambahan waktu saat menyelesaikan sisa antrean (ms). */
  maxTailMs?: number;
}

type ResolvedSpeed = Required<TypewriterSpeed>;

export const DEFAULT_SPEED: ResolvedSpeed = {
  baseDelayMs: 12,
  minDelayMs: 0.1,
  longTextChars: LONG_TEXT_CHARS,
  maxBacklogChars: 600,
  tickMs: 12,
  maxTailMs: 2500,
};

function resolveSpeed(speed: TypewriterSpeed = {}): ResolvedSpeed {
  return { ...DEFAULT_SPEED, ...speed };
}

/**
 * Jeda per karakter (ms) untuk panjang total dan antrean tertentu.
 * Panjang total > `longTextChars` dan backlog > `maxBacklogChars` sama-sama
 * mempercepat; hasilnya tidak pernah lebih cepat dari `minDelayMs`.
 */
export function charDelayMs(
  totalChars: number,
  pendingChars = 0,
  speed: TypewriterSpeed = {},
): number {
  const cfg = resolveSpeed(speed);
  let delay = cfg.baseDelayMs;
  if (totalChars > cfg.longTextChars) {
    delay = Math.max(cfg.minDelayMs, (delay * cfg.longTextChars) / totalChars);
  }
  if (pendingChars > cfg.maxBacklogChars) {
    delay = Math.max(cfg.minDelayMs, (delay * cfg.maxBacklogChars) / pendingChars);
  }
  return delay;
}

/**
 * Jeda saat menuntaskan antrean di akhir giliran: cukup cepat agar sisa
 * animasi selesai dalam `maxTailMs`, tapi tetap tidak lebih cepat dari `min`.
 */
export function tailDelayMs(pendingChars: number, speed: TypewriterSpeed = {}): number {
  const cfg = resolveSpeed(speed);
  if (pendingChars <= 0) return cfg.baseDelayMs;
  return Math.max(cfg.minDelayMs, Math.min(cfg.baseDelayMs, cfg.maxTailMs / pendingChars));
}

/**
 * Panjang potongan aman untuk `text` sebanyak `count` karakter tampilan.
 * Urutan escape ANSI tidak dihitung sebagai karakter dan tidak pernah terpotong,
 * begitu pula pasangan surrogate (emoji di luar BMP).
 */
export function safeCut(text: string, count: number): number {
  const limit = Math.max(1, Math.floor(count));
  let i = 0;
  let taken = 0;
  while (i < text.length && taken < limit) {
    if (text[i] === "\u001b") {
      const match = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (match) {
        i += match[0].length;
        continue;
      }
    }
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      i += next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    } else {
      i += 1;
    }
    taken += 1;
  }
  return i;
}

/** Penguras antrean teks dengan efek mengetik. */
export class Typewriter {
  private queue = "";
  private total = 0;
  private tail = false;
  private tailDelay = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveEnd?: () => void;
  private readonly speed: ResolvedSpeed;

  constructor(
    private readonly write: (chunk: string) => void,
    speed: TypewriterSpeed = {},
  ) {
    this.speed = resolveSpeed(speed);
  }

  /** Karakter yang masih menunggu dianimasikan. */
  get pending(): number {
    return this.queue.length;
  }

  /** Antrekan potongan baru; animasi berjalan sendiri sampai antrean habis. */
  push(chunk: string): void {
    if (!chunk) return;
    this.total += chunk.length;
    this.queue += chunk;
    if (this.queue.length > MAX_PENDING) {
      // Teks sangat besar (mis. provider tanpa streaming): jangan animasikan.
      this.flush();
      return;
    }
    if (!this.timer) this.pump();
  }

  /**
   * Tuntaskan antrean. Sisa teks dipercepat agar animasi tidak menambah jeda
   * lebih dari `maxTailMs`. Promise selesai saat antrean benar-benar kosong.
   */
  end(): Promise<void> {
    if (this.queue.length === 0) {
      this.total = 0;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
      this.tail = true;
      // Bekukan jeda ekor sekarang: bila dihitung ulang tiap tick, sisa antrean
      // yang makin pendek justru memperlambat dan animasi tidak pernah selesai.
      this.tailDelay = tailDelayMs(this.queue.length, this.speed);
      if (!this.timer) this.pump();
    });
  }

  /** Buang sisa antrean tanpa animasi (mis. Ctrl+C atau overlay muncul). */
  flush(): void {
    this.clearTimer();
    const rest = this.queue;
    this.queue = "";
    this.total = 0;
    if (rest) this.write(rest);
    this.settle();
  }

  /** Hentikan timer tanpa menulis sisa (dipakai saat layar ditutup). */
  dispose(): void {
    this.clearTimer();
    this.queue = "";
    this.total = 0;
    this.tail = false;
    this.tailDelay = 0;
    this.resolveEnd = undefined;
  }

  private pump = (): void => {
    this.timer = undefined;
    if (this.queue.length === 0) {
      this.settle();
      return;
    }
    const delay = this.tail
      ? Math.min(charDelayMs(this.total, this.queue.length, this.speed), this.tailDelay)
      : charDelayMs(this.total, this.queue.length, this.speed);
    const perTick = Math.max(1, Math.round(this.speed.tickMs / delay));
    const cut = Math.max(1, safeCut(this.queue, perTick));
    const chunk = this.queue.slice(0, cut);
    this.queue = this.queue.slice(cut);
    this.write(chunk);
    if (this.queue.length === 0) {
      this.settle();
      return;
    }
    this.timer = setTimeout(this.pump, this.speed.tickMs);
  };

  private settle(): void {
    this.total = 0;
    this.tail = false;
    this.tailDelay = 0;
    const done = this.resolveEnd;
    this.resolveEnd = undefined;
    done?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
