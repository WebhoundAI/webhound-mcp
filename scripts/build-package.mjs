import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'webhound-mcp.mjs');

await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(root, 'bin', 'server.mjs')],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  packages: 'bundle',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
});
await chmod(output, 0o755);
console.log(`Built standalone MCP executable: ${path.relative(root, output)}`);
