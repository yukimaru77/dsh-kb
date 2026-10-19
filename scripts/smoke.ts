import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const compat = dirname(fileURLToPath(import.meta.resolve('dsh-pi-compat')));
const compatRoot = dirname(compat);
const cli = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'));
const baseHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
for (const profileName of ['dsh-tui', 'web']) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-kb-smoke-'));
  try {
    const home = join(scratch, 'dsh');
    const profile = join(home, 'profiles', profileName);
    const source = join(baseHome, 'profiles', profileName);
    await mkdir(profile, { recursive: true });
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    // Load the current checkouts explicitly through overlays, even if older copies are installed.
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => !['dsh-pi-compat', 'dsh-kb'].includes(name));
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
    await cp(join(source, 'node_modules'), join(profile, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
    const snapshot = { version: 1, name: 'fixture', items: [
      { type: 'compaction', encrypted_content: 'synthetic-not-valid-for-real-api', extra: { preserved: true } },
      { role: 'developer', content: 'synthetic dev.txt' },
    ] };
    const fixtureCli = join(scratch, 'kb-fixture');
    await writeFile(fixtureCli, `#!${process.execPath}\nconsole.log(process.argv[2] === 'list' ? 'fixture' : ${JSON.stringify(JSON.stringify(snapshot))});\n`, { mode: 0o700 });
    const credential = { type: 'oauth', access: 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64url') + '.x', refresh: 'fixture-only', expires: Date.now() + 3600000, accountId: 'fixture-only' };
    await writeFile(join(scratch, 'auth.json'), JSON.stringify({ 'openai-codex': credential, 'openai-codex-1': credential }), { mode: 0o600 });
    await writeFile(join(scratch, 'pool.json'), JSON.stringify({ standardLogin: true, pools: [{ name: 'fixture', enabled: true, baseProvider: 'openai-codex', members: ['openai-codex-1'], strategy: 'custom', selectionTiming: 'auth-use' }] }));
    await writeFile(join(scratch, 'no-network.mjs'), "globalThis.fetch = async () => { throw new Error('No network in KB smoke'); };\n");
    const patch = [
      '- id: hmr\n  disabled: true',
      `- id: pi-compatible\n  config:\n    authPath: ${JSON.stringify(join(scratch, 'auth.json'))}\n    poolConfigPath: ${JSON.stringify(join(scratch, 'pool.json'))}\n    piTierConfigPath: ${JSON.stringify(join(scratch, 'no-tier.json'))}\n    settingsDirectory: ${JSON.stringify(join(scratch, 'settings'))}`,
      `- id: dsh-kb\n  config:\n    command: ${JSON.stringify(fixtureCli)}`,
      `- insert:\n    - id: kb-smoke-probe\n      name: ${JSON.stringify(join(root, 'scripts/smoke-probe.mjs'))}`,
      ...(profileName === 'dsh-tui' ? ['- id: dsh-tui\n  disabled: true'] : [
        '- id: webserver\n  config: {host: 127.0.0.1, port: 0}',
        '- id: web-runtime\n  config: {openBrowser: false, printUrl: false, surfaceContext: false}',
      ]),
    ].join('\n') + '\n';
    await writeFile(join(scratch, 'smoke.yml'), patch);
    const args = [cli, '--profile', profileName, '--patch', join(compatRoot, 'cordis.patch.yml'),
      ...(profileName === 'dsh-tui' ? ['--patch', join(compatRoot, 'cordis.tui.patch.yml')] : []),
      '--patch', join(root, 'cordis.patch.yml'), '--patch', join(scratch, 'smoke.yml')];
    const result = spawnSync(process.execPath, args, { cwd: scratch, timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: scratch, DSH_HOME: home, DSH_TELEMETRY: '0', NODE_OPTIONS: `--import=${join(scratch, 'no-network.mjs')}`, DSH_KB_SMOKE_PROFILE: profileName } });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.status !== 0 || !result.stdout.includes('DSH_KB_SMOKE_OK')) throw new Error(`KB smoke failed for ${profileName}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
