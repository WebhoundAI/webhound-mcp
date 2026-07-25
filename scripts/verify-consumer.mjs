import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'webhound-mcp-consumer-'));

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

try {
  const packJson = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root);
  const packed = JSON.parse(packJson);
  const filename = packed[0]?.filename;
  if (!filename) throw new Error('npm pack did not return a tarball filename');
  const tarball = path.join(temp, filename);

  const consumer = path.join(temp, 'consumer');
  await mkdir(consumer);
  run('npm', ['init', '-y'], consumer);
  run('npm', ['install', tarball, '--ignore-scripts'], consumer);
  run('npm', ['ls', '--all'], consumer);

  const audit = JSON.parse(run('npm', ['audit', '--omit=dev', '--json'], consumer));
  const vulnerabilities = Number(audit.metadata?.vulnerabilities?.total || 0);
  if (vulnerabilities !== 0) {
    throw new Error(`Fresh consumer audit reported ${vulnerabilities} production vulnerabilities`);
  }

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const executable = path.join(consumer, 'node_modules', '.bin', 'webhound-mcp');
  const selfTest = JSON.parse(run(executable, ['--self-test'], consumer));
  if (selfTest.version !== packageJson.version || selfTest.tool_count !== 30 || selfTest.ok !== true) {
    throw new Error(`Fresh consumer self-test mismatch: ${JSON.stringify(selfTest)}`);
  }

  console.log(`Fresh consumer verified: webhound-mcp@${selfTest.version}, ${selfTest.tool_count} tools, valid dependency tree, 0 production vulnerabilities.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
