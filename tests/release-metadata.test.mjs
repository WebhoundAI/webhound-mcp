import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

test('all published package and plugin metadata uses one release version', async () => {
  const [
    packageJson,
    shrinkwrap,
    server,
    plugin,
    claudePlugin,
    claudeMarketplace,
    cursorPlugin,
  ] = await Promise.all([
    json('package.json'),
    json('npm-shrinkwrap.json'),
    json('server.json'),
    json('plugin.json'),
    json('.claude-plugin/plugin.json'),
    json('.claude-plugin/marketplace.json'),
    json('.cursor-plugin/plugin.json'),
  ]);

  const version = packageJson.version;
  assert.equal(shrinkwrap.version, version);
  assert.equal(shrinkwrap.packages[''].version, version);
  assert.equal(server.version, version);
  assert.equal(server.packages[0].version, version);
  assert.equal(plugin.version, version);
  assert.equal(claudePlugin.version, version);
  assert.equal(claudeMarketplace.metadata.version, version);
  assert.equal(claudeMarketplace.plugins[0].version, version);
  assert.equal(cursorPlugin.version, version);
});

test('public setup metadata uses the canonical endpoint and least OAuth scope', async () => {
  const [hostedConfig, pluginConfig, server, readme, packageJson] = await Promise.all([
    json('mcp.json'),
    json('.mcp.json'),
    json('server.json'),
    readFile(path.join(root, 'README.md'), 'utf8'),
    json('package.json'),
  ]);
  const endpoint = 'https://api.webhound.ai/api/v2/mcp';

  assert.equal(hostedConfig.mcpServers.webhound.url, endpoint);
  assert.deepEqual(hostedConfig.mcpServers.webhound.oauthScopes, ['webhound:mcp']);
  assert.equal(pluginConfig.mcpServers.webhound.url, endpoint);
  assert.equal(server.remotes[0].url, endpoint);
  assert.match(readme, new RegExp(`webhound-mcp@${packageJson.version.replaceAll('.', '\\.')}`, 'g'));
  assert.doesNotMatch(readme, /webhound-mcp@0\.5\.0/);
});
