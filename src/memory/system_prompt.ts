import { loadAgentsMd } from "./agents_md.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface SystemPromptInput {
  /** Path absolut project root. */
  workspaceRoot: string;
  /** Direktori konfigurasi global (untuk AGENTS.md global). */
  globalConfigDir: string;
  /** Skill yang terdeteksi (hanya name+description yang disuntik). */
  skills: Skill[];
  /** Muat aturan skill & buat-skill-sendiri. */
  skillsEnabled: boolean;
}

/**
 * Bangun system prompt dasar: identitas agent, aturan perilaku, konteks
 * AGENTS.md, dan daftar skill (progressive disclosure). Dipakai bersama oleh
 * CLI (`ChatApp`) dan server web agar tidak ada logika yang berbeda.
 */
export async function buildSystemPrompt(input: SystemPromptInput): Promise<string> {
  const memory = await loadAgentsMd({
    workspaceRoot: input.workspaceRoot,
    globalConfigDir: input.globalConfigDir,
  });
  const rules = [
    "- Selalu jawab setiap tool call dengan memanggil tool; jangan mengarang hasil.",
    "- Di mode Plan kamu hanya boleh membaca; jangan menulis file.",
    "- Buat perubahan kecil dan terarah; jangan mengubah file di luar tugas.",
    "- Perubahan file memerlukan persetujuan dan menampilkan diff; jelaskan alasan singkat.",
    "- Untuk tugas berlapis, pakai tool todo_write untuk mencatat rencana sebagai checklist, lalu perbarui statusnya (pending/in_progress/completed) seiring kemajuan.",
    "- Jangan pernah menulis kredensial ke file atau output.",
  ];
  if (input.skillsEnabled) {
    rules.push(
      "- Muat instruksi skill lewat tool `skill` saat tugas cocok dengan skill yang terdaftar.",
      "- Bila pengguna meminta, kamu boleh membuat skill baru dengan menulis `skills/<nama>/SKILL.md` (frontmatter `name` + `description`). Perubahan file tetap butuh konfirmasi.",
    );
  }
  const header = [
    "Kamu adalah agent CLI untuk rekayasa perangkat lunak, berjalan di terminal.",
    `Workspace: ${input.workspaceRoot}`,
    "",
    "Aturan:",
    ...rules,
  ].join("\n");
  const base = memory.content ? `${header}\n\n# Konteks proyek (AGENTS.md)\n${memory.content}` : header;
  const skillsSection = formatSkillsForPrompt(input.skills);
  return skillsSection ? `${base}\n\n${skillsSection}` : base;
}
