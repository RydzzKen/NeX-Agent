/**
 * Deteksi pengulangan (F-02).
 *
 * Sidik jari = nama tool + argumen + hasil. Dianggap berulang bila:
 * - panggilan identik muncul 3 kali berturut-turut, atau
 * - pola dua panggilan bergantian (ABABAB) mencapai 3 siklus.
 */
export class RepetitionDetector {
  private readonly history: string[] = [];
  private readonly maxHistory = 12;

  /** Catat sidik jari dan kembalikan true bila pengulangan terdeteksi. */
  check(signature: string): boolean {
    this.history.push(signature);
    if (this.history.length > this.maxHistory) this.history.shift();
    return this.isTripleRepeat() || this.isAlternatingCycle();
  }

  private isTripleRepeat(): boolean {
    const n = this.history.length;
    if (n < 3) return false;
    const a = this.history[n - 1];
    return a === this.history[n - 2] && a === this.history[n - 3];
  }

  private isAlternatingCycle(): boolean {
    const n = this.history.length;
    if (n < 6) return false;
    const [a, b] = [this.history[n - 6], this.history[n - 5]];
    if (a === undefined || b === undefined || a === b) return false;
    return (
      this.history[n - 4] === a &&
      this.history[n - 3] === b &&
      this.history[n - 2] === a &&
      this.history[n - 1] === b
    );
  }

  reset(): void {
    this.history.length = 0;
  }
}

/** Bangun sidik jari dari komponen panggilan. */
export function fingerprint(name: string, args: string, result: string): string {
  return `${name}\u0001${args}\u0001${result}`;
}
