// Writes the Tauri updater manifest (latest.json) for a release from the signed bundles in a directory:
//   node .github/scripts/updater-manifest.ts <artifact dir> <tag> <repository>
// Each `<bundle>.sig` holds the minisign signature of the bundle published next to it. Without any
// signature (no signing key in CI) no manifest is written, and installed apps simply find no update.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, repo] = process.argv.slice(2);
if (!dir || !tag || !repo) throw new Error('usage: updater-manifest.ts <dir> <tag> <owner/repo>');

// The updater looks up `<os>-<arch>-<installer>` first and `<os>-<arch>` after it, so the
// installer the app is normally installed with also takes the plain key.
const KINDS: Array<{ suffix: string; keys: string[] }> = [
  { suffix: '-setup.exe', keys: ['windows-x86_64-nsis', 'windows-x86_64'] },
  { suffix: '.msi', keys: ['windows-x86_64-msi'] },
  { suffix: '.AppImage', keys: ['linux-x86_64-appimage', 'linux-x86_64'] },
  { suffix: '.deb', keys: ['linux-x86_64-deb'] },
  { suffix: '.rpm', keys: ['linux-x86_64-rpm'] },
];

const platforms: Record<string, { signature: string; url: string }> = {};
for (const sig of readdirSync(dir).filter((f) => f.endsWith('.sig'))) {
  const bundle = sig.slice(0, -'.sig'.length);
  const kind = KINDS.find((k) => bundle.endsWith(k.suffix));
  if (!kind) continue;
  const entry = {
    signature: readFileSync(join(dir, sig), 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(bundle)}`,
  };
  for (const key of kind.keys) platforms[key] = entry;
}

if (Object.keys(platforms).length === 0) {
  console.log('::warning title=No updater manifest::no signed updater bundles were built, so latest.json is not published');
  process.exit(0);
}
const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
