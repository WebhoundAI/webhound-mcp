import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: root,
  encoding: 'utf8',
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || 'npm pack --dry-run failed');
const output = JSON.parse(packed.stdout);
const files = output[0]?.files?.map(item => item.path) || [];
const required = ['package.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE', 'canonical-runtime.json', 'bin/server.mjs', 'core/http.mjs', 'core/server.mjs', 'core/webhoundClient.mjs', 'dist/webhound-mcp.mjs'];
for (const file of required) {
  if (!files.includes(file)) throw new Error(`Packed artifact is missing ${file}`);
}
const unexpected = files.filter(file => !required.includes(file));
if (unexpected.length > 0) throw new Error(`Packed artifact contains unexpected files: ${unexpected.join(', ')}`);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const serverJson = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8'));
const serverSource = await readFile(path.join(root, 'core/server.mjs'), 'utf8');
if (serverJson.version !== packageJson.version || serverJson.packages?.[0]?.version !== packageJson.version) {
  throw new Error('package.json and server.json versions differ');
}
if (!serverSource.includes(`export const VERSION = '${packageJson.version}'`)) {
  throw new Error('core/server.mjs VERSION differs from package.json');
}

for (const file of required.filter(file => /\.(?:mjs|json|md)$/.test(file))) {
  const text = await readFile(path.join(root, file), 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`Private key material found in ${file}`);
  if (/\bwh_[A-Za-z0-9]{20,}\b/.test(text)) throw new Error(`Webhound credential-like value found in ${file}`);
}
console.log(`Package dry-run verified: ${files.length} expected files, version ${packageJson.version}, no credential patterns.`);
