import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CommandId, type CommandInvocation } from '@deepseek-ai/dsh-commands';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmCallConfig, type LlmResolvedModelInfo, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format';
import { createKbHandler } from '../src/command.ts';
import { expandInsertions, insertions, type JsonRecord, type Snapshot } from '../src/core.ts';
import { pendingInsertions, registerPending } from '../src/pending.ts';
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';

// The summarize-hook shapes of @deepseek-ai/dsh-compaction-basic 0.2.1-rc.2. The released
// package ships them only below lib/types, which its exports map does not expose.
interface SummarizationInput { readonly tools?: readonly ToolSchema[]; readonly messages: readonly Message[] }
type SummaryResult = { summary: ContentBlock[]; provider: string; model: string; maxTokens?: number; usage?: TokenUsage }
  & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never });

const route: LlmCallConfig = { provider: 'openai-codex', model: 'gpt-6-luna' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const snapshot = (name = 'alpha'): Snapshot => ({
  version: 1, name, store: 'fixture-store', store_revision: 'revision-one',
  items: [
    { type: 'compaction', encrypted_content: `opaque-${name}`, extra: { preserved: true } },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `${name} developer instructions` }] },
  ],
});

/** Minimal Responses input serialization, with no provider or network access. */
function wire(messages: readonly RequestMessage[]): JsonRecord {
  return { input: messages.map(message => ({
    role: message.role === 'system' ? 'developer' : message.role,
    content: message.content.filter(block => block.type === 'text').map(block => ({ type: 'input_text', text: block.text })),
  })) };
}

class CaptureAdapter extends LlmAdapter {
  readonly requests: RequestMessage[][] = [];
  readonly payloads: JsonRecord[] = [];
  pause?: Promise<void>;
  entered?: () => void;
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: id, context: { contextWindow: 272_000 } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(options.messages));
    this.payloads.push(expandInsertions(wire(options.messages), options.messages));
    this.entered?.();
    await this.pause;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture answer' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

let fixtureNumber = 0;
async function fixture(t: TestContext) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'Fixture system instructions.' } });
  registerPending(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new CaptureAdapter();
  ctx.llm.registerAdapter(['openai-codex', 'foreign'], adapter);
  const agent = await ctx.agentLoop.create(SessionId(`dsh-kb-integration-${++fixtureNumber}`), route, { cwd: '/synthetic/kb-workspace' });
  t.after(async () => { await ctx.fiber.dispose(); });
  let selectedRoute: Partial<LlmCallConfig> = { ...route };
  const flushes: number[] = [];
  const host = {
    routeFor: () => selectedRoute,
    supportsModel: (id: string) => id === route.model,
    flush: async (session: Session) => { flushes.push(Number(session.seq)); await ctx.sessions.flush(session); },
  };
  return { ctx, agent, adapter, host, flushes, setRoute: (next: Partial<LlmCallConfig>) => { selectedRoute = next; } };
}

function invocation(agent: Agent, rawInput: string, signal = new AbortController().signal): CommandInvocation {
  return { commandId: CommandId(`kb-${++fixtureNumber}`), agent, rawInput, signal, attachments: [] };
}

async function prompt(agent: Agent, text: string): Promise<void> {
  agent.followup(user(text));
  await agent.whenIdle();
}

/** Exercise the same current codec and restoration validators as session persistence. */
function restored(session: Session): Session {
  const header = JSON.parse(JSON.stringify(session.header)) as SessionFormatHeader;
  // DSH's Session omits root depth while its current codec requires the equivalent explicit zero.
  const codecHeader = { ...header, delegationDepth: session.header.delegationDepth ?? 0 };
  const physical = sessionFormatCatalog.encodeCurrentHeader(codecHeader, session.inheritedEventCount);
  const reader = sessionFormatCatalog.createRestore(JSON.parse(JSON.stringify(physical)), { recovery: 'strict', validation: 'current' });
  for (let seq = 0; seq < session.seq; seq++) {
    const event = JSON.parse(JSON.stringify(session.eventAt(SessionSeq(seq)))) as SessionFormatEvent;
    reader.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))));
  }
  const artifact = reader.finish();
  const events: readonly SessionEvent[] = JSON.parse(JSON.stringify(artifact.events));
  const restoredHeader: SessionHeader = JSON.parse(JSON.stringify(artifact.header));
  return Session.create(session.id, events, restoredHeader, SessionLogOffset(artifact.inheritedEventCount));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function names(messages: readonly RequestMessage[]): string[] {
  return insertions(messages).map(message => message.source.snapshot.name);
}

