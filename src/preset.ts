import type { Context } from '@deepseek-ai/cordis';
export const inject = ['sfOrchestration', 'agents', 'agentPresets', 'loader', 'tools', 'systemPrompt', 'skills'];
export async function apply(ctx: Context): Promise<void> {
  const service = ctx.get('sfOrchestration') as unknown as { compose(scope: Context): Promise<void> };
  await service.compose(ctx);
}
