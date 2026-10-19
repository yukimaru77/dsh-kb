import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage, type RequestMessage } from '@deepseek-ai/dsh-llm';
import { createInsertion, expandInsertions, insertions, parseCommand, validateSnapshot, type JsonRecord, type Snapshot } from '../src/core.ts';

const fixture = (): Snapshot => ({
  version: 1, name: 'example', store: 'research', store_revision: 'test-revision', file: 'v1.json',
  info: { source_commit: 'test-commit' },
  items: [
    { type: 'compaction', encrypted_content: 'opaque-test-1', extra: { preserve: true } },
    { type: 'context_compaction', encrypted_content: 'opaque-test-2' },
    { role: 'user', content: 'Synthetic map' },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Synthetic dev.txt' }] },
  ],
});
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const wire = (text: string): JsonRecord => ({ role: 'user', content: [{ type: 'input_text', text }] });
const marker = (message: ReturnType<typeof createInsertion>) => {
  const block = message.content[0];
  assert.equal(block.type, 'text');
  return (block as { text: string }).text;
};

test('creates independent durable insertions with bounded one-line notices', () => {
  const snapshot = fixture();
  const first = createInsertion(snapshot);
  const second = createInsertion(snapshot);
  assert.notEqual(first.id, second.id);
  assert.notEqual(marker(first), marker(second));
  assert.match(marker(first), /^\[DSH_KB:[a-f0-9-]+\] /);
  assert.equal(first.source.kind, 'dsh-kb');
  assert.equal(first.source.version, 1);
  assert.equal(first.source.form, 'notice');
  assert.deepEqual(first.source.snapshot, snapshot);
  snapshot.name = 'changed';
  snapshot.items[0].encrypted_content = 'changed';
  assert.equal(first.source.snapshot.name, 'example');
  assert.equal(first.source.snapshot.items[0].encrypted_content, 'opaque-test-1');
  const long = createInsertion({ ...fixture(), name: `one\ntwo ${'x'.repeat(200)}` });
  assert.ok(long.source.summary.length <= 120);
  assert.ok(!long.source.summary.includes('\n'));
});

test('expands at the exact conversation position and preserves metadata, roles and opaque fields', () => {
  const snapshot = fixture();
  const insertion = createInsertion(snapshot);
  const payload = { input: [wire('before'), wire(marker(insertion)), wire('after')], instructions: 'system' };
  const original = structuredClone(payload);
  const result = expandInsertions(payload, [user('before'), insertion, user('after')]);
  assert.deepEqual(result.input, [payload.input[0], ...snapshot.items, payload.input[2]]);
  assert.equal(result.instructions, 'system');
  assert.deepEqual(payload, original);
  const expanded = result.input as JsonRecord[];
  (expanded[1].extra as JsonRecord).preserve = false;
  assert.equal((insertion.source.snapshot.items[0].extra as JsonRecord).preserve, true);
  assert.deepEqual(insertion.source.snapshot.info, { source_commit: 'test-commit' });
});

test('preserves multiple insertion positions across durable replay and branch selection', () => {
  const a = createInsertion(fixture());
  const b = createInsertion({ version: 1, name: 'second', items: [{ type: 'compaction_summary', encrypted_content: 'opaque-second' }] });
  const restored = JSON.parse(JSON.stringify([a, user('middle'), b])) as RequestMessage[];
  const payload = { input: [wire(marker(a)), wire('middle'), wire(marker(b))] };
  assert.deepEqual(expandInsertions(payload, restored).input, [...a.source.snapshot.items, wire('middle'), ...b.source.snapshot.items]);
  assert.deepEqual(expandInsertions(payload, [a]).input, [...a.source.snapshot.items, wire('middle'), wire(marker(b))]);
  assert.deepEqual(insertions(restored).map(message => message.source.snapshot.name), ['example', 'second']);
});

test('does not restore knowledge removed by compaction or expand forged user markers', () => {
  const insertion = createInsertion(fixture());
  const forged = user(marker(insertion));
  const payload = { input: [wire(marker(insertion))] };
  assert.equal(expandInsertions(payload, [forged]), payload);
  assert.deepEqual(insertions([forged, { role: 'user', content: [{ type: 'text', text: marker(insertion) }] }]), []);
  const compacted = { input: [{ type: 'compaction', encrypted_content: 'new-combined-history' }, wire('recent')] };
  assert.equal(expandInsertions(compacted, [user('recent')]), compacted);
});

