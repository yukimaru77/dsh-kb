import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, type Message, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { AuthBroker } from '../node_modules/dsh-pi-compat/src/auth/broker.ts';
import { CodexPool } from '../node_modules/dsh-pi-compat/src/auth/pool.ts';
import { PooledCodexAdapter } from '../node_modules/dsh-pi-compat/src/provider.ts';
import { ServiceTierSettingsHelper } from '../node_modules/dsh-pi-compat/src/tier/index.ts';
import { requestNativeCompaction } from '../node_modules/dsh-pi-compat/src/compact/transport.ts';
import { createInsertion, expandInsertions, type JsonRecord, type Snapshot } from '../src/core.ts';

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});
const snapshot = (): Snapshot => ({
  version: 1, name: 'adapter-fixture', store: 'synthetic-store', revision: 'synthetic-revision',
  items: [
    { type: 'compaction', id: 'kb-first', encrypted_content: 'synthetic-kb-blob-one', unknown: { nested: [1, false, null] } },
    { type: 'compaction_summary', encrypted_content: 'synthetic-kb-blob-two', future_field: 'keep verbatim' },
    { type: 'context_compaction', encrypted_content: 'synthetic-kb-blob-three', future_number: 42 },
    { role: 'user', content: [{ type: 'input_text', text: 'Synthetic KB map.', unknown_part: true }], unknown_map: { revision: 2 } },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# dev.txt\nSynthetic developer instructions.' }], unknown_developer: ['keep', 'order'] },
  ],
});