test('fresh /kb persists pending knowledge without a turn, then admits it after the system head exactly once', async t => {
  const { agent, adapter, host, flushes } = await fixture(t);
  const exported = snapshot();
  let exports = 0;
  const handle = createKbHandler(host, async (argv, options) => {
    exports++;
    assert.deepEqual(argv, ['export', 'alpha']);
    assert.equal(options.cwd, '/synthetic/kb-workspace');
    return JSON.stringify(exported);
  });
  assert.equal((await handle(invocation(agent, 'alpha'))).kind, 'success');
  assert.equal(adapter.requests.length, 0);
  assert.equal(flushes.length, 1);
  assert.deepEqual(names(agent.inbox.nextStep), ['alpha']);
  assert.deepEqual(names(agent.session.deriveMessages()), []);
  const pending = restored(agent.session);
  assert.ok(pending.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && names(event.data.inserted).includes('alpha')));
  exported.items[0].encrypted_content = 'changed-after-load';

  await prompt(agent, 'use the knowledge');
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(names(adapter.requests[0]), ['alpha']);
  assert.equal(adapter.requests[0][0].role, 'system');
  assert.deepEqual(names(agent.inbox.nextStep), []);
  const input = adapter.payloads[0].input as JsonRecord[];
  assert.equal(input.filter(item => item.type === 'compaction').length, 1);
  assert.equal(input.find(item => item.type === 'compaction')?.encrypted_content, 'opaque-alpha');
  assert.ok(input.some(item => item.role === 'developer' && JSON.stringify(item).includes('alpha developer instructions')));
  assert.deepEqual(names(restored(agent.session).deriveMessages()), ['alpha']);
  await prompt(agent, 'continue');
  assert.equal(exports, 1);
  assert.equal((adapter.payloads[1].input as JsonRecord[]).filter(item => item.type === 'compaction').length, 1);
});

test('multiple /kb snapshots stay at their insertion positions through codec restoration and real fork', async t => {
  const { ctx, agent, adapter, host } = await fixture(t);
  await prompt(agent, 'before alpha');
  const handle = createKbHandler(host, async argv => JSON.stringify(snapshot(argv[1])));
  assert.equal((await handle(invocation(agent, 'alpha'))).kind, 'success');
  assert.equal(adapter.requests.length, 1);
  await prompt(agent, 'between alpha and beta');
  assert.equal((await handle(invocation(agent, 'beta'))).kind, 'success');
  assert.equal(adapter.requests.length, 2);
  await prompt(agent, 'after beta');
  const messages = agent.session.deriveMessages();
  assert.deepEqual(names(messages), ['alpha', 'beta']);
  const payload = expandInsertions(wire(messages), messages);
  const input = payload.input as JsonRecord[];
  const alpha = input.findIndex(item => item.encrypted_content === 'opaque-alpha');
  const middle = input.findIndex(item => JSON.stringify(item).includes('between alpha and beta'));
  const beta = input.findIndex(item => item.encrypted_content === 'opaque-beta');
  assert.ok(alpha >= 0 && alpha < middle && middle < beta);
  const replay = restored(agent.session);
  assert.deepEqual(expandInsertions(wire(replay.deriveMessages()), replay.deriveMessages()), payload);
  const child = ctx.sessions.fork(agent.session, undefined, SessionId(`kb-fork-${++fixtureNumber}`));
  const forkReplay = restored(child);
  assert.deepEqual(expandInsertions(wire(forkReplay.deriveMessages()), forkReplay.deriveMessages()), payload);
});