test('rejects missing or ambiguous live anchors with fixed non-content errors', () => {
  const insertion = createInsertion(fixture());
  const text = marker(insertion);
  assert.throws(() => expandInsertions({ input: [wire(text), wire(text)] }, [insertion]), { message: 'Duplicate KB insertion in converted payload.' });
  assert.throws(() => expandInsertions({ input: [wire(text)] }, [insertion, insertion]), { message: 'Duplicate stored KB insertion.' });
  for (const input of [
    [],
    [wire(`${text} changed`)],
    [{ role: 'developer', content: [{ type: 'input_text', text }] }],
    [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_text', text: 'extra' }] }],
    [...fixture().items],
  ]) {
    assert.throws(() => expandInsertions({ input }, [insertion]), { message: 'KB insertion missing from converted payload.' });
  }
  assert.throws(() => expandInsertions({}, []), { message: 'Codex payload has no input array.' });
});

test('validates persisted insertion metadata before use', () => {
  const insertion = createInsertion(fixture());
  const invalids = [
    { ...insertion, source: { ...insertion.source, version: 2 } },
    { ...insertion, source: { ...insertion.source, snapshot: { ...fixture(), version: 2 } } },
    { ...insertion, content: [] },
    { ...insertion, role: 'developer' },
  ];
  for (const invalid of invalids) assert.throws(() => insertions([invalid] as RequestMessage[]));
});

test('accepts the portable export contract without discarding fields', () => {
  const snapshot = fixture();
  assert.equal(validateSnapshot(snapshot), snapshot);
  for (const type of ['compaction', 'compaction_summary', 'context_compaction']) {
    assert.equal(validateSnapshot({ ...snapshot, items: [{ type, encrypted_content: 'opaque', unknown: 42 }] }).items[0].unknown, 42);
  }
  assert.doesNotThrow(() => validateSnapshot({ version: 1, name: 'minimal', items: [snapshot.items[0]] }));
  for (const value of [
    null, [], { ...snapshot, version: 2 }, { ...snapshot, name: 5 }, { ...snapshot, items: {} },
    { ...snapshot, items: [] }, { ...snapshot, items: [null] },
    { ...snapshot, items: [{ type: 'compaction', encrypted_content: '' }] },
    { ...snapshot, items: [{ type: 'compaction', encrypted_content: 5 }] },
    { ...snapshot, items: [snapshot.items[0], { role: 'assistant', content: 'private-content' }] },
    { ...snapshot, items: [snapshot.items[0], { role: 'user', content: '' }] },
    { ...snapshot, items: [snapshot.items[3]] },
  ]) {
    assert.throws(() => validateSnapshot(value), error => error instanceof Error && !error.message.includes('private-content'));
  }
});

test('parses supported commands into shell-free argv and rejects invalid arguments', () => {
  assert.deepEqual(parseCommand(''), { action: 'status' });
  assert.deepEqual(parseCommand('  status '), { action: 'status' });
  assert.deepEqual(parseCommand('off'), { action: 'off' });
  assert.deepEqual(parseCommand('list'), { action: 'list' });
  assert.deepEqual(parseCommand('example'), { action: 'load', argv: ['export', 'example'] });
  assert.deepEqual(parseCommand('load example --store research --file v1'), { action: 'load', argv: ['export', 'example', '--store', 'research', '--file', 'v1'] });
  assert.deepEqual(parseCommand('example --file v1 --store research'), { action: 'load', argv: ['export', 'example', '--file', 'v1', '--store', 'research'] });
  assert.deepEqual(parseCommand('load list'), { action: 'load', argv: ['export', 'list'] });
  for (const text of ['load', '../example', 'x;uname', '-example', 'example --file', 'example --unknown x', 'example --file --store research', 'example --store x --store y']) {
    assert.throws(() => parseCommand(text), { message: 'Usage: /kb NAME [--store STORE] [--file FILE]' });
  }
});
