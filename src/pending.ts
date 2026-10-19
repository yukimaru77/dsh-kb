import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { insertions, type KBMessage } from './core.ts';

/**
 * Recover selected KB snapshots that have never entered model-visible history.
 * Inbox clearing cancels delivery, not the saved selection. Once a message id
 * appears in user/message, even a later compaction cannot make it pending again.
 * @param session - durable log containing original inbox insertions and admissions.
 * @returns unique unadmitted snapshots, in their original selection order.
 */
export function pendingInsertions(session: Session): KBMessage[] {
  const selected = new Map<MessageId, KBMessage>();
  const admitted = new Set<MessageId>();
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type === 'user/message') admitted.add(event.data.id);
    if (event?.type !== 'agent/inbox/spliced') continue;
    for (const message of insertions(event.data.inserted)) {
      if (!selected.has(message.id)) selected.set(message.id, message);
    }
  }
  return [...selected.values()].filter(message => !admitted.has(message.id));
}

/**
 * Save a selected snapshot through the existing durable inbox event vocabulary.
 * @param agent - idle agent whose first system head has not yet been admitted.
 * @param message - immutable selected KB snapshot and its stable message id.
 */
export function queuePersistentInsertion(agent: Agent, message: KBMessage): void {
  agent.inject(message);
}

function missing(agent: Agent, claimed: readonly UserMessage[] = []): KBMessage[] {
  const present = new Set([...claimed, ...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id));
  return pendingInsertions(agent.session).filter(message => !present.has(message.id));
}

/**
 * Restore unadmitted selections after cancellation, restart, or fork.
 * @param ctx - root plugin context owning these lifecycle listeners.
 */
export function registerPending(ctx: Context): void {
  const restoreInbox = (agent: Agent): void => {
    for (const message of missing(agent)) agent.inject(message);
  };
  ctx.on('agent/created', ({ agent }) => {
    restoreInbox(agent);
    return undefined;
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const pending = missing(agent, decision.messages);
    return pending.length ? { ...decision, messages: [...pending, ...decision.messages] } : decision;
  }, { prepend: true });
  // A plugin reload may attach to an already published idle agent. A running
  // agent can have claimed messages outside its inbox; its next pre-step handles recovery.
  for (const agent of ctx.get('agents')?.list() ?? []) {
    if (agent.status === 'idle') restoreInbox(agent);
  }
}
