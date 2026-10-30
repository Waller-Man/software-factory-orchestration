import { randomUUID } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection, type Agent, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { HugeGraphReadService, ToolRequest } from '@software-factory/gateway/types';
import { sessionRecordKey, type Store } from './store.ts';
import type { Candidate, Selection, Source, Recommendation, PrepareRequest, ReviewPlan, ConfirmRequest, SessionRequest, ObjectValue, ToolContract } from './types.ts';
import { clone, digest, ensure, failure, initialInput, inputIssues, runnable } from './core.ts';
import { materialize } from './input.ts';
import { selectedModel } from './model-selection.ts';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-workspace';
export const PRESET = 'sf-agent-orchestration';
export const SUBMIT = 'submit_agent_selection';
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'sf-selection-review': { kind: 'sf-selection-review'; form: 'notice'; summary: string; selectionId: string } } }
export function sourceOf(agent: Agent): Source {
  const messages = agent.session.deriveMessages().filter(m => m.role === 'user' && m.source.kind === 'user');
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return { messageId: '', text: '', files: [] };
  // Newest uploads first; only user-uploaded references from this actual session.
  const files = new Map<string, Source['files'][number]>();
  for (const message of messages.toReversed()) {
    if (message.role !== 'user') continue;
    for (const block of message.content) if (block.type === 'file' && !files.has(block.attachment.attachmentId)) files.set(block.attachment.attachmentId, clone(block.attachment));
  }
  return { messageId: last.id, text: last.content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
    files: [...files.values()] };
}
export class SelectionBackend {
  private tail: Promise<unknown> = Promise.resolve();
  private handles = new Map<string, AgentHandle>();
  private boundModels = new WeakSet<Agent>();
  private modelBindings = new Map<Agent, () => void>();
  private previews = new Map<string, ReviewPlan>();
  private active = true;
  private life = new AbortController();
  constructor(private ctx: Context, private store: Store) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const call = this.tail.then(fn); this.tail = call.catch(() => {}); return call;
  }
  private gateway(): HugeGraphReadService {
    const reader = this.ctx.get('hugegraphRead') as HugeGraphReadService | undefined;
    ensure(reader?.apiVersion === '1.0', 'GATEWAY_UNAVAILABLE', '请启用 Gateway read API 1.0'); return reader;
  }
  private agent(id: string): Agent {
    const agent = this.ctx.agents.get(SessionId(id));
    ensure(this.active && agent, 'SESSION_REQUIRED', '请重新打开本次编排会话'); return agent;
  }
  get(id: string): Selection { const row = this.store.get(id); ensure(row, 'NOT_FOUND', '选择记录不存在'); return clone(row); }
  async getReview(id: string) {
    const row = this.get(id);
    // Reopen source and execution sessions for native history and artifact routes.
    if (row.status === 'review') { await this.sourceAgent(row); await this.discover(row); }
    else if (row.runtimeSessionId) await this.worker(row);
    return this.get(id);
  }
  /** All graph versions with a live Runtime entry, independently of the LLM query path. */
  private async discover(row: Selection): Promise<void> {
    const worker = await this.worker(row), candidates = new Map<string, Candidate>();
    const warnings: string[] = []; let offset = 0, complete = true, observedAt: string | undefined;
    for (;;) {
      const result = await this.gateway().read({ kind: 'candidates', detail: 'full', limit: 100, offset }, this.life.signal);
      ensure(result.ok && 'kind' in result.data && result.data.kind === 'candidates', 'CANDIDATES_UNAVAILABLE', '无法读取完整候选列表，请重试');
      observedAt = result.meta.observedAt; complete = complete && result.meta.complete && !result.meta.truncated;
      warnings.push(...result.meta.reasons, ...result.meta.warnings.map(w => w.message));
      for (const candidate of result.data.items as Candidate[]) {
        try { runnable(candidate); await this.call(worker, 'sf_runtime_get_tool_contract', { toolId: candidate.version.properties.dsh_ref }); candidates.set(candidate.version.vertexId, clone(candidate)); }
        catch (error) { warnings.push(String(candidate.agent.properties.name ?? candidate.version.vertexId) + '：' + failure(error).message); }
      }
      if (!result.data.page.hasMore) break;
      const next = result.data.page.nextOffset;
      ensure(typeof next === 'number' && next > offset && next < 5000, 'CANDIDATES_LIMIT', '候选分页不完整，请检查 Gateway'); offset = next;
    }
    const current = this.get(row.id);
    current.runtimeSessionId = row.runtimeSessionId; current.candidates = [...candidates.values()]; current.complete = complete; current.observedAt = observedAt;
    current.warnings = [...new Set(warnings)]; await this.store.put(current.id, current);
  }
  async inspect(agent: Agent, request: { versionId: string; input?: ObjectValue; fileId?: string }): Promise<ReviewPlan> {
    const task = await this.record(agent); await this.discover(task);
    return this.parameters(this.get(task.id), request);
  }
  async record(agent: Agent): Promise<Selection> {
    const source = sourceOf(agent); ensure(source.messageId, 'TASK_REQUIRED', '请先发送任务');
    return this.serial(async () => {
      const found = [...this.store.entries()].map(([, r]) => r).find(r => r.sessionId === agent.id && r.source.messageId === source.messageId);
      if (found) return clone(found);
      ensure(agent.session.header.cwd, 'WORKSPACE_REQUIRED', '本次任务需要真实 DSH 工作区');
      const workspace = await realpath(agent.session.header.cwd);
      const row: Selection = { id: randomUUID(), sessionId: agent.id, workspace, revision: 0, source, candidates: [], complete: false, warnings: [], status: 'analyzing', plan: { schemaVersion: 1, nodes: [], edges: [] } };
      await this.store.put(row.id, row); return clone(row);
    });
  }
  async read(agent: Agent, input: ToolRequest, signal: AbortSignal): Promise<unknown> {
    const task = await this.record(agent), gateway = this.gateway();
    if (input.action === 'health') return gateway.health(signal);
    if (input.action === 'snapshot') return gateway.snapshot(input.options, signal);
    const query = input.query.kind === 'candidates' ? { ...input.query, detail: 'full' as const } : input.query;
    const result = await gateway.read(query, signal);
    if (result.ok && 'kind' in result.data && result.data.kind === 'candidates') {
      const candidates = result.data.items as Candidate[];
      const hasMore = result.data.page.hasMore;
      await this.serial(async () => {
        const row = this.get(task.id);
        ensure(!['starting', 'started', 'uncertain'].includes(row.status), 'TASK_LOCKED', '本轮已进入执行，请发送新任务');
        const all = new Map(row.candidates.map(c => [c.version.vertexId, c]));
        for (const c of candidates) all.set(c.version.vertexId, clone(c));
        ensure(all.size <= 500, 'LIMIT', '本轮候选过多，请缩小任务范围');
        row.candidates = [...all.values()]; row.observedAt = result.meta.observedAt;
        row.complete = result.meta.complete && !result.meta.truncated;
        row.warnings = [...new Set([...row.warnings, ...result.meta.reasons, ...result.meta.warnings.map(w => w.message),
          ...(hasMore ? ['本次查询仍有后续分页，尚不能声称已比较全部版本'] : [])])];
        await this.store.put(row.id, row);
      });
    }
    return result;
  }
  async submit(agent: Agent, recommendation: Recommendation): Promise<{ selectionId: string; issues: string[] }> {
    const task = await this.record(agent);
    await this.discover(task);
    return this.serial(async () => {
      const row = this.get(task.id);
      let issues: string[] = [];
      ensure(row.status !== 'starting' && row.status !== 'started' && row.status !== 'uncertain', 'TASK_LOCKED', '本轮已经提交执行，请发送新任务');
      ensure(recommendation.versionId || !row.candidates.length, 'VERSION_REQUIRED', '请提交真实 versionId，不能只在报告文字中写已选择Agent');
      ensure(!row.manualVersionId || recommendation.versionId === row.manualVersionId, 'MANUAL_SELECTION', '人工已改选，请按人工选定版本整理参数并提交');
      if (recommendation.versionId) {
        const c = row.candidates.find(c => c.version.vertexId === recommendation.versionId);
        ensure(c, 'UNREAD_VERSION', '只能推荐本轮实际读取的候选 vertexId'); runnable(c);
      }
      if (recommendation.versionId) {
        const plan = await this.parameters(row, { versionId: recommendation.versionId, input: recommendation.input, fileId: recommendation.fileId });
        issues = plan.issues;
        row.parameterDrafts ??= {};
        row.parameterDrafts[recommendation.versionId] = { input: recommendation.input ?? {}, ...(recommendation.fileId !== undefined ? { fileId: recommendation.fileId } : {}), notes: recommendation.parameterNotes ?? [] };
        if (plan.issues.length) recommendation.unresolved = [...new Set([...recommendation.unresolved, ...plan.issues])];
      }
      row.recommendation = clone(recommendation); row.revision++; row.status = 'review';
      row.plan.nodes = recommendation.versionId ? [{ versionId: recommendation.versionId }] : [];
      this.previews.delete(row.id); await this.store.put(row.id, row);
      return { selectionId: row.id, issues };
    });
  }
  private bindModel(agent: Agent): void {
    if (this.boundModels.has(agent)) return;
    this.boundModels.add(agent);
    const ctx = this.ctx;
    const selection: ModelSelectionRef = { get current() { return selectedModel(ctx, agent); }, assembled: undefined };
    const remove = installModelSelection(agent.ctx, selection);
    // Native selectModel logs this event then installs its own mutable binding.
    // Hand off to that owner instead of keeping two model-switch listeners.
    const stop = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'model/selection') return;
      this.modelBindings.get(agent)?.();
      this.modelBindings.delete(agent);
    });
    this.modelBindings.set(agent, () => { stop(); remove(); });
  }
  private async open(id: string, cwd: string, preset: boolean, source?: Agent): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(id));
    if (live) {
      if (preset) {
        ensure((this.ctx.get('sessionProjections')?.stateOf(live.session, 'agentPreset') ?? live.session.header.agentPreset) === PRESET, 'MODE_REQUIRED', '此专用会话必须使用 Agent 编排模式');
        this.bindModel(live);
      }
      return live;
    }
    const model = selectedModel(this.ctx, source);
    const persisted = await this.ctx.get('sessionPersistence')?.stat(SessionId(id));
    const setup = preset ? async (scope: Context, agent: Agent) => {
      this.bindModel(agent);
      await this.ctx.agentPresets.mount(scope, PRESET);
      if ((this.ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset) !== PRESET) await this.ctx.agentPresets.select(agent, PRESET);
    } : async (scope: Context) => { scope.tools.presentAs('native'); };
    const handle = persisted
      ? await this.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: model ?? {}, setup })
      : await this.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd, ...(preset ? { agentPreset: PRESET } : {}) }, agentOptions: model ?? {}, setup });
    this.handles.set(id, handle);
    if (!preset && model && !handle.agent.session.requestHeader() && !this.ctx.get('sessionProjections')?.stateOf(handle.agent.session, 'modelSelection')?.pending) handle.agent.session.append('model/selection', model);
    const workspace = this.ctx.get('workspaceRegistry')?.list().find(w => w.path === cwd);
    if (workspace) await workspace.attachSession(SessionId(id));
    return this.agent(id);
  }
  async ensureSession(request: SessionRequest) {
    if (request.sessionId) {
      const record = this.get(sessionRecordKey(request.sessionId));
      ensure(record.workspace, 'SESSION_REQUIRED', '专用会话缺少工作区');
      await this.open(record.sessionId, record.workspace, true);
      return { sessionId: record.sessionId, workspace: record.workspace };
    }
    const source = request.sourceSessionId ? this.ctx.agents.get(SessionId(request.sourceSessionId)) : undefined;
    const requestedWorkspace = request.workspaceId ? this.ctx.get('workspaceRegistry')?.list().find(w => w.id === request.workspaceId) : undefined;
    ensure(!request.workspaceId || requestedWorkspace, 'WORKSPACE_REQUIRED', '请选择 DSH 中已登记的工作区');
    const sourcePath = source ? await this.ctx.workingDirectory.ensure(source, this.life.signal) : undefined;
    const defaultWorkspace = this.ctx.get('workspaceRegistry')?.list()[0];
    const workspacePath = requestedWorkspace?.path ?? sourcePath ?? defaultWorkspace?.path;
    ensure(workspacePath, 'WORKSPACE_REQUIRED', '请先在 DSH 中创建或打开工作区');
    const cwd = await realpath(workspacePath);
    ensure((await lstat(cwd)).isDirectory(), 'WORKSPACE_REQUIRED', '需要有效 DSH 工作区');
    const id = randomUUID();
    const marker: Selection = { id: sessionRecordKey(id), sessionId: id, revision: 0, source: { messageId: '', text: '', files: [] }, candidates: [], complete: false, warnings: [], status: 'analyzing', workspace: cwd, plan: { schemaVersion: 1, nodes: [], edges: [] } };
    await this.store.put(marker.id, marker); await this.open(id, cwd, true, source);
    return { sessionId: id, workspace: cwd };
  }
  private async sourceAgent(row: Selection): Promise<Agent> {
    const existing = this.ctx.agents.get(SessionId(row.sessionId)); if (existing) return existing;
    const marker = this.store.get(sessionRecordKey(row.sessionId));
    const workspace = marker?.workspace ?? row.workspace;
    ensure(workspace, 'SESSION_REQUIRED', '原始会话缺少工作区，请重新发起选择');
    return this.open(row.sessionId, workspace, true);
  }
  private async worker(row: Selection): Promise<Agent> {
    const source = await this.sourceAgent(row);
    const cwd = await realpath(await this.ctx.workingDirectory.ensure(source, this.life.signal));
    ensure(cwd === await realpath(source.session.header.cwd!), 'WORKSPACE_CHANGED', '工作区已变化，请重新发起选择');
    const id = row.runtimeSessionId ?? randomUUID();
    if (!row.runtimeSessionId) { row.runtimeSessionId = id; await this.store.put(row.id, row); }
    return this.open(id, cwd, false, source);
  }
  private async call<T>(agent: Agent, name: string, args: object): Promise<T> {
    const result = await this.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, agent, signal: this.life.signal });
    ensure(!result.isError, 'HOST_TOOL_FAILED', result.isError ? result.error.message : 'Tool 调用失败');
    const value = result.value as { ok: boolean; data: T; error?: { code: string; message: string } };
    ensure(value?.ok, value?.error?.code ?? 'RUNTIME_UNAVAILABLE', value?.error?.message ?? 'Runtime 回执无效');
    return value.data;
  }
  private candidate(row: Selection, versionId: string): Candidate {
    const c = row.candidates.find(c => c.version.vertexId === versionId);
    ensure(c, 'UNREAD_VERSION', '请从本轮已加载候选中选择'); runnable(c); return c;
  }
  private fresh(row: Selection) {
    ensure(row.source.messageId === sourceOf(this.agent(row.sessionId)).messageId, 'STALE_REVIEW', '用户已补充新任务，请等待新一轮推荐');
  }
  private async parameters(row: Selection, request: { versionId: string; input?: ObjectValue; fileId?: string }): Promise<ReviewPlan> {
      const candidate = this.candidate(row, request.versionId), worker = await this.worker(row);
      const contract = await this.call<ToolContract>(worker, 'sf_runtime_get_tool_contract', { toolId: candidate.version.properties.dsh_ref });
      const draft = row.parameterDrafts?.[request.versionId], fileId = request.fileId ?? draft?.fileId;
      const file = fileId === '' ? undefined : fileId ? row.source.files.find(f => f.attachmentId === fileId) : row.source.files.length === 1 ? row.source.files[0] : undefined;
      ensure(!fileId || file, 'FILE_NOT_IN_TASK', '附件不属于本次任务');
      const fields = contract.inputSchema.properties as ObjectValue | undefined;
      const selectedFile = fields?.path ? file : undefined;
      const supplied = request.input ?? draft?.input ?? {};
      ensure(!('path' in supplied), 'FILE_REFERENCE_REQUIRED', '文件输入必须绑定会话真实附件，不能提供模型编造的path');
      const input = initialInput(contract, row.source, supplied, !!selectedFile);
      const issues = inputIssues(contract.inputSchema, input, !!selectedFile);
      if (selectedFile) input.path = await materialize(this.ctx, worker, row.id, selectedFile, false, this.life.signal);
      if (fields?.path && row.source.files.length > 1 && fileId === undefined) issues.push('有多个输入附件，请在聊天中说明使用哪份文档');
      if (row.source.files.length && !selectedFile && !Object.keys(input).length) issues.push('请在聊天中提供业务输入，或让助手绑定已上传的文档');
      issues.push(...validateJsonSchemaValue(contract.inputSchema, input, 'input'));
      const model = selectedModel(this.ctx, worker);
      const llm = this.ctx.get('llm');
      const caption = model ? (await llm?.listModels(model.provider).catch(() => []))?.find(m => m.id === model.model)?.name ?? model.model : undefined;
      const effort = model?.reasoningEffort ? (await llm?.resolveModelInfo(model.provider, model.model).catch(() => undefined))?.reasoning?.efforts.find(item => item.id === model.reasoningEffort)?.name : undefined;
      const modelName = caption ? caption + (effort ? ' · ' + effort : '') : undefined;
      const parameterReport = Object.entries(input).map(([name, value]) => ({ name, value: name === 'path' && selectedFile ? selectedFile.name : value, basis: name === 'path' ? '本会话真实上传附件' : name in supplied ? '助手依据任务和对话整理' : name in ((contract.inputSchema.properties ?? {}) as ObjectValue) && typeof fields?.[name] === 'object' && (fields[name] as ObjectValue).default !== undefined ? '接口默认值' : '用户任务原文' }));
      const plan: ReviewPlan = { selectionId: row.id, revision: row.revision, versionId: request.versionId, digest: '', contract, input, parameterReport, ...(selectedFile ? { file: selectedFile } : {}), runtimeSessionId: worker.id, ...(model ? { model: { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: String(model.reasoningEffort) } : {}) }, modelName } : {}), issues: [...new Set(issues)] };
      plan.digest = digest({ ...plan, candidate });
      return plan;
  }
  async prepare(request: PrepareRequest): Promise<ReviewPlan> {
    return this.serial(async () => {
      const row = this.get(request.selectionId);
      ensure(row.revision === request.revision && row.status === 'review', 'STALE_REVIEW', '审核内容已变化或已执行');
      await this.sourceAgent(row); this.fresh(row);
      const plan = await this.parameters(row, request);
      if (request.assist) {
        row.manualVersionId = request.versionId; row.revision++; this.previews.delete(row.id); await this.store.put(row.id, row);
        const candidate = this.candidate(row, request.versionId);
        this.agent(row.sessionId).followup(createUserMessage({ source: { kind: 'sf-selection-review', form: 'notice', summary: '人工改选Agent，重新整理参数', selectionId: row.id }, content: [{ type: 'text', text: '用户在审核卡选定了 ' + String(candidate.agent.properties.name) + ' / ' + String(candidate.version.properties.version) + '，versionId=' + request.versionId + '。此为人工决定，不可擅自改回。请用 inspect_agent_selection 检查真实参数，能补齐的自行整理，不能补齐的在聊天中询问用户，然后重新 submit_agent_selection。不要执行。当前缺失：' + JSON.stringify(plan.issues) }] }));
        plan.revision = row.revision; plan.issues = [...new Set([...plan.issues, '助手正在按人工选择更新报告，请等待新审核卡'])];
      }
      this.previews.set(row.id, clone(plan)); return clone(plan);
    });
  }
  async confirm(request: ConfirmRequest) {
    return this.serial(async () => {
      const row = this.get(request.selectionId);
      if (row.status === 'started' && row.approvedDigest === request.digest && row.runId && row.runtimeSessionId) return { runId: row.runId, runtimeSessionId: row.runtimeSessionId };
      const plan = this.previews.get(row.id);
      ensure(row.status === 'review' && row.revision === request.revision && plan?.digest === request.digest, 'STALE_REVIEW', '请重新核对输入并生成执行预览');
      ensure(!plan.issues.length, 'INPUT_REQUIRED', plan.issues.join('；'));
      this.fresh(row);
      const c = this.candidate(row, plan.versionId);
      ensure(digest({ ...plan, digest: '', candidate: c }) === plan.digest, 'STALE_REVIEW', '已加载候选资料已变化，请重新核对');
      const fresh = await this.gateway().read({ kind: 'versions', agentId: String(c.agent.properties.agent_id), version: String(c.version.properties.version), detail: 'full' }, this.life.signal);
      ensure(fresh.ok && 'items' in fresh.data && fresh.data.kind === 'versions', 'DATA_CHANGED', '版本无法回读，请重新选择');
      const v = fresh.data.items.find(v => v.vertexId === c.version.vertexId);
      ensure(v && digest(v.properties) === digest(c.version.properties), 'DATA_CHANGED', '版本资料已变化，请重新读取并审核');
      const logical = await this.gateway().read({ kind: 'node', vertexId: c.agent.vertexId }, this.life.signal);
      ensure(logical.ok && 'kind' in logical.data && logical.data.kind === 'node' && digest(logical.data.node.properties) === digest(c.agent.properties), 'DATA_CHANGED', '逻辑 Agent 资料已变化，请重新读取并审核');
      const worker = await this.worker(row), contract = await this.call<ToolContract>(worker, 'sf_runtime_get_tool_contract', { toolId: plan.contract.toolId });
      ensure(digest(contract) === digest(plan.contract), 'CONTRACT_CHANGED', '真实 Tool 契约已变化，请重新核对');
      const selected = selectedModel(this.ctx, worker);
      ensure(digest(selected ? { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: String(selected.reasoningEffort) } : {}) } : null) === digest(plan.model ?? null), 'MODEL_CHANGED', '执行模型已变化，请重新核对');
      row.status = 'starting'; row.approvedDigest = plan.digest; row.selectedVersionId = c.version.vertexId; row.executionModelName = plan.modelName; row.plan.nodes = [{ versionId: c.version.vertexId }]; await this.store.put(row.id, row);
      try {
        if (plan.file) {
          const prepare: ToolDefinition = { name: 'sf_selection_prepare_input', description: '将本次人工确认的附件接入真实工作区', parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute: async (_args, exec) => { ensure(exec.agent === worker, 'UNAUTHORIZED', '附件准备上下文不匹配'); return { path: await materialize(this.ctx, worker, row.id, plan.file!, true, exec.signal) }; } };
          const remove = worker.ctx.tools.register(prepare);
          try {
            const prepared = await this.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: prepare.name, arguments: {}, agent: worker, signal: this.life.signal });
            ensure(!prepared.isError, 'INPUT_PREPARATION_FAILED', prepared.isError ? prepared.error.message : '附件准备失败');
          } finally { remove(); }
        }
        const run = await this.call<{ runId: string }>(worker, 'sf_runtime_run_tool', { toolId: plan.contract.toolId, input: plan.input, ...(plan.model ? { model: plan.model } : {}) });
        row.runId = run.runId; row.runtimeSessionId = worker.id; row.status = 'started'; await this.store.put(row.id, row);
        return { runId: run.runId, runtimeSessionId: worker.id };
      } catch (e) {
        // Never automatically repeat a launch whose result is not known.
        row.status = 'uncertain'; await this.store.put(row.id, row); throw e;
      }
    });
  }
  async dispose() { this.active = false; this.life.abort(); await this.tail; this.previews.clear(); for (const remove of this.modelBindings.values()) remove(); this.modelBindings.clear(); await Promise.allSettled([...this.handles.values()].map(h => h.dispose())); this.handles.clear(); }
}
