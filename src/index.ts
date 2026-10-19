import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands';
import type { PayloadTransformRegistry } from 'dsh-pi-compat/payload';
import { createKbHandler } from './command.ts';
import { expandInsertions, insertions } from './core.ts';
import { executor } from './execute.ts';
import { registerPending } from './pending.ts';

export const name = 'dsh-kb';
export const inject = ['commands', 'sessions', 'agents', 'piCompat', 'llm', 'systemPrompt'];
export interface Config { command?: string; timeoutMs?: number; maxBufferBytes?: number }
export const Config: z<Config> = z.object({
  command: z.string(),
  timeoutMs: z.number().min(1).default(120_000),
  maxBufferBytes: z.number().min(1).default(128 * 1024 * 1024),
});
interface CompatibleHost {
  adapter: PayloadTransformRegistry & { model(id: string): { api: string } };
}

/** Root plugin: shares the Codex adapter while retaining KB snapshots in native DSH messages. */
export function apply(ctx: Context, config: Config = {}): void {
  const compat: CompatibleHost = ctx.get('piCompat');
  if (typeof compat?.adapter?.registerPayloadTransform !== 'function') {
    throw new Error('dsh-kb requires a dsh-pi-compat build with the payload transform API. Update and rebuild dsh-pi-compat.');
  }
  registerPending(ctx);
  const controller = new AbortController();
  const active = new Set<Promise<CommandResult>>();
  const handler = createKbHandler({
    routeFor: async (agent, signal) => {
      // UI model selection is scoped prompt state and can change before the next request header.
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
      return { provider: assembly.variables.provider, model: assembly.variables.model };
    },
    supportsModel: id => { try { return compat.adapter.model(id).api === 'openai-codex-responses'; } catch { return false; } },
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
    yield compat.adapter.registerPayloadTransform('dsh-kb', (payload, request) => expandInsertions(payload, request.messages));
    yield ctx.commands.register({ definitionId: CommandDefinitionId('dsh-kb'), name: 'kb',
      description: 'Insert a saved KB snapshot into the conversation', input: { hint: 'NAME [--store STORE] [--file FILE] | list | status | off' }, handler: run });
  }, 'dsh-kb lifecycle');
  ctx.on('llm/stream', (options, next) => {
    if (insertions(options.messages).length && options.provider !== 'openai-codex') {
      throw new Error('This conversation contains encrypted KB. Select a Codex model or compact it with Codex before changing providers.');
    }
    return next();
  }, { prepend: true });
}
