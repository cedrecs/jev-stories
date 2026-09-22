// Bundles Discord's Embedded App SDK and the packages it depends on into one
// file the game loads only when it runs inside Discord, and writes the
// licences of everything bundled next to it. The game has no build step:
// rerun this only to update the SDK.
//
//   npm run discord-sdk

import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
const pkg = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
const sdk = pkg('@discord/embedded-app-sdk');
mkdirSync(out, { recursive: true });

const result = await build({
  stdin: { contents: "export { DiscordSDK } from '@discord/embedded-app-sdk';", resolveDir: root, loader: 'js' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  metafile: true,
  banner: { js: `/* ${sdk.name} ${sdk.version} and the packages it bundles; licences in discord-sdk.LICENSES.txt */` },
  outfile: join(out, 'discord-sdk.js'),
});

// Every package that ended up in the bundle, with its licence text. The SDK
// ships its own copies of its dependencies under output/lib/<package>, so
// those count too; their licence texts come from the installed packages.
const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.replace(/\\/g, '/');
  const m = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) names.add(m[1]);
  const lib = path.match(/embedded-app-sdk\/output\/lib\/((?:@[^/]+\/)?[^/]+)\//);
  if (lib) names.add(lib[1]);
}
const parts = [...names].sort().map((name) => {
  const dir = join(root, 'node_modules', name);
  const p = pkg(name);
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `No licence file shipped; package.json says: ${p.license || 'nothing'}`;
  return `${name} ${p.version} (${p.license || 'unknown'})\n${'='.repeat(60)}\n${text}\n`;
});
writeFileSync(join(out, 'discord-sdk.LICENSES.txt'), parts.join('\n'));
const bytes = readFileSync(join(out, 'discord-sdk.js')).length;
console.log(`wrote public/vendor/discord-sdk.js (${Math.round(bytes / 1024)} KB) bundling ${[...names].sort().join(', ')}`);
