import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const otherRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!otherRoot) {
  throw new Error('Usage: npm run parity:compare -- /absolute/path/to/the/other/mcp-directory');
}

const files = [
  'bin/server.mjs',
  'core/http.mjs',
  'core/server.mjs',
  'core/webhoundClient.mjs',
];
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
for (const file of files) {
  const [current, other] = await Promise.all([
    hash(path.join(root, file)),
    hash(path.join(otherRoot, file)),
  ]);
  if (current !== other) throw new Error(`Runtime parity failed: ${file} differs`);
}
const [currentPackage, otherPackage] = await Promise.all([
  readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(otherRoot, 'package.json'), 'utf8').then(JSON.parse),
]);
if (currentPackage.version !== otherPackage.version) {
  throw new Error(`Runtime parity failed: package versions differ (${currentPackage.version} vs ${otherPackage.version})`);
}
console.log(`Runtime parity verified: ${files.length} files and package version ${currentPackage.version}.`);
