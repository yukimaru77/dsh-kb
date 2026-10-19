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
    assert.equal(payload.payload.input.filter(item => item.encrypted_content).length, 2);
    assert.equal(payload.payload.input.filter(item => item.role === 'developer').length, 2);
    assert(payload.payload.input.filter(item => item.encrypted_content).every(item => item.extra.preserved));
    assert.match((await command('/kb status')).result.text, /fixture → fixture/);
    assert.equal((await command('/kb off')).result.kind, 'success');
    assert.equal(agent.inbox.nextStep.length, 2);
    // A UI route switch is prompt-scoped and may precede the next durable request header.
    const resetModel = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, variables: { ...assembly.variables, provider: 'foreign', model: 'fixture' } };
    });
    assert.equal((await command('/kb fixture')).result.kind, 'error');
    assert.equal(agent.inbox.nextStep.length, 2);
    resetModel();
    console.log('DSH_KB_SMOKE_OK', process.env.DSH_KB_SMOKE_PROFILE, 'commands, durable queued inserts, Codex serialization, and compaction input');
  } finally { await handle.dispose(); }
}
