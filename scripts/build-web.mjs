// Salin aset web + vendor (xterm) ke dist/web agar ikut terpasang.
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "web");

function packageDir(specifier) {
  const pkgJson = require.resolve(`${specifier}/package.json`);
  return path.dirname(pkgJson);
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "assets", "vendor"), { recursive: true });

const web = path.join(root, "web");
await cp(path.join(web, "index.html"), path.join(out, "index.html"));
await cp(path.join(web, "app.js"), path.join(out, "assets", "app.js"));
await cp(path.join(web, "styles.css"), path.join(out, "assets", "styles.css"));

const xterm = packageDir("@xterm/xterm");
await cp(path.join(xterm, "lib", "xterm.js"), path.join(out, "assets", "vendor", "xterm.js"));
await cp(path.join(xterm, "css", "xterm.css"), path.join(out, "assets", "vendor", "xterm.css"));

const fit = packageDir("@xterm/addon-fit");
await cp(path.join(fit, "lib", "addon-fit.js"), path.join(out, "assets", "vendor", "addon-fit.js"));

process.stdout.write("web assets → dist/web\n");
