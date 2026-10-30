import { Context, Service } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { HugeGraphReadService, ToolRequest } from '@software-factory/gateway/types';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-skill';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { readFile } from 'node:fs/promises';
import { z, type ZodType } from 'zod';
import { SelectionBackend, PRESET, SUBMIT, sourceOf } from './backend.ts';
import { domainSpec } from './store.ts';
import { UiAuthorization, UI_PATH } from './authorization.ts';
import { installSelectionToolPolicy } from './tool-policy.ts';
import { mountNativeComposition } from './native-composition.ts';
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { ensure, failure } from './core.ts';
import type { Result, Selection, SelectionRequest, PrepareRequest, ReviewPlan, ConfirmRequest, RunBinding, SessionRequest, SessionBinding, Recommendation } from './types.ts';
export type * from './types.ts';
export { PRESET, SUBMIT };
declare module '@deepseek-ai/cordis' { interface Context { sfOrchestration: OrchestrationApi } }
const id = z.string().min(1).max(4096);
const input = z.record(z.string(), z.json());
const parameterChoice = { versionId: id, input: input.optional(), fileId: id.or(z.literal('')).optional() };
const recommendation = z.object({ versionId: id.optional(), summary: z.string().min(1).max(8000), reasons: z.array(z.string().max(4000)).max(20), evidence: z.array(z.string().max(4000)).max(30), alternatives: z.array(z.string().max(4000)).max(20), unresolved: z.array(z.string().max(4000)).max(20), input: input.optional(), fileId: id.or(z.literal('')).optional(), parameterNotes: z.array(z.string().max(4000)).max(30).optional() }).strict();
const schemas = {
  session: z.object({ sessionId: id.optional(), sourceSessionId: id.optional(), workspaceId: id.optional() }).strict(),
  get: z.object({ selectionId: id }).strict(),
  prepare: z.object({ selectionId: id, revision: z.number().int().min(1), ...parameterChoice, assist: z.boolean().optional() }).strict(),
  confirm: z.object({ selectionId: id, revision: z.number().int().min(1), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
};
const output = { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] };
const owners = new WeakMap<object, { backend: SelectionBackend; auth: UiAuthorization }>();
export class OrchestrationApi extends TypertRemoteService {
  static inject = ['agents', 'tools', 'typert', 'storageDomain', 'connection', 'skills', 'agentPresets', 'workingDirectory', 'agentDefaultModel', 'sessionProjections'];
  private owner = {};
  constructor(ctx: Context) { super(ctx, 'sfOrchestration'); }
  private state() { const v = owners.get(this.owner); ensure(v, 'UNAVAILABLE', 'Agent 编排后端未就绪'); return v; }
  protected async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const domain = await this.ctx.storageDomain.open(domainSpec);
    const backend = new SelectionBackend(this.ctx, domain.table('selections')), auth = new UiAuthorization();
    owners.set(this.owner, { backend, auth });
    const skillBody = await readFile(new URL('../skills/agent-selection/SKILL.md', import.meta.url), 'utf8');
    const removeSkill = this.ctx.skills.register({ name: 'software-factory-agent-selection', description: '单版本选择与人工审核', source: 'bundled', content: skillBody.replace(/^---[\s\S]*?---\s*/, ''), invocation: { userInvocable: true, modelInvocable: true }, resourceBase: { kind: 'opaque', description: 'Bundled selection rules' } });
    const connection = this.ctx.connection;
    const removeRoute = connection.fetch.register({ path: UI_PATH, methods: ['POST'], requestBody: 'buffered', fetch: req => auth.bootstrap(req, connection) });
    yield async () => { auth.dispose(); removeSkill(); await removeRoute(); await backend.dispose(); owners.delete(this.owner); await domain.close(); };
  }
  /** Native standard capabilities plus selection rules and human-reviewed execution. */
  async compose(scope: Context): Promise<void> {
    const { backend } = this.state();
    await mountNativeComposition(scope);
    const skill = await scope.skills.get('software-factory-agent-selection', { scope: scopeOf(scope) });
    ensure(skill, 'SKILL_REQUIRED', '选择 Skill 未加载');
    scope.systemPrompt.section({ name: 'sf-selection', complete: true, interpolate: false, order: 0, text: '你是软件工厂 Agent 编排助手。使用下列 Skill 选择一个具体版本。所有执行由网页人工确认完成。\n' + renderSkillContent(skill) });
    const definitions = new Map<string, ToolDefinition>();
    const gatewayTool = this.ctx.tools.get('hugegraph_read');
    ensure(gatewayTool, 'GATEWAY_UNAVAILABLE', '请先启用只读 Gateway');
    const read: ToolDefinition = { ...gatewayTool, execute: async (args, exec) => {
      try { ensure(exec.agent, 'SESSION_REQUIRED', '需要真实会话'); return await backend.read(exec.agent, args as ToolRequest, exec.signal); }
      catch (e) { return { ok: false, error: failure(e) }; }
    } };
    const parameterProperties = { versionId: { type: 'string' }, input: { type: 'object', additionalProperties: true }, fileId: { type: 'string', description: '会话真实附件ID，不填path；空字符串表示不绑定文件' } };
    const inspect: ToolDefinition = { name: 'inspect_agent_selection', description: '检查真实Runtime参数契约并整理参数。自动加载所有当前可执行Agent；返回缺参及填写说明，不运行算法、不显示执行表单。', parameters: { type: 'object', properties: parameterProperties, required: ['versionId'], additionalProperties: false }, output,
      execute: async (args, exec) => { try { ensure(exec.agent, 'SESSION_REQUIRED', '需要真实会话'); const plan = await backend.inspect(exec.agent, z.object(parameterChoice).strict().parse(args) as { versionId: string; input?: import('./types.ts').ObjectValue; fileId?: string }); return { ok: true, data: { ...plan, input: Object.fromEntries(Object.entries(plan.input).filter(([key]) => key !== 'path')), ...(plan.file ? { fileId: plan.file.attachmentId } : {}) } }; } catch (e) { return { ok: false, error: failure(e) }; } } };
    const submit: ToolDefinition = { name: SUBMIT, description: '提交真实versionId、选择报告及整理后的参数。先inspect_agent_selection；有必需参数缺失时在聊天询问。此工具不批准、不执行。',
      parameters: { type: 'object', properties: { ...parameterProperties, summary: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, alternatives: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, parameterNotes: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'reasons', 'evidence', 'alternatives', 'unresolved'], additionalProperties: false }, output,
      execute: async (args, exec) => {
        try { ensure(exec.agent, 'SESSION_REQUIRED', '需要真实会话'); return { ok: true, data: await backend.submit(exec.agent, recommendation.parse(args) as Recommendation) }; }
        catch (e) { return { ok: false, error: failure(e) }; }
      } };
    const attachment: ToolDefinition = { name: 'sf_selection_read_attachment', description: '按真实attachmentId查找本会话历史上传附件。小型UTF-8文本直接读取，DOCX/PDF等返回宿主路径供原生文件/命令工具解析。',
      parameters: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'], additionalProperties: false }, output,
      execute: async (args, exec) => {
        try {
          ensure(exec.agent, 'SESSION_REQUIRED', '需要真实会话');
          const file = sourceOf(exec.agent).files.find(f => f.attachmentId === (args as { attachmentId: string }).attachmentId);
          ensure(file, 'FILE_NOT_IN_SESSION', '附件不在本会话的用户上传记录中，请使用真实 attachmentId');
          const attachments = this.ctx.get('attachments'); ensure(attachments, 'UNAVAILABLE', '附件服务未就绪');
          const path = attachments.fileHostPath(file as FileAttachmentRef);
          if (!/\.(txt|md|json|csv|tsv|yaml|yml|xml|html|log)$/i.test(file.name) || file.bytes > 128 * 1024) {
            return { ok: true, data: { ...file, ...(path ? { path } : {}), note: path ? '使用原生文件/命令工具解析此附件；提取材料写入当前工作区，原附件保留。' : '当前附件后端没有本地路径；可用于审核卡绑定，但尚未提取正文。' } };
          }
          const chunks: Uint8Array[] = []; let length = 0;
          for await (const chunk of attachments.readFileStream(file as never, exec.signal)) { length += chunk.byteLength; ensure(length <= 128 * 1024, 'LIMIT', '文本超过128KiB，请按任务说明选择处理版本'); chunks.push(chunk); }
          return { ok: true, data: { name: file.name, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } };
        } catch (e) { return { ok: false, error: failure(e) }; }
      } };
    for (const tool of [read, inspect, submit, attachment]) { definitions.set(tool.name, tool); scope.tools.register(tool); }
    installSelectionToolPolicy(scope); scope.tools.presentAs('native');
    scope.tools.guard(exec => !owners.has(this.owner) ? '编排插件已停用' : definitions.has(exec.name) && definitions.get(exec.name) !== scope.tools.get(exec.name, exec.agent) ? '编排工具定义已变化' : undefined);
  }
  private async invoke<I, O>(token: string, request: I, schema: ZodType<I>, fn: (input: I) => O | Promise<O>): Promise<Result<O>> {
    try {
      this.state().auth.check(this.ctx.invocation, token);
      const original = this.ctx.invocation?.request.args.request ?? request;
      ensure(Buffer.byteLength(JSON.stringify(original) ?? '') <= 256 * 1024, 'LIMIT', '请求过大');
      return { ok: true, data: await fn(schema.parse(original)) };
    } catch (e) { return { ok: false, error: e instanceof z.ZodError ? { code: 'INVALID_INPUT', message: '参数不符合接口' } : failure(e) }; }
  }
  @Remote
  async ensureSession(token: string, request: SessionRequest): Promise<Result<SessionBinding>> { return this.invoke(token, request, schemas.session, r => this.state().backend.ensureSession(r)); }
  @Remote
  async getSelection(token: string, request: SelectionRequest): Promise<Result<Selection>> { return this.invoke(token, request, schemas.get, r => this.state().backend.getReview(r.selectionId)); }
  @Remote
  async prepareRun(token: string, request: PrepareRequest): Promise<Result<ReviewPlan>> { return this.invoke(token, request, schemas.prepare, r => this.state().backend.prepare(r)); }
  @Remote
  async confirmRun(token: string, request: ConfirmRequest): Promise<Result<RunBinding>> { return this.invoke(token, request, schemas.confirm, r => this.state().backend.confirm(r)); }
}
export default OrchestrationApi;
