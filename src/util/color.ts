let enabled: boolean =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  Boolean(process.stdout.isTTY);

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

function parseForceColor(v?: string): number {
  if (!v || v === "0") return 0;
  if (v === "1" || v === "true") return 1;
  if (v === "2") return 2;
  if (v === "3") return 3;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.min(3, n));
  return 1;
}

const force = parseForceColor(process.env.FORCE_COLOR);
export const truecolorSupported: boolean =
  enabled &&
  (process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    force >= 3);

export function rgb(r: number, g: number, b: number, bg = false): (s: string) => string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const R = clamp(r), G = clamp(g), B = clamp(b);
  const code = bg ? `48;2;${R};${G};${B}` : `38;2;${R};${G};${B}`;
  return (s: string) => (enabled && truecolorSupported ? `\u001b[${code}m${s}\u001b[0m` : s);
}

function wrap(code: string, close: string): (s: string) => string {
  return (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[${close}m` : s);
}

export const color = {
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  brightGreen: wrap("92", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  dim: wrap("2", "22"),
  bold: wrap("1", "22"),
  inverse: wrap("7", "27"),
  underline: wrap("4", "24"),
  italic: wrap("3", "23"),
  strike: wrap("9", "29"),
  rgb,
  truecolor: truecolorSupported,
} as const;
