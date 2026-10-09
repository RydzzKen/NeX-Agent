import { color } from "../util/color.js";
import { formatTokens, formatUsdEstimate } from "../usage/cost.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { CrossSessionSummary, UsageRange } from "../usage/store.js";

export interface UsageViewOptions {
  contextWindow?: number;
  usedTokens?: number;
  maxCost?: number;
}

function rule(label: string): string {
  const width = Math.max(0, 38 - label.length);
  return color.gray(`─── ${label} ${"─".repeat(width)}`);
}

function human(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function bar(percent: number, width = 16): string {
  const filled = Math.round((Math.min(1, Math.max(0, percent)) * width));
  return color.green("█".repeat(filled)) + color.gray("░".repeat(width - filled));
}

export function renderUsage(tracker: UsageTracker, opts: UsageViewOptions = {}): string {
  const totals = tracker.totals();
  const lines: string[] = [];

  lines.push(rule("Sesi ini"));
  lines.push(`  ${"Panggilan model".padEnd(18)}${formatTokens(totals.calls)}`);
  lines.push(`  ${"Token masuk".padEnd(18)}${formatTokens(totals.usage.input)}`);
  lines.push(`  ${"Token keluar".padEnd(18)}${formatTokens(totals.usage.output)}`);
  if (totals.usage.cacheRead) {
    const saved = totals.cacheSaved ? `  (saved ${formatUsdEstimate(totals.cacheSaved)})` : "";
    lines.push(`  ${"Cache hit".padEnd(18)}${formatTokens(totals.usage.cacheRead)}${saved}`);
  }
  if (totals.costKnown) {
    lines.push(`  ${"Estimasi biaya".padEnd(18)}${color.bold(formatUsdEstimate(totals.cost))}`);
  } else {
    lines.push(`  ${"Estimasi biaya".padEnd(18)}${color.gray("tidak diketahui (harga model tidak tersedia)")}`);
  }

  if (opts.contextWindow && opts.usedTokens !== undefined) {
    const percent = opts.usedTokens / opts.contextWindow;
    lines.push("");
    lines.push(rule("Konteks"));
    lines.push(
      `  ${`${(percent * 100).toFixed(0)}% terpakai`.padEnd(18)}${human(opts.usedTokens)} / ${human(opts.contextWindow)} token`,
    );
  }

  if (opts.maxCost !== undefined) {
    const percent = totals.cost / opts.maxCost;
    const remaining = Math.max(0, opts.maxCost - totals.cost);
    lines.push("");
    lines.push(rule("Anggaran"));
    lines.push(`  ${"Sisa".padEnd(18)}${formatUsdEstimate(remaining)} dari ${formatUsdEstimate(opts.maxCost)}`);
    lines.push(`  ${bar(percent)}  ${(percent * 100).toFixed(0)}% terpakai`);
  }

  const perModel = tracker.perModel();
  if (perModel.length) {
    lines.push("");
    lines.push(rule("Per model"));
    for (const entry of perModel) {
      const label = `${entry.provider}/${entry.model}`;
      const cost = entry.costKnown ? formatUsdEstimate(entry.cost) : "~?";
      lines.push(`  ${label.padEnd(24)}${cost.padEnd(8)} (${entry.calls} panggilan)`);
    }
  }

  return lines.join("\n");
}

export function renderCrossSession(summary: CrossSessionSummary, range: UsageRange): string {
  const lines: string[] = [];
  lines.push(rule(`Rekap ${range}`));
  lines.push(`  ${"Panggilan model".padEnd(18)}${formatTokens(summary.totals.calls)}`);
  lines.push(`  ${"Token masuk".padEnd(18)}${formatTokens(summary.totals.usage.input)}`);
  lines.push(`  ${"Token keluar".padEnd(18)}${formatTokens(summary.totals.usage.output)}`);
  if (summary.totals.costKnown) {
    lines.push(`  ${"Estimasi biaya".padEnd(18)}${formatUsdEstimate(summary.totals.cost)}`);
  }
  if (summary.perModel.length) {
    lines.push("");
    lines.push(rule("Per model"));
    for (const entry of summary.perModel) {
      lines.push(
        `  ${`${entry.provider}/${entry.model}`.padEnd(24)}${formatUsdEstimate(entry.cost).padEnd(8)} (${entry.calls} panggilan)`,
      );
    }
  }
  return lines.join("\n");
}