test('pending KB survives codec hydration and fork, and cancellation cannot lose the saved selection', async t => {
  const { ctx, agent, host, adapter } = await fixture(t);
  const earlierChild = ctx.sessions.fork(agent.session, undefined, SessionId(`kb-before-selection-${++fixtureNumber}`));
  const handle = createKbHandler(host, async () => JSON.stringify(snapshot()));
  assert.equal((await handle(invocation(agent, 'alpha'))).kind, 'success');
  const pending = restored(agent.session);
  const child = ctx.sessions.fork(agent.session, undefined, SessionId(`kb-pending-fork-${++fixtureNumber}`));
  const forkPending = restored(child);
  assert.ok(forkPending.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && names(event.data.inserted).includes('alpha')));
  assert.deepEqual(pendingInsertions(restored(earlierChild)), []);
  const hydration = await ctx.agents.create({
    sessionId: SessionId(`kb-pending-hydration-${++fixtureNumber}`),
    seed: pending.snapshotEvents(), agentOptions: route,
    meta: { cwd: '/synthetic/kb-workspace', delegationDepth: 0 },
  });
  t.after(async () => { await hydration.dispose(); });
  assert.deepEqual(names(hydration.agent.inbox.nextStep), ['alpha']);
  await prompt(hydration.agent, 'first prompt after hydration');
  assert.deepEqual(names(adapter.requests.at(-1)!), ['alpha']);
  assert.deepEqual(names(restored(hydration.agent.session).deriveMessages()), ['alpha']);

  agent.cancel({ kind: 'user' });
  assert.deepEqual(names(agent.inbox.nextStep), []);
  assert.deepEqual(pendingInsertions(agent.session).map(message => message.source.snapshot.name), ['alpha']);
  assert.equal(adapter.requests.length, 1);
  await prompt(agent, 'first prompt after cancellation');
  assert.deepEqual(names(adapter.requests.at(-1)!), ['alpha']);
  assert.deepEqual(pendingInsertions(agent.session), []);
});

