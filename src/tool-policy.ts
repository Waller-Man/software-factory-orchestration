import type { Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';

/** Keep native capabilities; starting a business Run remains a human UI action. */
export function installSelectionToolPolicy(scope: Context): void {
  const launch = 'sf_runtime_run_tool';
  if (scope.tools.get(launch, scopeOf(scope))) scope.tools.restrict({ deny: [launch] });
  // Also denies a Runtime entry that appears after this composition activated.
  scope.tools.guard(exec => exec.name === launch ? '请在审核卡上确认并执行，选择助手不能启动业务任务' : undefined);
}