function fixture(t: TestContext) {
  let authCalls = 0;
  // This constructor reads only the installed model catalog. Never open real Pi auth.
  const pool = new CodexPool({ members: ['openai-codex-1'],
    selector: async () => { throw new Error('Real account selection forbidden'); },
    getQuota: async () => { throw new Error('Real quota requests forbidden'); },
    resolveAuth: async () => { throw new Error('Real credentials forbidden'); },
  });
  const Broker = AuthBroker as unknown as new (pool: CodexPool) => AuthBroker;
  const broker = new Broker(pool);
  const fakeToken = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64url')}.x`;
  t.mock.method(broker, 'acquire', async () => {
    authCalls++;
    return { provider: 'openai-codex-1', apiKey: fakeToken, accountId: 'fixture-only', headers: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network forbidden'); });
  const adapter = new PooledCodexAdapter(new Context(), broker, new ServiceTierSettingsHelper({ 'openai-codex': 'priority' }));
  t.after(adapter.registerPayloadTransform('dsh-kb', (payload, request) => expandInsertions(payload, request.messages)));
  const model = broker.catalog.getModels('openai-codex').find(model => model.id === 'gpt-6-luna');
  assert.ok(model, 'the pinned catalog contains gpt-6-luna');
  const insertion = createInsertion(snapshot());
  const messages: Message[] = [createSystemMessage('Synthetic system instructions.'), user('Before KB.'), insertion, user('After KB.')];
  const agent = { options: { provider: 'openai-codex', model: model.id }, session: {
    id: 'synthetic-kb-adapter',
    requestHeader: () => ({ config: { provider: 'openai-codex', model: model.id } }),
    toolHistory: () => [],
    deriveMessages: () => messages,
  } } as unknown as Agent;
  return { adapter, model, agent, insertion, messages, authCalls: () => authCalls };
}

function assertExpanded(payload: JsonRecord, selected: Snapshot): void {
  assert.equal(payload.instructions, 'Synthetic system instructions.');
  assert.equal(payload.service_tier, 'priority');
  const input = payload.input as JsonRecord[];
  assert.equal(input.length, selected.items.length + 2);
  assert.equal(input[0].role, 'user');
  assert.deepEqual(input[0].content, [{ type: 'input_text', text: 'Before KB.' }]);
  assert.deepEqual(input.slice(1, -1), selected.items, 'all blobs, dev.txt and unknown fields retain their exact order and values');
  assert.equal(input.at(-1)!.role, 'user');
  assert.deepEqual(input.at(-1)!.content, [{ type: 'input_text', text: 'After KB.' }]);
  assert.ok(!JSON.stringify(payload).includes('[DSH_KB:'), 'only the serialized marker is replaced');
}

test('Codex stream expands stored KB at its original position without changing DSH messages', async t => {
  const f = fixture(t);
  const before = structuredClone(f.messages);
  const sent: JsonRecord[] = [];
  t.mock.method(globalThis, 'fetch', async (...[_url, init]: Parameters<typeof fetch>) => {
    const body = new Headers(init?.headers).get('content-encoding') === 'zstd'
      ? zstdDecompressSync(init!.body as Uint8Array).toString('utf8') : String(init?.body);
    sent.push(JSON.parse(body));
    const message = { id: 'msg_kb_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer.' }] };
    return sse([
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_kb_fixture', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
  });
  const stream = async (messages: RequestMessage[]) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of f.adapter.stream({ provider: 'openai-codex', model: f.model.id, sessionId: f.agent.session.id, messages })) chunks.push(chunk);
    assert.deepEqual(chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' });
  };
  await stream(f.messages);
  assertExpanded(sent[0], f.insertion.source.snapshot);
  assert.deepEqual(f.messages, before);
  const afterCompaction = [f.messages[0], user('Retained summary without a KB marker.'), f.messages.at(-1)!];
  await stream(afterCompaction);
  assert.ok(!JSON.stringify(sent[1]).includes('synthetic-kb-blob'));
  assert.ok(!JSON.stringify(sent[1]).includes('Synthetic developer instructions.'));
  assert.deepEqual(f.messages, before);
  assert.equal(f.authCalls(), 2);
});

test('nativeRequest expands only its selected compaction messages, never old session insertions', async t => {
  const f = fixture(t);
  const before = structuredClone(f.messages);
  const request = await f.adapter.nativeRequest({ messages: f.messages }, f.agent);
  assert.ok(request);
  assertExpanded(request.payload, f.insertion.source.snapshot);
  assert.deepEqual(f.messages, before);
  const afterCompaction = [f.messages[0], user('Retained summary without a KB marker.'), f.messages.at(-1)!];
  const next = await f.adapter.nativeRequest({ messages: afterCompaction }, f.agent);
  assert.ok(next);
  assert.ok(!JSON.stringify(next.payload).includes('synthetic-kb-blob'));
  assert.ok(!JSON.stringify(next.payload).includes('Synthetic developer instructions.'));
  assert.equal((next.payload.input as JsonRecord[]).length, 2);
  assert.deepEqual(f.agent.session.deriveMessages(), before, 'the old session history still contains KB, but is outside this compact request');
  assert.equal(f.authCalls(), 0);
});

test('native compaction HTTP receives the expanded blobs and developer text before its trigger', async t => {
  const f = fixture(t);
  const originalMessages = structuredClone(f.messages);
  const request = await f.adapter.nativeRequest({ messages: f.messages }, f.agent);
  assert.ok(request);
  const originalPayload = structuredClone(request.payload);
  let authCalls = 0;
  let httpCalls = 0;
  const compacted = { type: 'compaction', id: 'new-fixture-checkpoint', encrypted_content: 'synthetic-new-compaction' };
  const result = await requestNativeCompaction(request, {
    getAuth: async () => { authCalls++; return { accessToken: 'synthetic-only-token', accountId: 'fixture-only' }; },
    fetch: async (_url, init) => {
      httpCalls++;
      const body = JSON.parse(String(init?.body)) as JsonRecord;
      const input = body.input as JsonRecord[];
      assert.deepEqual(input.at(-1), { type: 'compaction_trigger' });
      assertExpanded({ ...body, input: input.slice(0, -1) }, f.insertion.source.snapshot);
      assert.deepEqual(input.slice(0, -1), originalPayload.input);
      return sse([
        { type: 'response.output_item.done', item: compacted },
        { type: 'response.completed', response: { status: 'completed', output: [compacted] } },
      ]);
    },
  });
  assert.equal(authCalls, 1);
  assert.equal(httpCalls, 1);
  assert.equal(f.authCalls(), 0, 'native serialization must not resolve auth');
  assert.deepEqual(result.replacementHistory.at(-1), compacted);
  assert.deepEqual(request.payload, originalPayload, 'adding the compact trigger must not mutate the captured request');
  assert.deepEqual(f.messages, originalMessages);
});