test('first-turn KB survives actual disposal clearing, codec restoration, and agent recreation without duplicate admission', async t => {
  const { ctx, host, adapter } = await fixture(t);
  const sessionId = SessionId(`kb-disposal-resume-${++fixtureNumber}`);
  const original = await ctx.agents.create({ sessionId, agentOptions: route, meta: { cwd: '/synthetic/kb-workspace', delegationDepth: 0 } });
  const handle = createKbHandler(host, async () => JSON.stringify(snapshot()));
  assert.equal((await handle(invocation(original.agent, 'alpha'))).kind, 'success');
  const source = original.agent.session;
  await original.dispose();
  assert.ok(source.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'));
  assert.deepEqual(names(source.deriveMessages()), []);
  assert.deepEqual(pendingInsertions(source).map(message => message.source.snapshot.name), ['alpha']);
  const replay = restored(source);
  const resumed = await ctx.agents.create({ sessionId, agentOptions: route, seed: replay.snapshotEvents(), meta: { cwd: '/synthetic/kb-workspace', delegationDepth: 0 } });
  t.after(async () => { await resumed.dispose(); });
  assert.deepEqual(names(resumed.agent.inbox.nextStep), ['alpha']);
  await prompt(resumed.agent, 'resume after closing before the first prompt');
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(names(adapter.requests[0]), ['alpha']);
  assert.deepEqual(pendingInsertions(resumed.agent.session), []);
  await prompt(resumed.agent, 'second prompt');
  assert.equal((adapter.payloads[1].input as JsonRecord[]).filter(item => item.type === 'compaction').length, 1);
  assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-kb').length, 1);
});

class FixtureCompaction extends BasicCompactionEngine {
  readonly captured: JsonRecord[] = [];
  protected override async summarize(input: SummarizationInput): Promise<SummaryResult> {
    this.captured.push(expandInsertions(wire(input.messages), input.messages));
    return { summary: [{ type: 'text', text: 'Retain the selected knowledge and prior task.' }], provider: route.provider, model: route.model };
  }
}

test('real DSH compaction consumes active snapshots and never resurrects them from the durable log', async t => {
  const { ctx, agent, adapter, host } = await fixture(t);
  const meter = await ctx.plugin(TokenMeter);
  const compact = await ctx.plugin(FixtureCompaction, { auto: false });
  t.after(async () => { await compact.dispose(); await meter.dispose(); });
  const handle = createKbHandler(host, async () => JSON.stringify(snapshot()));
  assert.equal((await handle(invocation(agent, 'alpha'))).kind, 'success');
  assert.equal(pendingInsertions(agent.session).length, 1);
  await prompt(agent, 'Earlier context. '.repeat(600));
  await prompt(agent, 'Work with alpha. '.repeat(600));
  await prompt(agent, 'Keep this recent request.');
  const result = await ctx.compaction.compactNow(agent, new AbortController().signal);
  assert.ok(result);
  assert.ok(ctx.compaction instanceof FixtureCompaction);
  assert.ok(JSON.stringify(ctx.compaction.captured).includes('opaque-alpha'));
  assert.deepEqual(names(agent.session.deriveMessages()), []);
  assert.deepEqual(pendingInsertions(agent.session), []);
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-kb'));
  const replay = restored(agent.session);
  assert.deepEqual(names(replay.deriveMessages()), []);
  assert.ok(!JSON.stringify(expandInsertions(wire(replay.deriveMessages()), replay.deriveMessages())).includes('opaque-alpha'));
  await prompt(agent, 'Continue after compaction.');
  assert.ok(!JSON.stringify(adapter.payloads.at(-1)).includes('opaque-alpha'));
  const child = ctx.sessions.fork(agent.session, undefined, SessionId(`kb-compacted-fork-${++fixtureNumber}`));
  assert.deepEqual(names(restored(child).deriveMessages()), []);
});

test('maintenance queues a concurrent prompt until the KB snapshot is committed and flushed', async t => {
  const { agent, adapter, host, flushes } = await fixture(t);
  await prompt(agent, 'existing conversation');
  const entered = deferred();
  const release = deferred();
  const handle = createKbHandler(host, async () => { entered.resolve(); await release.promise; return JSON.stringify(snapshot()); });
  const loading = handle(invocation(agent, 'alpha'));
  await entered.promise;
  agent.followup(user('arrived during export'));
  assert.equal(adapter.requests.length, 1);
  release.resolve();
  const result = await loading;
  assert.equal(result.kind, 'success');
  await agent.whenIdle();
  assert.equal(flushes.length, 1);
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(names(adapter.requests[1]), ['alpha']);
  const input = adapter.payloads[1].input as JsonRecord[];
  assert.ok(input.findIndex(item => item.type === 'compaction') < input.findIndex(item => JSON.stringify(item).includes('arrived during export')));
});

test('busy agents, route changes and cancellation cannot partially insert a KB', async t => {
  const { agent, adapter, host, setRoute } = await fixture(t);
  await prompt(agent, 'establish history');
  let calls = 0;
  const handle = createKbHandler(host, async () => { calls++; return JSON.stringify(snapshot()); });
  const entered = deferred();
  const release = deferred();
  adapter.pause = release.promise;
  adapter.entered = entered.resolve;
  agent.followup(user('running turn'));
  await entered.promise;
  assert.equal((await handle(invocation(agent, 'alpha'))).kind, 'error');
  assert.equal(calls, 0);
  release.resolve();
  await agent.whenIdle();
  adapter.pause = undefined;
  adapter.entered = undefined;

  for (const mode of ['route', 'abort'] as const) {
    const exporting = deferred();
    const done = deferred();
    const controller = new AbortController();
    const delayed = createKbHandler(host, async () => { exporting.resolve(); await done.promise; return JSON.stringify(snapshot()); });
    const loading = delayed(invocation(agent, 'alpha', controller.signal));
    await exporting.promise;
    if (mode === 'route') setRoute({ provider: 'foreign', model: 'foreign' });
    else controller.abort(new Error('fixture cancelled'));
    done.resolve();
    assert.equal((await loading).kind, 'error');
    assert.deepEqual(names(agent.session.deriveMessages()), []);
    assert.deepEqual(names(agent.inbox.nextStep), []);
    setRoute({ ...route });
  }
});
