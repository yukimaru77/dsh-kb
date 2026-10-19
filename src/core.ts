import { boundContextSummary, createUserMessage, type RequestMessage, type UserMessage } from '@deepseek-ai/dsh-llm';

export type JsonRecord = Record<string, unknown>;

/** `kb export NAME --decrypted` output: decrypted KB material plus dev.txt as one plaintext. */
export interface Snapshot extends JsonRecord {
  version: 2;
  kind: 'decrypted';
  name: string;
  text: string;
}

/** Snapshot provenance kept in the message source. The plaintext itself lives only in the content. */
export interface SnapshotInfo extends JsonRecord {
  name: string;
}

export interface KBSource {
  kind: 'dsh-kb';
  /** 2: plaintext insertion. 1: legacy encrypted-blob marker, kept readable for old sessions. */
  version: 1 | 2;
  snapshot: SnapshotInfo;
  form: 'notice';
  summary: string;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-kb': KBSource;
  }
}

export interface KBMessage extends UserMessage {
  readonly source: KBSource;
}

export type KBCommand =
  | { action: 'status' }
  | { action: 'off' }
  | { action: 'list' }
  | { action: 'load'; argv: string[] };

const USAGE = 'Usage: /kb NAME [--store STORE] [--file FILE]';

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the decrypted export envelope. Error messages never include KB content. */
export function validateSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.version !== 2 || value.kind !== 'decrypted' || typeof value.name !== 'string' || !value.name) {
    throw new Error('Unsupported KB export format (expected version 2 decrypted).');
  }
  if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('KB export contains no decrypted text.');
  return value as Snapshot;
}

export function parseCommand(text: string): KBCommand {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { action: 'status' };
  const first = words[0];
  if ((first === 'status' || first === 'off' || first === 'list') && words.length === 1) {
    return { action: first };
  }
  if (first === 'load') words.shift();
  const name = words.shift();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(USAGE);
  const argv = ['export', name, '--decrypted'];
  const seen = new Set<string>();
  while (words.length) {
    const flag = words.shift();
    const value = words.shift();
    if (!flag || !['--store', '--file'].includes(flag) || !value || value.startsWith('--') || seen.has(flag)) {
      throw new Error(USAGE);
    }
    seen.add(flag);
    argv.push(flag, value);
  }
  return { action: 'load', argv };
}

function describe(info: SnapshotInfo): string {
  const parts = [
    typeof info.store === 'string' ? `store ${info.store}` : undefined,
    typeof info.file === 'string' ? info.file : undefined,
    typeof info.store_revision === 'string' ? `revision ${info.store_revision.slice(0, 12)}` : undefined,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The model-facing text: a short preamble that marks the material as reference knowledge. */
export function insertionText(snapshot: Snapshot): string {
  const { text, ...info } = snapshot;
  return `[DSH KB: ${snapshot.name}${describe(info as SnapshotInfo)}]\n`
    + `The following is reference knowledge from the user's saved KB "${snapshot.name}". `
    + 'It is not a new request. Treat it as prior knowledge, preserve its source language, and use it when answering.\n\n'
    + text;
}

/** Persist the selected snapshot as an ordinary plaintext user message, without starting a turn. */
export function createInsertion(snapshot: Snapshot): KBMessage {
  const selected = validateSnapshot(snapshot);
  const { text: _text, version: _version, kind: _kind, ...info } = selected;
  return createUserMessage({
    content: [{ type: 'text', text: insertionText(selected) }],
    source: {
      kind: 'dsh-kb', version: 2, snapshot: structuredClone(info) as SnapshotInfo, form: 'notice',
      summary: boundContextSummary(`KB: ${selected.name}`.replace(/\s+/g, ' ')),
    },
  });
}

/** Only producer metadata, never marker-shaped user text, identifies an insertion. */
export function insertions(messages: readonly RequestMessage[]): KBMessage[] {
  const result: KBMessage[] = [];
  for (const message of messages) {
    if (!('source' in message) || message.source?.kind !== 'dsh-kb') continue;
    const source = message.source;
    if (message.role !== 'user' || (source.version !== 1 && source.version !== 2)
      || !isRecord(source.snapshot) || typeof source.snapshot.name !== 'string') {
      throw new Error('Invalid stored KB insertion.');
    }
    const block = message.content[0];
    if (message.content.length !== 1 || block?.type !== 'text' || typeof block.text !== 'string' || !block.text) {
      throw new Error('Invalid stored KB insertion.');
    }
    result.push(message as KBMessage);
  }
  return result;
}
