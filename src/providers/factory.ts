import type { CredentialStore } from "../config/credentials.js";
import type { ModelProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider, createCustomProvider } from "./openai.js";

export interface BuiltinProvider {
  key: string;
  label: string;
  /** URL dasar bawaan adapter (boleh ditimpa pengguna). */
  baseURL?: string;
  requiresApiKey: boolean;
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  { key: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com", requiresApiKey: true },
  { key: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", requiresApiKey: true },
];

export const CUSTOM_PROVIDER_PREFIX = "custom:";

/** Bangun adapter provider dari kredensial tersimpan. */
export async function createProvider(
  providerKey: string,
  credentials: CredentialStore,
  fetchImpl?: typeof fetch,
): Promise<ModelProvider | undefined> {
  const creds = (await credentials.get(providerKey)) ?? {};

  if (providerKey === "anthropic") {
    return new AnthropicProvider({
      ...(creds.apiKey !== undefined ? { apiKey: creds.apiKey } : {}),
      ...(creds.baseURL !== undefined ? { baseURL: creds.baseURL } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  if (providerKey === "openai") {
    return new OpenAICompatibleProvider({
      id: "openai",
      label: "OpenAI",
      baseURL: creds.baseURL ?? "https://api.openai.com/v1",
      ...(creds.apiKey !== undefined ? { apiKey: creds.apiKey } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  if (providerKey.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    const name = providerKey.slice(CUSTOM_PROVIDER_PREFIX.length);
    return createCustomProvider(name, creds, fetchImpl);
  }

  return undefined;
}

export function customKey(name: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${name}`;
}
