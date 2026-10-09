import fs from "node:fs/promises";
import path from "node:path";

/**
 * Agent Skills (SKILL.md).
 *
 * Sebuah "skill" adalah folder berisi `SKILL.md` dengan frontmatter sederhana
 * (`name`, `description`) plus isi instruksi. Format ini dipakai ekosistem
 * Agent Skills (mis. Anthropic frontend-design, keluaran SkillUI, skill Strix).
 *
 * Strategi: hanya `name` + `description` yang disuntik ke system prompt
 * (progressive disclosure); isi lengkap dimuat saat model memanggil tool
 * `skill`, atau saat pengguna memaksa lewat `/skill <nama>`.
 */

export interface Skill {
  name: string;
  description: string;
  /** Path absolut ke SKILL.md. */
  path: string;
  /** Folder skill; dipakai untuk file referensi (references/, assets/, ...). */
  dir: string;
  /** Isi SKILL.md tanpa frontmatter. */
  body: string;
}

export interface SkillLoadOptions {
  workspaceRoot: string;
  globalConfigDir: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const data: Record<string, string> = {};
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { data, body: text };

  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data, body: text };

  const frontmatter = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const lines = frontmatter.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const key = match[1]!;
    let value = match[2] ?? "";

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s+/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "").trim() === "")
      ) {
        i++;
        block.push((lines[i] ?? "").replace(/^\s+/, ""));
      }
      value = value.startsWith("|") ? block.join("\n").trimEnd() : block.join(" ").trim();
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }

  return { data, body };
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return "";
}

async function readSkillFile(file: string): Promise<Skill | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const dir = path.dirname(file);
  const { data, body } = parseFrontmatter(raw);
  const name = (data.name ?? path.basename(dir)).trim();
  if (!name) return undefined;
  const description = (data.description ?? firstMeaningfulLine(body)).trim();
  return { name, description, path: file, dir, body: body.trim() };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Temukan semua skill dari folder global lalu workspace. Bila nama sama,
 * definisi workspace (lebih spesifik) menimpa global.
 */
export async function discoverSkills(opts: SkillLoadOptions): Promise<Skill[]> {
  const dirs = [
    path.join(opts.globalConfigDir, "skills"),
    path.join(opts.workspaceRoot, "skills"),
    path.join(opts.workspaceRoot, ".nex-agent", "skills"),
  ];

  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    for (const entry of await listDir(dir)) {
      const skill = await readSkillFile(path.join(dir, entry, "SKILL.md"));
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Ringkasan skill untuk system prompt: hanya nama + deskripsi (murah), dengan
 * instruksi agar model memuat isi lengkap lewat tool `skill` saat relevan.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "# Skill tersedia",
    "Kamu punya skill terspesialisasi. Saat tugas cocok dengan salah satunya, panggil tool `skill` dengan nama skill tersebut untuk memuat instruksi lengkapnya sebelum mengerjakan.",
    ...skills.map((s) => `- ${s.name}: ${truncate(s.description, 200)}`),
  ].join("\n");
}
