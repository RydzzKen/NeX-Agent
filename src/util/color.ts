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

function wrap(code: string, close: string): (s: string) => string {
  return (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[${close}m` : s);
}

export const color = {
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  dim: wrap("2", "22"),
  bold: wrap("1", "22"),
  underline: wrap("4", "24"),
  italic: wrap("3", "23"),
  strike: wrap("9", "29"),
};
