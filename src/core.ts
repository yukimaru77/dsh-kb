import { randomUUID } from 'node:crypto';
import { boundContextSummary, createUserMessage, type RequestMessage, type UserMessage } from '@deepseek-ai/dsh-llm';

export type JsonRecord = Record<string, unknown>;
export interface Snapshot extends JsonRecord {
  version: 1;
  name: string;
  items: JsonRecord[];
}

export interface KBSource {
  kind: 'dsh-kb';
  version: 1;
  snapshot: Snapshot;
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

export const BLOB_TYPES = new Set(['compaction', 'compaction_summary', 'context_compaction']);
const USAGE = 'Usage: /kb NAME [--store STORE] [--file FILE]';

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the export envelope while preserving all portable item fields. */
export function validateSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.version !== 1 || typeof value.name !== 'string' || !Array.isArray(value.items)) {
    throw new Error('Unsupported KB export format (expected version 1).');
  }
  let blobs = 0;
  for (const item of value.items) {
    if (!isRecord(item)) throw new Error('Unsupported KB item.');
    if (typeof item.type === 'string' && BLOB_TYPES.has(item.type)) {
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) {
        throw new Error('KB contains an empty encrypted blob.');
      }
      blobs++;
    } else if (!((item.type === 'message' || item.type === undefined)
      && (item.role === 'user' || item.role === 'developer') && item.content)) {
      throw new Error('Unsupported KB item.');
    }
  }
  if (!blobs) throw new Error('KB contains no encrypted blobs.');
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
  const argv = ['export', name];
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

/** Persist the selected snapshot at this conversation position, without starting a turn. */
export function createInsertion(snapshot: Snapshot): KBMessage {
  const selected = validateSnapshot(snapshot);
  return createUserMessage({
    content: [{ type: 'text', text: `[DSH_KB:${randomUUID()}] Encrypted knowledge is unavailable unless dsh-kb is enabled with Codex. Do not infer the missing content.` }],
    source: {
      kind: 'dsh-kb', version: 1, snapshot: selected, form: 'notice',
      summary: boundContextSummary(`KB: ${selected.name}`.replace(/\s+/g, ' ')),
    },
  });
}

function insertionText(message: KBMessage): string {
  const block = message.content[0];
  if (message.content.length !== 1 || block?.type !== 'text' || typeof block.text !== 'string' || !block.text) {
    throw new Error('Invalid stored KB insertion.');
  }
  return block.text;
}

/** Only producer metadata, never marker-shaped user text, authorizes an insertion. */
export function insertions(messages: readonly RequestMessage[]): KBMessage[] {
  const result: KBMessage[] = [];
  for (const message of messages) {
    if (!('source' in message) || message.source?.kind !== 'dsh-kb') continue;
    if (message.role !== 'user' || message.source.version !== 1) throw new Error('Invalid stored KB insertion.');
    validateSnapshot(message.source.snapshot);
    const insertion = message as KBMessage;
    insertionText(insertion);
    result.push(insertion);
  }
  return result;
}

/** Expand once after Responses serialization, before chat or compact captures its input. */
export function expandInsertions(payload: JsonRecord, messages: readonly RequestMessage[]): JsonRecord {
  if (!isRecord(payload) || !Array.isArray(payload.input)) throw new Error('Codex payload has no input array.');
  const trusted = new Map<string, Snapshot>();
  for (const message of insertions(messages)) {
    const marker = insertionText(message);
    if (trusted.has(marker)) throw new Error('Duplicate stored KB insertion.');
    trusted.set(marker, message.source.snapshot);
  }
  if (!trusted.size) return payload;
  const seen = new Set<string>();
  const input = payload.input.flatMap((item: unknown) => {
    if (!isRecord(item) || item.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1) return [item];
    const block: unknown = item.content[0];
    if (!isRecord(block) || block.type !== 'input_text' || typeof block.text !== 'string') return [item];
    const snapshot = trusted.get(block.text);
    if (!snapshot) return [item];
    if (seen.has(block.text)) throw new Error('Duplicate KB insertion in converted payload.');
    seen.add(block.text);
    return structuredClone(snapshot.items);
  });
  // A compacted message is absent from `messages`. A live insertion must survive serialization.
  if (seen.size !== trusted.size) throw new Error('KB insertion missing from converted payload.');
  return { ...payload, input };
}
