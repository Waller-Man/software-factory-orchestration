import { randomBytes } from 'node:crypto';
import type { RemoteInvocation, PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { digest, ensure, failure } from './core.ts';
export const UI_PATH = '/api/sf-orchestration/ui-session';
/** User-only capability. Never returned by Tools, written to storage or inserted into chat. */
export class UiAuthorization {
  private tokens = new Map<string, { peer: PeerScope; expires: number }>();
  async bootstrap(request: Request, connection: HostConnectionHandle): Promise<Response> {
    try {
      const admitted = connection.admit(request);
      ensure('peer' in admitted, 'UNAUTHORIZED', '请登录 DSH');
      const origin = new URL(request.headers.get('origin') ?? '');
      ensure(request.method === 'POST' && origin.host === request.headers.get('host') && origin.origin === request.headers.get('origin') && request.headers.get('sec-fetch-site') === 'same-origin', 'UNAUTHORIZED', '需要同源网页操作');
      ensure(request.headers.get('content-type')?.split(';')[0] === 'application/json' && /^\s*\{\s*\}\s*$/.test(await request.text()), 'INVALID_INPUT', '请求体应为空对象');
      for (const [key, value] of this.tokens) if (value.expires < Date.now()) this.tokens.delete(key);
      ensure(this.tokens.size < 128, 'BUSY', '连接过多，请稍后重试');
      const token = randomBytes(32).toString('base64url'), expires = Date.now() + 20 * 60_000;
      this.tokens.set(digest(token), { peer: admitted.peer, expires });
      return Response.json({ ok: true, data: { token, expiresAt: expires } }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) { return Response.json({ ok: false, error: failure(e) }, { status: 403 }); }
  }
  check(invocation: RemoteInvocation | undefined, token: string): void {
    const value = typeof token === 'string' ? this.tokens.get(digest(token)) : undefined;
    ensure(invocation && value && value.peer === invocation.peer && value.expires > Date.now(), 'UNAUTHORIZED', '人工确认需要有效网页授权，请重新操作');
  }
  dispose() { this.tokens.clear(); }
}
