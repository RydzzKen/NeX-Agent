/**
 * Klasifikasi perintah shell menjadi tiga tingkat:
 * - `safe`    : read-only, boleh jalan tanpa konfirmasi.
 * - `confirm` : mutating, butuh persetujuan pengguna.
 * - `block`   : destruktif, selalu diblokir.
 *
 * Ini heuristik konservatif: apa pun yang tidak dikenali dianggap `confirm`,
 * bukan `safe`.
 */

export type ShellRisk = "safe" | "confirm" | "block";

export interface ShellClassification {
  risk: ShellRisk;
  reason?: string;
  /** Segmen berisiko tertinggi (untuk ditampilkan). */
  segment?: string;
}

const BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: "fork bomb" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\/\*|~|~\/\*|\$HOME)(\s|$)/i, reason: "rm -rf pada root/home" },
  { re: /\brm\s+-rf\s+\*/i, reason: "rm -rf wildcard" },
  { re: /\b(mkfs|mke2fs|fdisk|parted)\b/i, reason: "operasi filesystem" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "dd ke block device" },
  { re: /(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, reason: "pipe jaringan ke shell" },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: "tulis ke block device" },
  { re: /\bchmod\s+-R\s+0?777\s+\/(\s|$)/i, reason: "chmod 777 pada root" },
  { re: /\bchown\s+-R\b[^\n]*\s\/(\s|$)/i, reason: "chown rekursif pada root" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "kontrol daya sistem" },
  { re: /:\s*>\s*\/dev\/(sd|nvme|hd|disk)/i, reason: "tulis langsung ke block device" },
];

const SAFE_COMMANDS = new Set([
  "ls", "dir", "vdir", "cat", "bat", "head", "tail", "less", "more",
  "grep", "rg", "egrep", "fgrep", "fd", "pwd", "echo", "printf", "wc",
  "file", "stat", "du", "df", "tree", "uname", "whoami", "id", "hostname",
  "date", "which", "whereis", "type", "env", "printenv", "basename",
  "dirname", "realpath", "readlink", "sort", "uniq", "cut", "tr", "nl",
  "tac", "diff", "cmp", "comm", "seq", "jq", "yq", "true", "false",
  "test", "sleep", "column", "xxd", "od", "hexdump", "md5sum", "sha256sum",
]);

/** Subcommand git yang aman (read-only). */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "describe",
  "blame", "ls-files", "ls-tree", "shortlog", "grep", "whatchanged",
  "cat-file", "name-rev", "reflog", "remote", "config", "branch", "tag",
  "stash", "fetch", "version",
]);

/** Pola redireksi tulis ke file. */
const WRITE_REDIRECT = /(^|[^0-9])>>?\s*[^\s&|]/;

function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\||&)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstWord(segment: string): string {
  const m = segment.match(/^[A-Za-z0-9_./-]+/);
  return m ? m[0]! : "";
}

function baseName(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

function classifySegment(raw: string): ShellClassification {
  const segment = raw.replace(/^\s+/, "").replace(/^(sudo|doas)\s+/, "");
  const cmd = baseName(firstWord(segment));
  const lower = segment.toLowerCase();

  if (WRITE_REDIRECT.test(segment)) {
    return { risk: "confirm", reason: "redireksi tulis ke file", segment: raw };
  }

  if (cmd === "git") {
    const sub = segment.split(/\s+/)[1] ?? "";
    const subLower = sub.toLowerCase();
    if (SAFE_GIT_SUBCOMMANDS.has(subLower)) {
      // `git branch -d`, `git tag -d`, `git remote add/set-url`, `git config` tulis → confirm
      if (
        /(^|\s)(-d|-D|--delete|--set-url|--add|--remove|--edit|--unset|--global|--local)\b/.test(segment) &&
        subLower !== "config"
      ) {
        return { risk: "confirm", reason: `git ${sub} mengubah state`, segment: raw };
      }
      if (subLower === "config" && !/(--get|--get-all|--list|-l|--get-regexp)/.test(segment)) {
        return { risk: "confirm", reason: "git config menulis", segment: raw };
      }
      if (subLower === "stash" && /(pop|apply|drop|clear|push|save)/.test(segment)) {
        return { risk: "confirm", reason: "git stash mengubah state", segment: raw };
      }
      if (subLower === "tag" && /\s-[a-zA-Z]|\s\S+\s*$/i.test(sub) === false && /-a|-m|-d|-f/.test(segment)) {
        return { risk: "confirm", reason: "git tag menulis", segment: raw };
      }
      return { risk: "safe", segment: raw };
    }
    return { risk: "confirm", reason: `git ${sub || "(tanpa subcommand)"}`, segment: raw };
  }

  if (cmd === "find" || cmd === "fd") {
    if (/(^|\s)(-delete|-exec|-execdir|-ok|-okdir)\b/.test(segment)) {
      return { risk: "confirm", reason: "find dengan aksi mutating", segment: raw };
    }
    return { risk: "safe", segment: raw };
  }

  if (cmd === "sed" || cmd === "perl") {
    if (/(^|\s)-i\b|in-place/.test(segment)) {
      return { risk: "confirm", reason: "edit in-place", segment: raw };
    }
    return { risk: "safe", segment: raw };
  }

  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "cargo", "go"].includes(cmd)) {
    const sub = segment.split(/\s+/)[1] ?? "";
    if (/^(--version|-v|ls|list|why|outdated|view|info|show|search|ping|--help|-h)$/.test(sub)) {
      return { risk: "safe", segment: raw };
    }
    return { risk: "confirm", reason: `${cmd} ${sub}`, segment: raw };
  }

  if (SAFE_COMMANDS.has(cmd)) {
    return { risk: "safe", segment: raw };
  }

  if (cmd === "") {
    return { risk: "confirm", reason: "perintah tidak dikenali", segment: raw };
  }

  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|install|tee|truncate)\b/.test(lower)) {
    return { risk: "confirm", reason: "perintah mutating", segment: raw };
  }

  return { risk: "confirm", reason: `tidak dikenali: ${cmd}`, segment: raw };
}

export function classifyShell(command: string): ShellClassification {
  const trimmed = command.trim();
  if (trimmed === "") return { risk: "confirm", reason: "perintah kosong" };

  for (const { re, reason } of BLOCK_PATTERNS) {
    if (re.test(trimmed)) return { risk: "block", reason, segment: trimmed };
  }

  const segments = splitSegments(trimmed);
  let result: ShellClassification = { risk: "safe" };
  let sawConfirm: ShellClassification | undefined;

  for (const seg of segments) {
    const c = classifySegment(seg);
    if (c.risk === "block") return c;
    if (c.risk === "confirm" && !sawConfirm) sawConfirm = c;
  }

  if (sawConfirm) result = sawConfirm;

  // Pipe jaringan ke interpreter sudah ditangkap block di atas; tambahan:
  if (/\|\s*(ba|z|k)?sh\b/.test(trimmed) && /(curl|wget|nc|ncat)\b/.test(trimmed)) {
    return { risk: "block", reason: "pipe jaringan ke shell", segment: trimmed };
  }

  return result;
}
