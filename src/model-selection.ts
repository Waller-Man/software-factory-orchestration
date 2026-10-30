import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-api-session-controller';

/** Read real native routing IDs; a pending choice takes precedence over prior use. */
export function selectedModel(ctx: Context, agent?: Agent): ModelSelection | undefined {
  const projected = agent && ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection');
  const selected = projected ? projected.pending ?? projected.lastUsed : undefined;
  const recorded = agent?.session.requestHeader()?.config;
  const choice = selected ?? (recorded?.provider && recorded.model ? recorded : undefined)
    ?? (agent?.options.provider && agent.options.model ? agent.options : undefined)
    ?? ctx.get('agentDefaultModel')?.currentSelection();
  if (!choice?.provider || !choice.model) return undefined;
  return { provider: choice.provider, model: choice.model,
    ...(choice.reasoningEffort ? { reasoningEffort: ReasoningEffortId(String(choice.reasoningEffort)) } : {}) };
}
