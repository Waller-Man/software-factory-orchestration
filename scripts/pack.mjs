import { mkdir, cp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { root } from '../../gateway/scripts/dev.mjs';
const dir = join(root, 'packages/orchestration'), release = join(dir, 'artifacts/release/software-factory-orchestration');
await mkdir(release, { recursive: true });
for (const path of ['lib', 'skills', 'locale', 'docs/images', 'README.md', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml', 'icon.svg', 'package.json']) await cp(join(dir, path), join(release, path), { recursive: true });
const manifest = JSON.parse(await readFile(join(release, 'package.json'), 'utf8')); delete manifest.scripts;
await writeFile(join(release, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const path of ['lib/index.js', 'lib/preset.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'lib/types.d.ts', 'skills/agent-selection/SKILL.md', 'icon.svg']) await readFile(join(release, path));
for (const file of await readdir(join(release, 'lib'))) {
  if (!file.endsWith('.d.ts')) continue;
  const source = await readFile(join(release, 'lib', file), 'utf8');
  for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
    if (match[1].endsWith('.ts')) throw new Error('Source extension in published declaration: ' + file);
    await access(resolve(release, 'lib', dirname(file), match[1].replace(/\.js$/, '.d.ts')));
  }
}
const icon = await readFile(join(release, 'icon.svg'), 'utf8');
if (!icon.includes('<svg') || !icon.includes('viewBox="0 0 64 64"') || Buffer.byteLength(icon) > 256 * 1024) throw new Error('Invalid display icon');
await writeFile(join(dir, 'artifacts/package-check.json'), JSON.stringify({ declarationImports: 'passed', displayResources: 'present', installed: false }, null, 2));
console.log(JSON.stringify({ directory: release, built: true, declarationImports: 'passed', installed: false }));
