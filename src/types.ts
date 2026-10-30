/** Module-owned JSON DTOs; no changes to the existing shared contracts. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export interface Vertex { vertexId: string; label: string; properties: ObjectValue }
export interface Candidate { agent: Vertex; version: Vertex }
export interface SourceFile { attachmentId: string; name: string; bytes: number }
export interface Source { messageId: string; text: string; files: SourceFile[] }
export interface Recommendation { versionId?: string; summary: string; reasons: string[]; evidence: string[]; alternatives: string[]; unresolved: string[]; input?: ObjectValue; fileId?: string; parameterNotes?: string[] }
export interface Selection {
  workspace?: string;
  id: string; sessionId: string; revision: number; source: Source;
  candidates: Candidate[]; observedAt?: string; complete: boolean; warnings: string[];
  recommendation?: Recommendation; status: 'analyzing' | 'review' | 'starting' | 'started' | 'uncertain';
  plan: { schemaVersion: 1; nodes: Array<{ versionId: string }>; edges: string[] };
  runtimeSessionId?: string; runId?: string; selectedVersionId?: string; approvedDigest?: string;
  manualVersionId?: string; executionModelName?: string;
  parameterDrafts?: Record<string, { input: ObjectValue; fileId?: string; notes?: string[] }>;
}
export interface ToolContract { toolId: string; description: string; inputSchema: ObjectValue; supportsRun: boolean }
export interface PrepareRequest { selectionId: string; revision: number; versionId: string; input?: ObjectValue; fileId?: string; assist?: boolean }
export interface ConfirmRequest { selectionId: string; revision: number; digest: string }
export interface ReviewPlan {
  selectionId: string; revision: number; versionId: string; digest: string;
  contract: ToolContract; input: ObjectValue; file?: SourceFile;
  runtimeSessionId: string; model?: { provider: string; model: string; reasoningEffort?: string }; modelName?: string; issues: string[];
  parameterReport?: Array<{ name: string; value: Json; basis: string }>;
}
export interface SelectionRequest { selectionId: string }
export interface SessionRequest { sessionId?: string; sourceSessionId?: string; workspaceId?: string }
export interface SessionBinding { sessionId: string; workspace: string }
export interface RunBinding { runId: string; runtimeSessionId: string }
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
