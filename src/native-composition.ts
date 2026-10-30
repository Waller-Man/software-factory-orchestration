import type { Context } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { auditRows, leakedServices, entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry';
import { EntryTree, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import { prepareProfileEntries } from '@deepseek-ai/dsh-app-boot';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { load } from 'js-yaml';
import { ensure } from './core.ts';

/** In-memory Loader tree, following the host preset's ownership convention. */
class NativeTree extends EntryTree {
  constructor(ctx: Context) {
    const owner = ctx.fiber.entry, subtree = owner?.subtree, subgroup = owner?.subgroup;
    super(ctx);
    if (owner) {
      if (subtree === undefined) delete owner.subtree; else owner.subtree = subtree;
      if (subgroup === undefined) delete owner.subgroup; else owner.subgroup = subgroup;
    }
  }
  override write(): void {}
}

/** Recompose the host's real standard capabilities, including its isolated services. */
export async function mountNativeComposition(scope: Context): Promise<void> {
  const document = await scope.agentPresets.readDocument('standard');
  const plugins = load(document.content, { schema: entryListSchema });
  ensure(!entryListProblem(plugins), 'NATIVE_MODE_UNAVAILABLE', 'DSH 标准模式配置不可用');
  // A separate lifetime avoids awaiting the currently activating plugin itself;
  // the same registration key makes the standard tools part of this preset.
  const native = createScope(scope, scopeOf(scope)!);
  await native.ctx.fiber.await();
  const tree = new NativeTree(native.ctx);
  native.ctx.effect(() => () => { tree.root.stop(); });
  await tree.root.update(prepareProfileEntries(native.ctx, plugins as EntryOptions[], native.ctx.baseUrl));
  const audit = await auditRows(tree);
  ensure(!audit.failed.length, 'NATIVE_MODE_UNAVAILABLE', audit.failed.join('\n'));
  ensure(!leakedServices(native.ctx, native.ctx.fiber).length, 'NATIVE_MODE_UNAVAILABLE', '原生模式服务必须保持隔离作用域');
}
