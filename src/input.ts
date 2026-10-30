import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, open, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type { SourceFile } from './types.ts';
import { ensure } from './core.ts';
const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'); };
/** Planning computes a destination only; writes require a normal user-authorized Tool call. */
export async function materialize(ctx: Context, agent: Agent, taskId: string, file: SourceFile, write: boolean, signal: AbortSignal): Promise<string> {
  ensure(/^[0-9a-f-]{36}$/.test(taskId) && /^sha256:[0-9a-f]{64}$/.test(file.attachmentId), 'INVALID_FILE', '附件标识无效');
  const root = await realpath(agent.session.header.cwd!);
  const extension = extname(basename(file.name)).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 16);
  const folder = join(root, 'outputs', 'selection-inputs', taskId), path = join(folder, file.attachmentId.slice(7) + extension);
  if (!write) return path;
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session });
  ensure(policy && policy.mode !== 'read-only', 'WRITE_DENIED', '当前会话不允许准备附件');
  if (policy.mode === 'workspace-write') { const allowed = await realpath(policy.workspaceRoot); ensure(root === allowed || inside(allowed, root), 'WRITE_DENIED', '附件目标不在可写工作区'); }
  let parent = root;
  for (const part of ['outputs', 'selection-inputs', taskId]) {
    parent = join(parent, part); await mkdir(parent).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const stat = await lstat(parent); ensure(stat.isDirectory() && !stat.isSymbolicLink() && inside(root, await realpath(parent)), 'UNSAFE_PATH', '附件目标目录无效');
  }
  const attachments = ctx.get('attachments'); ensure(attachments, 'ATTACHMENT_UNAVAILABLE', 'DSH附件服务未启用');
  signal.throwIfAborted();
  const handle = await open(path, 'wx');
  try {
    const hash = createHash('sha256'); let count = 0;
    for await (const chunk of attachments.readFileStream(file as FileAttachmentRef, signal)) {
      count += chunk.byteLength; ensure(count <= file.bytes, 'FILE_CHANGED', '附件大小不一致'); hash.update(chunk); await handle.writeFile(chunk);
    }
    ensure(count === file.bytes && 'sha256:' + hash.digest('hex') === file.attachmentId, 'FILE_CHANGED', '附件内容校验失败');
    await handle.sync(); return path;
  } finally { await handle.close(); }
}
