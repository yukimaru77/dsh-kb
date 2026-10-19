import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { LlmCallConfig, RequestMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { createInsertion, insertions, parseCommand, validateSnapshot } from './core.ts';
import { KbCommandError, type KbExecutor } from './execute.ts';
import { pendingInsertions, queuePersistentInsertion } from './pending.ts';

export interface KbHost {
  routeFor(agent: Agent, signal?: AbortSignal): Partial<LlmCallConfig> | Promise<Partial<LlmCallConfig>>;
  supportsModel(id: string): boolean;
  flush(session: Session): Promise<unknown>;
}
const USAGE = '/kb 名前 [--store 保存先] [--file ファイル名] · /kb list · /kb status';

async function assertCodex(host: KbHost, agent: Agent, signal: AbortSignal): Promise<Partial<LlmCallConfig>> {
  const route = await host.routeFor(agent, signal);
  if (route.provider !== 'openai-codex' || !route.model || !host.supportsModel(route.model)) {
    throw new KbCommandError('暗号化KBにはCodexモデルを選択してください。');
  }
  return route;
}

/** Report admitted insertions, including ones consumed by compaction, plus fresh-session pending entries. */
function history(agent: Agent): RequestMessage[] {
  const messages: RequestMessage[] = [];
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq));
    if (event?.type === 'user/message') messages.push(event.data);
  }
  return [...messages, ...pendingInsertions(agent.session)];
}

/** Insert under the driver's maintenance lock, with no new model turn. */
export function createKbHandler(host: KbHost, execute: KbExecutor) {
  return async (invocation: CommandInvocation): Promise<CommandResult> => {
    const { agent, signal } = invocation;
    let inserted = false;
    let entered = false;
    try {
      let command: ReturnType<typeof parseCommand>;
      try { command = parseCommand(invocation.rawInput); }
      catch { throw new KbCommandError(`使い方: ${USAGE}`); }
      if (command.action === 'status') {
        const entries = insertions(history(agent));
        const active = insertions(agent.session.deriveMessages()).length;
        const pending = pendingInsertions(agent.session).length;
        return { kind: 'success', text: entries.length
          ? `KB挿入履歴: ${entries.map(entry => entry.source.snapshot.name).join(' → ')}\n現在の会話: ${active}件、次の入力待ち: ${pending}件。圧縮で取り込まれたKBは再挿入しません。`
          : `KB挿入なし。${USAGE}` };
      }
      if (command.action === 'off') {
        return { kind: 'success', text: 'KBは一度挿入する方式です。offでは履歴を削除しません。挿入前への巻き戻し・分岐、または新しい会話を使用してください。' };
      }
      signal.throwIfAborted();
      return await agent.runMaintenance(async maintenanceSignal => {
        entered = true;
        const combined = AbortSignal.any([signal, maintenanceSignal]);
        combined.throwIfAborted();
        const before = command.action === 'load' ? await assertCodex(host, agent, combined) : undefined;
        const generation = agent.session.surface.contentGeneration;
        const length = agent.session.surface.nodes.length;
        const stdout = await execute(command.action === 'list' ? ['list'] : command.argv, {
          cwd: agent.session.header.cwd ?? process.cwd(), signal: combined,
        });
        combined.throwIfAborted();
        if (command.action === 'list') return { kind: 'success', text: stdout.trim() || '登録済みKBはありません。' };
        const after = await assertCodex(host, agent, combined);
        if (generation !== agent.session.surface.contentGeneration || length !== agent.session.surface.nodes.length || before?.provider !== after.provider || before?.model !== after.model) {
          throw new KbCommandError('読み込み中に会話またはモデルが変わったため適用しませんでした。もう一度 /kb を実行してください。');
        }
        let snapshot;
        try { snapshot = validateSnapshot(JSON.parse(stdout)); }
        catch { throw new KbCommandError('kb exportの形式が不正です。version 1の暗号化KBが必要です。'); }
        const message = createInsertion(snapshot);
        combined.throwIfAborted();
        let sourceEventSeq;
        if (agent.session.surface.nodes.length === 0) {
          // The loop owns the protected system head. Queue context until its first admission.
          queuePersistentInsertion(agent, message);
        } else {
          sourceEventSeq = agent.session.append('user/message', message, { surfaceOp: 'append' }).seq;
        }
        inserted = true;
        if (await host.flush(agent.session) === false) throw new KbCommandError('永続化サービスが利用できません。');
        return { kind: 'success', text: `KB「${snapshot.name}」を${sourceEventSeq === undefined ? '次の入力時に挿入するため保存' : '現在の会話位置へ挿入'}しました。以後は通常の圧縮対象です。`,
          ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }) };
      });
    } catch (error) {
      if (inserted) return { kind: 'error', text: 'KBは会話へ追加されましたが、保存完了を確認できません。重複を避けるため再実行せず、/kb statusとセッション保存状態を確認してください。' };
      if (signal.aborted) return { kind: 'error', text: 'KBの読み込みを中止しました。' };
      if (error instanceof KbCommandError) return { kind: 'error', text: error.message };
      return { kind: 'error', text: entered ? 'KBを適用できませんでした。会話の状態と設定を確認してください。' : '応答や別の操作が完了してから /kb を実行してください。' };
    }
  };
}
