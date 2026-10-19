import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands';
import { createKbHandler } from './command.ts';
import { executor } from './execute.ts';
import { registerPending } from './pending.ts';

export const name = 'dsh-kb';
export const inject = ['commands', 'sessions', 'agents'];
export interface Config { command?: string; timeoutMs?: number; maxBufferBytes?: number }
export const Config: z<Config> = z.object({
  command: z.string(),
  timeoutMs: z.number().min(1).default(120_000),
  maxBufferBytes: z.number().min(1).default(128 * 1024 * 1024),
});

/** Root plugin: inserts decrypted KB text as ordinary, provider-independent DSH user messages. */
export function apply(ctx: Context, config: Config = {}): void {
  registerPending(ctx);
  const controller = new AbortController();
  const active = new Set<Promise<CommandResult>>();
  const handler = createKbHandler({
    flush: session => ctx.sessions.flush(session),
  }, executor(config.command ?? process.env.DSH_KB_COMMAND ?? process.env.PI_KB_COMMAND ?? 'kb', config.timeoutMs, config.maxBufferBytes));
  const run = (invocation: CommandInvocation) => {
    const promise = handler({ ...invocation, signal: AbortSignal.any([invocation.signal, controller.signal]) });
    active.add(promise);
    const retire = () => { active.delete(promise); };
    void promise.then(retire, retire);
    return promise;
  };
  ctx.effect(function* () {
    yield async () => { controller.abort(); await Promise.allSettled(active); };
    yield ctx.commands.register({ definitionId: CommandDefinitionId('dsh-kb'), name: 'kb',
      description: 'Insert a saved decrypted KB into the conversation', input: { hint: 'NAME [--store STORE] [--file FILE] | list | status | off' }, handler: run });
  }, 'dsh-kb lifecycle');
}
