/** Main path only: synthetic graph/business data, real DSH Agents/Tools/Runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId, LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import Runtime from '../../runtime/lib/index.js';
import Registry from '@deepseek-ai/dsh-typert-registry';
import Skills from '@deepseek-ai/dsh-skill';
import { materialize } from '../src/input.ts';
import Orchestration from '../lib/index.js';
import { TYPERT } from '../lib/typert.host.js';
import { registerRunTool } from '../../runtime-sdk/lib/index.js';
import { SelectionBackend, sourceOf } from '../src/backend.ts';
import { runnable, initialInput } from '../src/core.ts';
import { UiAuthorization } from '../src/authorization.ts';
import type { Selection, Candidate } from '../src/types.ts';
import type { Store } from '../src/store.ts';
import { domainSpec, sessionRecordKey } from '../src/store.ts';
import Storage from '@deepseek-ai/dsh-storage';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { ApiSessionAgentController } from '@deepseek-ai/dsh-api-session-controller/src/agent.ts';
import { installModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts';
import { selectedModel } from '../src/model-selection.ts';
import { createScope, bindScopeParent, scopeOf } from '@deepseek-ai/dsh-scope';
import { reduceSelection } from '../../webui/src/pages/orchestration/history.ts';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh';
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local';
import PwshLocal from '@deepseek-ai/dsh-pwsh-local';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import { createZip } from '../../gateway/scripts/archive.mjs';
const item = (n: number): Candidate => ({
  agent: { vertexId: 'agent-vertex-' + n, label: 'Agent', properties: { agent_id: 'agent:example-' + n, name: '合成主流程测试 ' + n, description: '逻辑说明' } },
  version: { vertexId: 'version-vertex-' + n, label: 'AgentVersion', properties: { version: '1.0', status: 'enabled', invoke_kind: 'dsh_tool', dsh_ref: 'selection_example_' + n, description: '版本说明' } },
});
test('document prompts route the displayed native model for new and restored sessions and follow native model changes', { timeout: 15000 }, async () => {
  const ctx = new Context(), rows = new Map<string, Selection>(), calls: GenerateOptions[] = [];
  const store: Store = { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, structuredClone(row)); } };
  await mkdir(resolve('test-results'), { recursive: true }); const workspace = await mkdtemp(resolve('test-results/selection-model-'));
  let backend: SelectionBackend | undefined;
  class MockSelectionModel extends LlmAdapter {
    async listModels(provider: string) { return ['first', 'second'].map(id => ({ provider, id, name: 'Synthetic model ' + id })); }
    async *stream(request: GenerateOptions) {
      calls.push(request);
      yield { type: 'text-delta' as const, index: 0, text: '模拟选择答复，不执行业务' };
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin(Persistence, { root: join(workspace, 'sessions'), compression: 'none' });
    await mountAgentLoopTestHarness(ctx); installModelSelectionProjection(ctx);
    await ctx.plugin(Registry);
    ctx.provide('agentPresets', { mount: async () => {} } as never);
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'selection-fixture', model: 'first' }) } as never);
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'test-workspace', path: workspace, attachSession: async () => {} }] } as never);
    ctx.llm.registerAdapter(['selection-fixture'], new MockSelectionModel());
    backend = new SelectionBackend(ctx, store);
    const fileBytes = Buffer.from('synthetic DOCX reference only; no real document or paid model');
    const file = { attachmentId: AttachmentId('sha256:' + createHash('sha256').update(fileBytes).digest('hex')), name: 'fixture.docx', bytes: fileBytes.length };
    async function send(id: string) {
      const agent = ctx.agents.get(SessionId(id))!;
      const idle = new Promise<void>(resolve => { const stop = ctx.on('agent/status', payload => { if (payload.agent === agent && payload.status === 'idle') { stop(); resolve(); } }); });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '拆分此文档' }, { type: 'file', attachment: file }], source: { kind: 'user' } }));
      await idle;
      assert.ok(agent.session.requestHeader(), 'The real loop must reach model dispatch instead of failing with no provider/model');
      return agent;
    }
    const binding = await backend.ensureSession({});
    const agent = await send(binding.sessionId);
    assert.equal(calls.length, 1); assert.equal(calls[0].provider, 'selection-fixture'); assert.equal(calls[0].model, 'first');
    const native = new ApiSessionAgentController(ctx);
    native.selectForNextRequest(agent, { provider: 'selection-fixture', model: 'second' });
    assert.equal(selectedModel(ctx, agent)?.model, 'second', 'Pending native selection must beat the previous header');
    await backend.ensureSession({ sessionId: agent.id });
    await send(agent.id); assert.equal(calls.at(-1)?.model, 'second');
    assert.equal(agent.session.deriveMessages().filter(m => m.role === 'user' && m.source.kind === 'model-selection').length, 1, 'Native ownership must not produce duplicate model-switch notices');
    const oldId = randomUUID();
    const old = await ctx.agents.create({ sessionId: SessionId(oldId), meta: { cwd: workspace, agentPreset: 'sf-agent-orchestration' }, agentOptions: {} });
    await old.dispose();
    const marker: Selection = { id: sessionRecordKey(oldId), sessionId: oldId, workspace, revision: 0, source: { messageId: '', text: '', files: [] }, candidates: [], complete: false, warnings: [], status: 'analyzing', plan: { schemaVersion: 1, nodes: [], edges: [] } };
    await store.put(marker.id, marker);
    await backend.ensureSession({ sessionId: oldId });
    assert.equal(ctx.agents.get(SessionId(oldId))!.options.model, 'first', 'Restore supplies a model even for older empty sessions without a request header');
    await send(oldId); assert.equal(calls.at(-1)?.model, 'first');
    assert.ok(ctx.agents.get(SessionId(oldId))!.session.deriveMessages().some(m => m.role === 'user' && m.content.some(c => c.type === 'file' && c.attachment.name === 'fixture.docx')));
  } finally { await backend?.dispose(); await ctx.fiber.dispose(); }
});
test('dedicated session creation and restore use real per-record JSON storage with path-safe keys', { timeout: 15000 }, async () => {
  const ctx = new Context();
  await mkdir(resolve('test-results'), { recursive: true });
  const workspace = await mkdtemp(resolve('test-results/selection-storage-'));
  const json = new JsonStorageBackend(join(workspace, 'storage'));
  let backend: SelectionBackend | undefined, restoredBackend: SelectionBackend | undefined, facility: DomainFacility | undefined;
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); await mountAgentLoopTestHarness(ctx);
    await ctx.plugin(Storage); ctx.storage.backend.register('json', json);
    facility = new DomainFacility(ctx, { backend: 'json' });
    let domain = await facility.open(domainSpec);
    const unsafeId = 'session:' + randomUUID();
    const marker: Selection = { id: unsafeId, sessionId: randomUUID(), revision: 0, source: { messageId: '', text: '', files: [] }, candidates: [], complete: false, warnings: [], status: 'analyzing', workspace, plan: { schemaVersion: 1, nodes: [], edges: [] } };
    await assert.rejects(domain.table('selections').put(unsafeId, marker), /not path-safe/);
    ctx.provide('agentPresets', { mount: async () => {} } as never);
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'test-workspace', path: workspace, attachSession: async () => {} }] } as never);
    backend = new SelectionBackend(ctx, domain.table('selections'));
    const binding = await backend.ensureSession({});
    const key = sessionRecordKey(binding.sessionId);
    assert.match(key, /^[a-zA-Z0-9_-]+$/);
    assert.equal(domain.table('selections').get(key)?.sessionId, binding.sessionId);
    assert.deepEqual(await backend.ensureSession({ sessionId: binding.sessionId }), binding);
    await domain.close(); domain = await facility.open(domainSpec);
    restoredBackend = new SelectionBackend(ctx, domain.table('selections'));
    assert.equal(domain.table('selections').get(key)?.sessionId, binding.sessionId);
    assert.deepEqual(await restoredBackend.ensureSession({ sessionId: binding.sessionId }), binding);
  } finally { await restoredBackend?.dispose(); await backend?.dispose(); await facility?.closeAll(); await json.close(); await ctx.fiber.dispose(); }
});
test('read candidates, recommend, human replaces, actual Runtime execution, repeat confirmation returns the same run', { timeout: 20000 }, async () => {
  const ctx = new Context(); const rows = new Map<string, Selection>(), candidates = [item(1), item(2)];
  const store: Store = { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, structuredClone(row)); } };
  await mkdir(resolve('test-results'), { recursive: true }); const workspace = await mkdtemp(resolve('test-results/selection-'));
  let backend: SelectionBackend | undefined, executions = 0;
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    const harness = await mountAgentLoopTestHarness(ctx);
    const agent = await harness.create(SessionId(randomUUID()), {}, { cwd: workspace });
    const user = createUserMessage({ content: [{ type: 'text', text: '请处理这段真实输入' }], source: { kind: 'user' } });
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('user/message', user, { surfaceOp: 'append' });
    ctx.provide('hugegraphRead', { apiVersion: '1.0', read: async (q: any) => {
      const data = q.kind === 'node' ? { kind: 'node', node: candidates.find(c => c.agent.vertexId === q.vertexId)!.agent, relations: [], neighbors: [], page: {} } :
        q.kind === 'versions' ? { kind: 'versions', items: candidates.filter(c => c.agent.properties.agent_id === q.agentId).map(c => c.version), page: {} } :
        { kind: 'candidates', items: candidates, page: { hasMore: false } };
      return { ok: true, data, meta: { complete: true, truncated: false, observedAt: '2026-10-30T00:00:00Z', reasons: [], warnings: [] } };
    } } as never);
    await ctx.plugin(Registry);
    await ctx.plugin(Runtime, { defaultTimeoutMs: 5000 });
    for (const n of [1, 2]) await ctx.plugin({ name: 'selection-business-' + n, inject: ['tools', 'sfRuntime'], apply(scope: Context) { registerRunTool(scope, { toolId: 'selection_example_' + n, description: 'Synthetic main-path fixture', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, execute: async input => { executions++; return { text: String(input.text) + ':' + n }; } }); } });
    backend = new SelectionBackend(ctx, store);
    await backend.read(agent, { action: 'read', query: { kind: 'candidates', detail: 'full' } }, new AbortController().signal);
    await assert.rejects(backend.submit(agent, { versionId: 'not-read', summary: 'x', reasons: [], evidence: [], alternatives: [], unresolved: [] }));
    const receipt = await backend.submit(agent, { versionId: candidates[0].version.vertexId, summary: '选择1', reasons: ['实际能力匹配'], evidence: ['版本说明'], alternatives: ['2也可处理'], unresolved: [] });
    const row = backend.get(receipt.selectionId);
    const plan = await backend.prepare({ selectionId: row.id, revision: row.revision, versionId: candidates[1].version.vertexId });
    assert.equal(executions, 0); assert.deepEqual(plan.issues, []); assert.equal(plan.input.text, '请处理这段真实输入');
    const request = { selectionId: row.id, revision: row.revision, digest: plan.digest };
    const [run, replay] = await Promise.all([backend.confirm(request), backend.confirm(request)]);
    assert.deepEqual(run, replay);
    const worker = ctx.agents.get(SessionId(run.runtimeSessionId))!;
    const get = async (name: string, args: object) => {
      const result = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, agent: worker, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result)); return (result as any).value.data;
    };
    for (let i = 0; i < 20; i++) {
      const current = await get('sf_runtime_get_run', { runId: run.runId });
      if (current.status === 'completed') { assert.equal(current.result.text, '请处理这段真实输入:2'); break; }
      await get('sf_runtime_wait_run', { runId: run.runId, waitMs: 100 });
    }
    assert.equal(executions, 1); assert.equal(backend.get(row.id).selectedVersionId, candidates[1].version.vertexId);
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '新的任务' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const next = await backend.record(agent); assert.notEqual(next.id, row.id);
  } finally { await backend?.dispose(); await ctx.fiber.dispose(); }
});
test('file binding keeps actual attachment instead of substituting instruction text; test versions and non-UI approval fail', async () => {
  const c = item(1); c.version.properties.constraints_json = '{"synthetic_test":true}'; assert.throws(() => runnable(c), /测试版本/);
  assert.deepEqual(initialInput({ toolId: 'x', description: '', supportsRun: true, inputSchema: { properties: { software_intro: { type: 'string' } } } }, { messageId: 'm', text: '请处理附件', files: [{ attachmentId: 'a', name: '需求.docx', bytes: 1 }] }), {});
  const auth = new UiAuthorization(); assert.throws(() => auth.check(undefined, 'invented'), /网页授权/);
  const peer = {} as any;
  const connection = { admit: () => ({ peer }) } as any;
  const response = await auth.bootstrap(new Request('http://dsh.internal/api/sf-orchestration/ui-session', { method: 'POST', headers: { origin: 'http://localhost:9999', host: 'localhost:9999', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }), connection);
  const value = await response.json(); assert.equal(value.ok, true);
  auth.check({ peer } as any, value.data.token);
  assert.throws(() => auth.check({ peer: {} } as any, value.data.token));
  auth.dispose();
});

test('all runnable versions load without a candidate query; parameters gate execution and native model changes are pinned', { timeout: 15000 }, async () => {
  const ctx = new Context(), rows = new Map<string, Selection>(); let backend: SelectionBackend | undefined, executions = 0;
  await mkdir(resolve('test-results'), { recursive: true }); const workspace = await mkdtemp(resolve('test-results/selection-review-'));
  const graph = [item(1), item(2), item(3)];
  class ChoiceModel extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'first', name: 'DeepSeek-V4.1-Flash' }, { provider, id: 'second', name: 'DeepSeek-V4-Pro' }]; }
    async *stream(_request: GenerateOptions) { yield { type: 'text-delta' as const, index: 0, text: '请补充业务目标，我会继续整理参数。' }; yield { type: 'finish' as const, reason: { kind: 'stop' as const } }; }
  }
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); const harness = await mountAgentLoopTestHarness(ctx);
    await ctx.plugin(Registry); installModelSelectionProjection(ctx); await ctx.plugin(Runtime, {});
    ctx.llm.registerAdapter(['choice-fixture'], new ChoiceModel());
    const agent = await harness.create(SessionId(randomUUID()), { provider: 'choice-fixture', model: 'first' }, { cwd: workspace });
    const user = createUserMessage({ content: [{ type: 'text', text: '请处理需求' }], source: { kind: 'user' } });
    agent.session.append('turn/start', { turn: 1 }); agent.session.append('user/message', user, { surfaceOp: 'append' }); agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    ctx.provide('hugegraphRead', { apiVersion: '1.0', read: async (query: any) => ({ ok: true, data: query.kind === 'versions' ? { kind: 'versions', items: graph.filter(c => c.agent.properties.agent_id === query.agentId).map(c => c.version), page: { hasMore: false } } : query.kind === 'node' ? { kind: 'node', node: graph.find(c => c.agent.vertexId === query.vertexId)!.agent } : { kind: 'candidates', items: graph, page: { hasMore: false } }, meta: { complete: true, truncated: false, observedAt: '2026-10-30T00:00:00Z', reasons: [], warnings: [] } }) } as never);
    for (const n of [1, 2]) await ctx.plugin({ name: 'review-business-' + n, inject: ['tools', 'sfRuntime'], apply(scope: Context) { registerRunTool(scope, { toolId: 'selection_example_' + n, description: 'Synthetic review fixture', inputSchema: { type: 'object', properties: { target: { type: 'string', description: '说明要处理的业务目标' } }, required: ['target'] }, execute: async () => { executions++; return { text: 'complete' }; } }); } });
    backend = new SelectionBackend(ctx, { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, structuredClone(row)); } });
    const inspection = await backend.inspect(agent, { versionId: graph[0].version.vertexId });
    assert.ok(inspection.issues.some(x => x.includes('target'))); assert.equal(inspection.modelName, 'DeepSeek-V4.1-Flash');
    await assert.rejects(backend.submit(agent, { summary: '只在文字里说选中了Agent', reasons: [], evidence: [], alternatives: [], unresolved: [] }), /真实 versionId/);
    const receipt = await backend.submit(agent, { versionId: graph[0].version.vertexId, summary: '推荐1', reasons: [], evidence: [], alternatives: [], unresolved: [] });
    const row = await backend.getReview(receipt.selectionId);
    assert.deepEqual(row.candidates.map(c => c.version.vertexId), graph.slice(0, 2).map(c => c.version.vertexId), 'Includes every live entry and excludes the unregistered third entry');
    const blocked = await backend.prepare({ selectionId: row.id, revision: row.revision, versionId: graph[0].version.vertexId });
    await assert.rejects(backend.confirm({ selectionId: row.id, revision: row.revision, digest: blocked.digest }), /target/); assert.equal(executions, 0);
    const idle = new Promise<void>(resolve => { const stop = ctx.on('agent/status', p => { if (p.agent === agent && p.status === 'idle') { stop(); resolve(); } }); });
    const manual = await backend.prepare({ selectionId: row.id, revision: row.revision, versionId: graph[1].version.vertexId, assist: true }); await idle;
    assert.ok(manual.issues.length); assert.equal(sourceOf(agent).messageId, user.id, 'The plugin notice does not replace real task input');
    await assert.rejects(backend.submit(agent, { versionId: graph[0].version.vertexId, summary: '选回1', reasons: [], evidence: [], alternatives: [], unresolved: [] }), /人工已改选/);
    await backend.submit(agent, { versionId: graph[1].version.vertexId, input: { target: '经对话确定的业务目标' }, parameterNotes: ['用户在聊天中说明目标'], summary: '人工选定2，参数已确定', reasons: [], evidence: [], alternatives: [], unresolved: [] });
    const current = backend.get(row.id), ready = await backend.prepare({ selectionId: row.id, revision: current.revision, versionId: graph[1].version.vertexId });
    assert.deepEqual(ready.issues, []); assert.equal(ready.parameterReport?.[0].value, '经对话确定的业务目标');
    const native = new ApiSessionAgentController(ctx), worker = ctx.agents.get(SessionId(ready.runtimeSessionId))!;
    native.selectForNextRequest(worker, { provider: 'choice-fixture', model: 'second' });
    await assert.rejects(backend.confirm({ selectionId: row.id, revision: current.revision, digest: ready.digest }), /模型已变化/);
    const updated = await backend.prepare({ selectionId: row.id, revision: current.revision, versionId: graph[1].version.vertexId });
    assert.equal(updated.model?.model, 'second'); assert.equal(updated.modelName, 'DeepSeek-V4-Pro');
    await backend.confirm({ selectionId: row.id, revision: current.revision, digest: updated.digest });
    assert.equal(backend.get(row.id).executionModelName, 'DeepSeek-V4-Pro');
  } finally { await backend?.dispose(); await ctx.fiber.dispose(); }
});
test('native capabilities, historical uploads, recommendation card and reviewed input use real DSH Tool chains', { timeout: 20000 }, async () => {
  const ctx = new Context(), values = new Map<string, Selection>(), routes = new Map<string, Function>();
  await mkdir(resolve('test-results'), { recursive: true }); const workspace = await mkdtemp(resolve('test-results/selection-plugin-'));
  const bytes = Buffer.from('合成附件正文，不是真实业务材料'), file = { attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), name: '需求.txt', bytes: bytes.length };
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); await mountAgentLoopTestHarness(ctx); await ctx.plugin(Registry); await ctx.plugin(Skills);
    await ctx.plugin(Loader); await ctx.plugin(SubprocessLocal); await ctx.plugin(PwshLocal); await ctx.plugin(ShellEnv, {});
    // The host's standard preset declaration is read and composed unchanged.
    ctx.loader.builtins['fixture-fs'] = FileTools;
    ctx.loader.builtins['fixture-pwsh'] = PwshTool;
    ctx.typert.register(TYPERT as never);
    ctx.provide('storageDomain', { open: async () => ({ table: () => ({ get: (id: string) => values.get(id), entries: () => values.entries(), put: async (id: string, v: Selection) => { values.set(id, structuredClone(v)); } }), close: async () => {} }) } as never);
    ctx.provide('connection', { fetch: { register: ({ path, fetch }: any) => { routes.set(path, fetch); return () => { routes.delete(path); }; } }, admit: () => ({ peer: {} }) } as never);
    ctx.provide('agentPresets', { readDocument: async (id: string) => { assert.equal(id, 'standard'); return { agentPreset: id, content: '- id: native-fs\n  name: cordis:fixture-fs\n- id: native-pwsh\n  name: cordis:fixture-pwsh\n' }; } } as never);
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'never-called' }) } as never);
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) } as never);
    const zip = createZip([{ name: 'word/document.xml', data: Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic native DOCX content</w:t></w:r></w:p></w:body></w:document>') }]);
    await writeFile(join(workspace, 'fixture.docx'), zip);
    const binary = { attachmentId: 'sha256:' + createHash('sha256').update(zip).digest('hex'), name: 'fixture.docx', bytes: zip.length };
    ctx.provide('attachments', { fileHostPath: (file: any) => join(workspace, file.name), async *readFileStream() { yield bytes; } } as never);
    ctx.provide('hugegraphRead', { apiVersion: '1.0', read: async () => ({ ok: true, data: { kind: 'candidates', items: [item(1)], page: { hasMore: false } }, meta: { complete: true, truncated: false, observedAt: '2026-10-30T00:00:00Z', reasons: [], warnings: [] } }) } as never);
    ctx.tools.register({ name: 'hugegraph_read', description: 'Synthetic gateway contract', parameters: { type: 'object', properties: {}, additionalProperties: true }, output: { schema: {}, render: () => [] }, execute: async () => ({ ok: true }) });
    ctx.tools.register({ name: 'sf_runtime_run_tool', description: 'Forbidden model launch fixture', parameters: { type: 'object', properties: {} }, output: { schema: {}, render: () => [] }, execute: async () => { throw new Error('must not run'); } });
    ctx.tools.register({ name: 'sf_runtime_get_tool_contract', description: 'Synthetic Runtime contract lookup', parameters: { type: 'object', properties: { toolId: { type: 'string' } } }, output: { schema: {}, render: () => [] }, execute: async (args: any) => ({ ok: true, data: { toolId: args.toolId, description: 'Fixture', supportsRun: true, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }) });
    await ctx.plugin(Orchestration);
    let service: any;
    await ctx.plugin({ name: 'selection-test-client', inject: ['sfOrchestration'], apply(scope: Context) { service = scope.get('sfOrchestration'); } });
    assert.ok(service, 'The plugin must activate with real Cordis services');
    // Native presets own an ancestor scope, rather than an Agent's own layer.
    const preset = createScope(ctx, {});
    await preset.ctx.plugin({ name: 'selection-preset-fixture', inject: ['sfOrchestration', 'agents', 'agentPresets', 'loader', 'tools', 'systemPrompt', 'skills'], async apply(inner: Context) { await inner.sfOrchestration.compose(inner); } });
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, agentOptions: { provider: 'review-fixture', model: 'synthetic' }, setup: scope => { bindScopeParent(scopeOf(scope)!, scopeOf(preset.ctx)!); } });
    const agent = handle.agent;
    const visible = ['edit', 'hugegraph_read', 'inspect_agent_selection', 'pwsh', 'read', 'read_image', 'sf_runtime_get_tool_contract', 'sf_selection_read_attachment', 'submit_agent_selection', 'write'];
    assert.deepEqual(ctx.tools.schemas(agent).map(t => t.name).sort(), visible);
    const denied = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_runtime_run_tool', arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(denied.isError, true); assert.ok(routes.has('/api/sf-orchestration/ui-session'));
    let step = 0;
    class ReviewModel extends LlmAdapter {
      async listModels(provider: string) { return [{ provider, id: 'synthetic', name: 'Synthetic review model' }]; }
      async *stream(request: GenerateOptions) {
        assert.deepEqual(request.tools?.map(t => t.name).sort(), visible, 'The model wire request must contain the submit tool');
        const call = [
          { name: 'hugegraph_read', args: { action: 'read', query: { kind: 'candidates', detail: 'full' } } },
          { name: 'submit_agent_selection', args: { versionId: item(1).version.vertexId, summary: '合成推荐', reasons: ['能力匹配'], evidence: ['版本描述'], alternatives: [], unresolved: [] } },
        ][step++];
        if (call) {
          yield { type: 'tool-call-delta' as const, index: 0, id: ToolCallId(randomUUID()), name: call.name, argumentsDelta: JSON.stringify(call.args) };
          yield { type: 'finish' as const, reason: { kind: 'tool-calls' as const } };
        } else {
          yield { type: 'text-delta' as const, index: 0, text: '已提交审核卡，等待人工确认' };
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
        }
      }
    }
    ctx.llm.registerAdapter(['review-fixture'], new ReviewModel());
    const idle = new Promise<void>(resolve => { const stop = ctx.on('agent/status', p => { if (p.agent === agent && p.status === 'idle') { stop(); resolve(); } }); });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '请选择处理版本' }, { type: 'file', attachment: file as any }], source: { kind: 'user' } }));
    await idle;
    assert.equal(step, 3, 'The real loop must finish read → submit → final reply');
    let history = { turn: 1, calls: [] as string[], ids: [] as string[] };
    for (const event of agent.session.snapshotEvents()) history = reduceSelection(history, event as any);
    assert.equal(history.ids.length, 1, 'Real Tool receipts must feed the existing WebUI review card');
    assert.equal(values.get(history.ids[0])?.status, 'review');
    assert.equal(values.get(history.ids[0])?.recommendation?.versionId, item(1).version.vertexId);
    // Ordinary blank chats can enter and leave the mode after creation.
    const other = createScope(ctx, {});
    let parent: ReturnType<typeof bindScopeParent>;
    const blank = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, setup: scope => { parent = bindScopeParent(scopeOf(scope)!, scopeOf(other.ctx)!); } });
    parent!.rebind(scopeOf(preset.ctx)!); ctx.emit('agent-preset/selected', blank.agent.id, 'sf-agent-orchestration');
    assert.deepEqual(ctx.tools.schemas(blank.agent).map(t => t.name).sort(), visible);
    parent!.rebind(scopeOf(other.ctx)!); ctx.emit('agent-preset/selected', blank.agent.id, 'standard');
    assert.ok(ctx.tools.schemas(blank.agent).some(t => t.name === 'sf_runtime_run_tool'), 'Leaving the mode removes its restriction');
    // Follow-up turns still reference files genuinely uploaded earlier in this session.
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '文档作为第二个附件' }, { type: 'file', attachment: binary as any }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const followup = createUserMessage({ content: [{ type: 'text', text: '处理之前上传的文件' }], source: { kind: 'user' } });
    agent.session.append('user/message', followup, { surfaceOp: 'append' });
    assert.equal(sourceOf(agent).messageId, followup.id);
    assert.deepEqual(sourceOf(agent).files.map(f => f.name), ['fixture.docx', '需求.txt']);
    const lookup = async (attachmentId: string) => {
      const result = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'sf_selection_read_attachment', arguments: { attachmentId }, agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result)); return (result as any).value;
    };
    const text = await lookup(file.attachmentId); assert.equal(text.data.text, bytes.toString());
    const docx = await lookup(binary.attachmentId); assert.equal(docx.ok, true); assert.equal(docx.data.path, join(workspace, 'fixture.docx'));
    assert.equal((await lookup('sha256:' + 'a'.repeat(64))).error.code, 'FILE_NOT_IN_SESSION');
    // Same path as a standard Windows chat: native PowerShell extracts, native read inspects.
    const extracted = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'pwsh', arguments: {
      description: 'Extract the synthetic DOCX fixture through the native DSH tool',
      command: "$ErrorActionPreference = 'Stop'; $zip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $PWD 'fixture.docx')); try { $reader = [System.IO.StreamReader]::new($zip.GetEntry('word/document.xml').Open()); try { [xml]$xml = $reader.ReadToEnd(); [System.IO.File]::WriteAllText((Join-Path $PWD 'fixture.txt'), $xml.DocumentElement.InnerText) } finally { $reader.Dispose() } } finally { $zip.Dispose() }",
    }, agent, signal: new AbortController().signal });
    assert.equal(extracted.isError, false, JSON.stringify(extracted));
    assert.equal((extracted as any).value.exitCode, 0, JSON.stringify(extracted));
    assert.equal(await readFile(join(workspace, 'fixture.txt'), 'utf8'), 'Synthetic native DOCX content');
    const inspected = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'read', arguments: { file_path: 'fixture.txt' }, agent, signal: new AbortController().signal });
    assert.equal(inspected.isError, false, JSON.stringify(inspected));
    assert.ok(JSON.stringify(inspected).includes('Synthetic native DOCX content'));
    await blank.dispose();
    const workerHandle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, setup: scope => { scope.tools.presentAs('native'); } });
    const worker = workerHandle.agent, taskId = randomUUID(), signal = new AbortController().signal;
    const location = await materialize(ctx, worker, taskId, file, false, signal);
    await assert.rejects(readFile(location), { code: 'ENOENT' });
    worker.ctx.tools.register({ name: 'selection_fixture_prepare', description: 'Test reviewed file preparation', parameters: { type: 'object', properties: {} }, output: { schema: {}, render: () => [] }, execute: async (_args, exec) => materialize(ctx, worker, taskId, file, true, exec.signal) });
    const written = await ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'selection_fixture_prepare', arguments: {}, agent: worker, signal });
    assert.equal(written.isError, false, JSON.stringify(written)); assert.deepEqual(await readFile(location), bytes);
    await workerHandle.dispose(); await handle.dispose();
  } finally { await ctx.fiber.dispose(); }
});
