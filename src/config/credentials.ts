import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderCredentials } from "../providers/provider.js";
import { configDir } from "./config.js";

interface CredentialFile {
  [provider: string]: ProviderCredentials;
}

/**
 * Penyimpanan kredensial lokal dengan izin 600. Kredensial tidak pernah
 * dicetak ke layar atau log.
 */
export class CredentialStore {
  private readonly filePath: string;

  constructor(dir: string = configDir()) {
    this.filePath = path.join(dir, "credentials.json");
  }

  private async read(): Promise<CredentialFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as CredentialFile;
    } catch {
      return {};
    }
  }

  private async write(data: CredentialFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async get(provider: string): Promise<ProviderCredentials | undefined> {
    return (await this.read())[provider];
  }

  async set(provider: string, creds: ProviderCredentials): Promise<void> {
    const data = await this.read();
    data[provider] = creds;
    await this.write(data);
  }

  async delete(provider: string): Promise<boolean> {
    const data = await this.read();
    if (!(provider in data)) return false;
    delete data[provider];
    await this.write(data);
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.read());
  }
}
