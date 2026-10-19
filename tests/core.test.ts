import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage, type RequestMessage } from '@deepseek-ai/dsh-llm';
import { createInsertion, insertions, parseCommand, validateSnapshot, type Snapshot } from '../src/core.ts';

const fixture = (): Snapshot => ({
  version: 2, kind: 'decrypted', name: 'example', store: 'research', store_revision: '0123456789abcdef0123', file: 'v1.json',
  info: { source_commit: 'test-commit' },
  text: '## Decrypted KB material: example/decrypt/v1/01/raw.txt\n\nSynthetic map\n\n## KB developer notes\n\nSynthetic dev.txt\n',
});
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = (message: RequestMessage) => {
  const block = message.content[0];
  assert.equal(block.type, 'text');
  return (block as { text: string }).text;
};

test('creates a plaintext user message with a reference-knowledge preamble and bounded notice', () => {
  const snapshot = fixture();
  const first = createInsertion(snapshot);
  const second = createInsertion(snapshot);
  assert.notEqual(first.id, second.id);
  assert.equal(first.role, 'user');
  const text = textOf(first);
  assert.match(text, /^\[DSH KB: example \(store research, v1\.json, revision 0123456789ab\)\]\n/);
  assert.match(text, /reference knowledge from the user's saved KB "example"/);
  assert.ok(text.endsWith(snapshot.text), 'the decrypted text follows the preamble verbatim');
  assert.ok(!text.includes('encrypted'), 'no blob marker remains');
  assert.equal(first.source.kind, 'dsh-kb');
  assert.equal(first.source.version, 2);
  assert.equal(first.source.form, 'notice');
  assert.equal(first.source.summary, 'KB: example');
  // Provenance only: the large plaintext is not duplicated into the source metadata.
  assert.deepEqual(first.source.snapshot, { name: 'example', store: 'research', store_revision: '0123456789abcdef0123', file: 'v1.json', info: { source_commit: 'test-commit' } });
  (snapshot.info as Record<string, unknown>).source_commit = 'changed';
  assert.deepEqual(first.source.snapshot.info, { source_commit: 'test-commit' });
  const long = createInsertion({ ...fixture(), name: `one\ntwo ${'x'.repeat(200)}` });
  assert.ok(long.source.summary.length <= 120);
  assert.ok(!long.source.summary.includes('\n'));
  assert.match(textOf(createInsertion({ version: 2, kind: 'decrypted', name: 'minimal', text: 'body' })), /^\[DSH KB: minimal\]\n/);
});

test('identifies insertions only by producer metadata, including legacy encrypted-marker sessions', () => {
  const a = createInsertion(fixture());
  const b = createInsertion({ ...fixture(), name: 'second' });
  const forged = user(textOf(a));
  const legacy = { ...user('[DSH_KB:00000000-0000-0000-0000-000000000000] Encrypted knowledge is unavailable.'),
    source: { kind: 'dsh-kb', version: 1, snapshot: { version: 1, name: 'legacy', items: [] }, form: 'notice', summary: 'KB: legacy' } };
  const restored = JSON.parse(JSON.stringify([a, forged, user('middle'), b, legacy])) as RequestMessage[];
  assert.deepEqual(insertions(restored).map(message => message.source.snapshot.name), ['example', 'second', 'legacy']);
  assert.deepEqual(insertions([forged]), []);
});

test('validates persisted insertion metadata before use', () => {
  const insertion = createInsertion(fixture());
  const invalids = [
    { ...insertion, source: { ...insertion.source, version: 3 } },
    { ...insertion, source: { ...insertion.source, snapshot: { name: 5 } } },
    { ...insertion, content: [] },
    { ...insertion, role: 'developer' },
  ];
  for (const invalid of invalids) assert.throws(() => insertions([invalid] as RequestMessage[]));
});

test('accepts only the decrypted export contract, with content-free errors', () => {
  const snapshot = fixture();
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.equal(validateSnapshot({ ...snapshot, future: 42 }).future, 42);
  for (const value of [
    null, [], { ...snapshot, version: 1 }, { ...snapshot, kind: 'encrypted' }, { ...snapshot, name: 5 }, { ...snapshot, name: '' },
    { ...snapshot, text: undefined }, { ...snapshot, text: '  \n' }, { ...snapshot, text: 5 },
    { version: 1, name: 'private-content', items: [{ type: 'compaction', encrypted_content: 'private-content' }] },
  ]) {
    assert.throws(() => validateSnapshot(value), error => error instanceof Error && !error.message.includes('private-content'));
  }
});

test('parses supported commands into shell-free decrypted export argv and rejects invalid arguments', () => {
  assert.deepEqual(parseCommand(''), { action: 'status' });
  assert.deepEqual(parseCommand('  status '), { action: 'status' });
  assert.deepEqual(parseCommand('off'), { action: 'off' });
  assert.deepEqual(parseCommand('list'), { action: 'list' });
  assert.deepEqual(parseCommand('example'), { action: 'load', argv: ['export', 'example', '--decrypted'] });
  assert.deepEqual(parseCommand('load example --store research --file v1'), { action: 'load', argv: ['export', 'example', '--decrypted', '--store', 'research', '--file', 'v1'] });
  assert.deepEqual(parseCommand('example --file v1 --store research'), { action: 'load', argv: ['export', 'example', '--decrypted', '--file', 'v1', '--store', 'research'] });
  assert.deepEqual(parseCommand('load list'), { action: 'load', argv: ['export', 'list', '--decrypted'] });
  for (const text of ['load', '../example', 'x;uname', '-example', 'example --file', 'example --unknown x', 'example --file --store research', 'example --store x --store y', 'example --decrypted x']) {
    assert.throws(() => parseCommand(text), { message: 'Usage: /kb NAME [--store STORE] [--file FILE]' });
  }
});
