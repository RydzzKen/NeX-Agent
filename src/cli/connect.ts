import type { ModelProvider } from "../providers/provider.js";
import type { CredentialStore } from "../config/credentials.js";
import type { PrompterLike } from "./prompt.js";
import { BUILTIN_PROVIDERS, createProvider, customKey } from "../providers/factory.js";

export interface ConnectResult {
  providerKey: string;
  provider: ModelProvider;
}

const MENU = [
  ...BUILTIN_PROVIDERS.map((p) => ({ key: p.key, label: p.label })),
  { key: "custom", label: "Custom (kompatibel OpenAI)" },
];

/** Alur `/connect` interaktif. */
export async function runConnect(
  prompter: PrompterLike,
  credentials: CredentialStore,
  fetchImpl?: typeof fetch,
): Promise<ConnectResult | undefined> {
  process.stdout.write("\nPilih provider:\n");
  MENU.forEach((item, i) => process.stdout.write(`  ${i + 1}) ${item.label}\n`));
  const choice = (await prompter.question("Nomor provider: ")).trim();
  const index = Number.parseInt(choice, 10) - 1;
  const selected = MENU[index];
  if (!selected) {
    process.stdout.write("Pilihan tidak valid.\n");
    return undefined;
  }

  if (selected.key === "custom") {
    return connectCustom(prompter, credentials, fetchImpl);
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
