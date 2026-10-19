import assert from 'node:assert/strict';

export const inject = ['appReady', 'piCompat', 'agents', 'agentPresets', 'commands'];
export function apply(ctx) {
  ctx.appReady.onReady(() => { void run(ctx).then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
}
async function run(ctx) {
  const handle = await ctx.agents.create({ sessionId: 'kb-smoke', meta: { cwd: process.cwd(), agentPreset: 'pi-compatible' },
    agentOptions: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    setup: async scope => { await ctx.agentPresets.mount(scope, 'pi-compatible'); } });
  try {
    const agent = handle.agent;
    const command = line => ctx.commands.execute(agent, line, [], new AbortController().signal);
    assert(ctx.commands.list(agent).some(item => item.name === 'kb'));
    assert.equal((await command('/kb list')).result.text, 'fixture');
    for (let i = 0; i < 2; i++) {
      const result = await command('/kb fixture');
      assert.equal(result.result.kind, 'success', result.result.text);
    }
    assert.equal(agent.status, 'idle');
    assert.equal(agent.inbox.nextStep.length, 2);
    const payload = await ctx.piCompat.adapter.nativeRequest({ messages: agent.inbox.nextStep }, agent);
    const kb = payload.payload.input.filter(item => item.role === 'user' && JSON.stringify(item).includes('synthetic decrypted body'));
    assert.equal(kb.length, 2);
    assert(kb.every(item => item.content[0].type === 'input_text' && item.content[0].text.startsWith('[DSH KB: fixture')));
    assert(!JSON.stringify(payload.payload.input).includes('encrypted_content'));
    assert.match((await command('/kb status')).result.text, /fixture → fixture/);
    assert.equal((await command('/kb off')).result.kind, 'success');
    assert.equal(agent.inbox.nextStep.length, 2);
    // Plaintext KB does not depend on the selected provider.
    const resetModel = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, variables: { ...assembly.variables, provider: 'foreign', model: 'fixture' } };
    });
    assert.equal((await command('/kb fixture')).result.kind, 'success');
    assert.equal(agent.inbox.nextStep.length, 3);
    resetModel();
    console.log('DSH_KB_SMOKE_OK', process.env.DSH_KB_SMOKE_PROFILE, 'commands, durable queued plaintext inserts, Codex serialization');
  } finally { await handle.dispose(); }
}
