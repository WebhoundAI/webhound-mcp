import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'canonical-runtime.json');
const runtimeFiles = [
  'bin/server.mjs',
  'core/http.mjs',
  'core/server.mjs',
  'core/webhoundClient.mjs',
];

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashesFor(base) {
  return Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [
    file,
    await sha256(path.join(base, file)),
  ])));
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const current = {
  schema_version: 1,
  canonical_source: 'WebhoundAI/webhound-server:mcp',
  package_version: packageJson.version,
  files: await hashesFor(root),
};

if (process.argv.includes('--write')) {
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, manifestPath)}`);
  process.exit(0);
}

const canonicalFlag = process.argv.indexOf('--canonical');
if (canonicalFlag >= 0) {
  const canonicalDir = process.argv[canonicalFlag + 1];
  if (!canonicalDir) throw new Error('--canonical requires a directory');
  const canonicalHashes = await hashesFor(path.resolve(canonicalDir));
  for (const file of runtimeFiles) {
    if (canonicalHashes[file] !== current.files[file]) {
      throw new Error(`Runtime drift: ${file} differs from canonical ${canonicalDir}`);
    }
  }
}

const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
if (expected.canonical_source !== current.canonical_source) {
  throw new Error(`Manifest canonical source ${expected.canonical_source} does not match ${current.canonical_source}`);
}
if (expected.package_version !== current.package_version) {
  throw new Error(`Manifest version ${expected.package_version} does not match package ${current.package_version}`);
}
for (const file of runtimeFiles) {
  if (expected.files?.[file] !== current.files[file]) {
    throw new Error(`Runtime manifest mismatch for ${file}. Run the canonical sync, then regenerate the manifest.`);
  }
}
console.log(`Runtime parity manifest verified for ${runtimeFiles.length} files at ${current.package_version}.`);
