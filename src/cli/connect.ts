import type { ModelProvider } from "../providers/provider.js";
import type { CredentialStore } from "../config/credentials.js";
import type { PrompterLike } from "./prompt.js";
import {
  BUILTIN_PROVIDERS,
  CUSTOM_PROVIDER_PREFIX,
  createProvider,
  customKey,
} from "../providers/factory.js";

export interface ConnectResult {
  providerKey: string;
  provider: ModelProvider;
}

/**
 * Susun menu `/connect`: provider bawaan, lalu provider custom yang sudah
 * tersimpan (agar bisa dipakai ulang, bukan bikin baru), lalu opsi custom baru.
 * Bawaan yang sudah tersimpan tidak diduplikasi.
 */
export function buildConnectMenu(saved: string[]): Array<{ key: string; label: string }> {
  const builtinKeys = new Set(BUILTIN_PROVIDERS.map((p) => p.key));
  const menu = BUILTIN_PROVIDERS.map((p) => ({ key: p.key, label: p.label }));
  const custom = saved
    .filter((key) => key.startsWith(CUSTOM_PROVIDER_PREFIX) && !builtinKeys.has(key))
    .sort()
    .map((key) => ({ key, label: `${key} (tersimpan)` }));
  return [...menu, ...custom, { key: "custom", label: "Custom baru (kompatibel OpenAI)" }];
}

/** Basis URL bawaan untuk provider builtin (untuk ditampilkan bila tak ada nilai tersimpan). */
export function defaultBaseURL(key: string): string | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.key === key)?.baseURL;
}

export interface ProviderView {
  key: string;
  baseURL: string;
  hasApiKey: boolean;
  active: boolean;
  isDefault: boolean;
}

/** Satu baris ringkasan provider untuk `/provider` (tanpa membocorkan nilai kunci). */
export function describeProvider(view: ProviderView): string {
  const mark = view.active ? "*" : " ";
  const base = view.baseURL || "-";
  const keyState = view.hasApiKey ? "api key ok" : "tanpa api key";
  const def = view.isDefault ? "  (default)" : "";
  return `${mark} ${view.key.padEnd(22)} ${base}  ${keyState}${def}`;
}

/** Alur `/connect` interaktif. */
export async function runConnect(
  prompter: PrompterLike,
  credentials: CredentialStore,
  fetchImpl?: typeof fetch,
): Promise<ConnectResult | undefined> {
  const saved = await credentials.list();
  const menu = buildConnectMenu(saved);

  process.stdout.write("\nPilih provider:\n");
  menu.forEach((item, i) => process.stdout.write(`  ${i + 1}) ${item.label}\n`));
  const choice = (await prompter.question("Nomor provider: ")).trim();
  const index = Number.parseInt(choice, 10) - 1;
  const selected = menu[index];
  if (!selected) {
    process.stdout.write("Pilihan tidak valid.\n");
    return undefined;
  }

  if (selected.key === "custom") {
    return connectCustom(prompter, credentials, fetchImpl);
  }

  // Provider yang sudah tersimpan dipakai ulang tanpa menanyakan ulang kunci.
  if (saved.includes(selected.key)) {
    const provider = await createProvider(selected.key, credentials, fetchImpl);
    if (!provider) return undefined;
    process.stdout.write(`Memakai ${selected.key} yang tersimpan.\n`);
    return { providerKey: selected.key, provider };
  }

  const apiKey = (await prompter.question(`API key ${selected.label}: `)).trim();
  if (!apiKey) {
    process.stdout.write("API key kosong; dibatalkan.\n");
    return undefined;
  }
  await credentials.set(selected.key, { apiKey });
  const provider = await createProvider(selected.key, credentials, fetchImpl);
  if (!provider) return undefined;
  return { providerKey: selected.key, provider };
}

async function connectCustom(
  prompter: PrompterLike,
  credentials: CredentialStore,
  fetchImpl?: typeof fetch,
): Promise<ConnectResult | undefined> {
  const name = (await prompter.question("Nama provider (mis. 9router): ")).trim();
  if (!name) {
    process.stdout.write("Nama kosong; dibatalkan.\n");
    return undefined;
  }
  const baseURL = (await prompter.question("Base URL (mis. http://localhost:20128/v1): ")).trim();
  if (!baseURL) {
    process.stdout.write("Base URL kosong; dibatalkan.\n");
    return undefined;
  }
  const apiKey = (await prompter.question("API key (boleh kosong): ")).trim();

  const key = customKey(name);
  await credentials.set(key, { baseURL, ...(apiKey ? { apiKey } : {}) });
  const provider = await createProvider(key, credentials, fetchImpl);
  if (!provider) return undefined;

  process.stdout.write(`Mendeteksi model dari ${baseURL}...\n`);
  try {
    const models = await provider.listModels();
    if (models.length) {
      process.stdout.write(`Terdeteksi ${models.length} model.\n`);
    } else {
      process.stdout.write("Tidak ada model terdeteksi; masukkan nama model manual.\n");
    }
  } catch (err) {
    process.stdout.write(`Deteksi model gagal (${(err as Error).message}); masukkan nama model manual.\n`);
  }
  return { providerKey: key, provider };
}
