/** Build using the existing local DSH toolchain, without network or profile changes. */
import { mkdir, cp, copyFile, writeFile, readFile, readdir, lstat, realpath, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root, host, hostRequire, prepare } from '../../gateway/scripts/dev.mjs';
await prepare();
const presetRequire = createRequire(join(host, 'packages/preset/agent-preset-registry/package.json'));
for (const name of ['js-yaml', '@types/js-yaml']) {
  const target = join(root, 'node_modules', name), source = dirname(presetRequire.resolve(name + '/package.json'));
  await mkdir(dirname(target), { recursive: true });
  try { await lstat(target); if (await realpath(target) !== await realpath(source) && (await readFile(join(target, '.sf-selection-source'), 'utf8')).trim() !== source) throw new Error('Dependency target differs: ' + name); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (linkError) { if (linkError.code !== 'EPERM') throw linkError; await cp(source, target, { recursive: true }); await writeFile(join(target, '.sf-selection-source'), source); }
  }
}
const packageDir = join(root, 'packages/orchestration'), stage = join(packageDir, 'artifacts/analysis');
const compile = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-p', join(packageDir, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const target = join(stage, 'packages/orchestration'), protocol = join(stage, 'packages/protocol');
await mkdir(target, { recursive: true }); await mkdir(protocol, { recursive: true });
await cp(join(packageDir, 'src'), join(target, 'src'), { recursive: true });
for (const file of ['package.json', 'tsconfig.json']) await copyFile(join(packageDir, file), join(target, file));
await cp(join(host, 'packages/typert/protocol/src'), join(protocol, 'src'), { recursive: true });
await copyFile(join(host, 'packages/typert/protocol/package.json'), join(protocol, 'package.json'));
await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
await writeFile(join(stage, 'tsconfig.host.json'), JSON.stringify({ files: [], references: [{ path: 'packages/orchestration' }, { path: 'packages/protocol' }], compilerOptions: { target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, baseUrl: '.', paths: { '@deepseek-ai/dsh-typert-protocol': ['packages/protocol/src/index.ts'] }, ignoreDeprecations: '6.0' } }));
await writeFile(join(stage, 'tsconfig.client.json'), JSON.stringify({ files: ['packages/orchestration/src/types.ts'] }));
const { WorkspaceTypertGenerator } = await import('@deepseek-ai/dsh-typert-generator');
const outputs = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false }).generate(['@software-factory/orchestration'], ['host']);
if (outputs.length !== 1 || !outputs[0].remote) throw new Error('Missing generated Orchestration descriptors');
await writeFile(join(stage, 'typert.host.js'), outputs[0].js);
await writeFile(join(stage, 'typert.remote-client.js'), outputs[0].remote.js);
await writeFile(join(packageDir, 'lib/typert.host.d.ts'), outputs[0].dts);
await writeFile(join(packageDir, 'lib/typert.remote-client.d.ts'), outputs[0].remote.dts);
const { build } = await import(pathToFileURL(hostRequire.resolve('tsdown'))), ts = hostRequire('typescript');
const decorators = { name: 'selection-decorators', transform(code, id) { if (!id.endsWith('.ts') || !/^\s*@/m.test(code)) return; return { code: ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, map: null }; } };
for (const entry of ['typert.host', 'typert.remote-client']) await build({ config: false, entry: { [entry]: join(stage, entry + '.js') }, outDir: join(packageDir, 'lib'), platform: 'neutral', format: 'esm', clean: false, dts: false, deps: { onlyBundle: ['zod'] }, outputOptions: { entryFileNames: entry + '.js' } });
for (const entry of ['index', 'preset']) await build({ config: false, entry: { [entry]: join(packageDir, 'src', entry + '.ts') }, outDir: join(packageDir, 'lib'), platform: 'node', format: 'esm', clean: false, dts: false, deps: { onlyBundle: ['zod', 'js-yaml'], neverBundle: [/^@deepseek-ai\//] }, plugins: [decorators], outputOptions: { entryFileNames: entry + '.js' } });
for (const file of await readdir(join(packageDir, 'lib'))) {
  if (!file.endsWith('.d.ts')) continue;
  const path = join(packageDir, 'lib', file);
  await writeFile(path, (await readFile(path, 'utf8')).replace(/(from ['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
const noticePath = join(packageDir, 'THIRD_PARTY_NOTICES.md');
const notices = (await readFile(noticePath, 'utf8')).split('\n## js-yaml')[0];
await writeFile(noticePath, notices.trimEnd() + '\n\n## js-yaml — MIT License\n\n' + await readFile(join(dirname(presetRequire.resolve('js-yaml/package.json')), 'LICENSE'), 'utf8') + '\n\n## DeepSeek Harness — MIT License\n\nNative composition tree ownership follows the host preset implementation.\n\n' + await readFile(join(host, 'LICENSE'), 'utf8'));
console.log('Built Agent orchestration backend, preset and four generated Remote methods.');
