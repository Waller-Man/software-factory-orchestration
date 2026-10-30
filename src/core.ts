import { createHash } from 'node:crypto';
import type { Candidate, Json, ObjectValue, Source, ToolContract } from './types.ts';
export class SelectionError extends Error { constructor(public code: string, message: string) { super(message); } }
export function ensure(value: unknown, code: string, message: string): asserts value { if (!value) throw new SelectionError(code, message); }
export function failure(error: unknown) { return error instanceof SelectionError ? { code: error.code, message: error.message } : { code: 'UNAVAILABLE', message: error instanceof Error ? error.message : '选择服务暂不可用' }; }
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function runnable(candidate: Candidate): void {
  const p = candidate.version.properties;
  ensure(['enabled', 'able'].includes(String(p.status)), 'VERSION_DISABLED', '当前版本未启用');
  ensure(p.invoke_kind === 'dsh_tool' && typeof p.dsh_ref === 'string' && p.dsh_ref.trim(), 'ENTRY_REQUIRED', '当前版本没有可用的 DSH Tool 入口');
  const raw = JSON.stringify(p);
  ensure(!/synthetic_test|fabricated_fixture|testfake/i.test(raw), 'TEST_VERSION', '测试版本不能真实执行');
  const visit = (v: unknown): boolean => {
    if (typeof v === 'string') { try { return visit(JSON.parse(v)); } catch { return false; } }
    if (Array.isArray(v)) return v.some(visit);
    if (!v || typeof v !== 'object') return false;
    return Object.entries(v).some(([k, x]) => (k === 'real_execution' && x === false) || (['simulation_selection', 'simulation_only'].includes(k) && x === true) || visit(x));
  };
  ensure(!visit(p), 'EXECUTION_PROHIBITED', '当前版本声明禁止真实执行或仅供模拟');
}
export function initialInput(contract: ToolContract, source: Source, supplied: ObjectValue = {}, hasFile = false): ObjectValue {
  const fields = (contract.inputSchema.properties ?? {}) as ObjectValue;
  const input: ObjectValue = {};
  for (const [name, spec] of Object.entries(fields)) {
    if (spec && typeof spec === 'object' && !Array.isArray(spec) && spec.default !== undefined) input[name] = spec.default;
  }
  // Explicit conventions, only when those exact fields exist in the real contract.
  if (!source.files.length && source.text.trim()) {
    if (fields.software_intro) input.software_intro = source.text;
    else if (fields.text) input.text = source.text;
  }
  Object.assign(input, supplied);
  if (hasFile && fields.path) delete input.text;
  return input;
}
export function inputIssues(schema: ObjectValue, input: ObjectValue, hasFile: boolean): string[] {
  const issues: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields = (schema.properties ?? {}) as Record<string, ObjectValue>;
  for (const name of required) if (typeof name === 'string' && (input[name] === undefined || typeof input[name] === 'string' && !String(input[name]).trim()) && !(name === 'path' && hasFile)) issues.push('缺少' + String(fields[name]?.title ?? name) + '：' + String(fields[name]?.description ?? '请在聊天中说明此参数的值'));
  if (fields.path && fields.text && !hasFile && !(typeof input.text === 'string' && input.text.trim()) && !input.path) issues.push('缺少输入材料：请选择已上传文档，或在聊天中提供待处理正文（文件与正文二选一）');
  return issues;
}
