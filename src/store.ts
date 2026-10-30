import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { Selection } from './types.ts';
import { digest } from './core.ts';
/** Storage keys must be path-safe; keep the actual DSH session ID unchanged. */
export const sessionRecordKey = (sessionId: string): string => 'session_' + digest(sessionId);
export const domainSpec = defineDomain({ name: 'software_factory_orchestration', version: 1, layout: 'per-record', tables: {
  selections: domainTable(z.custom<Selection>(v => !!v && typeof v === 'object' && typeof (v as Selection).id === 'string' && Array.isArray((v as Selection).candidates), 'Invalid selection')),
} });
export interface Store { get(id: string): Selection | undefined; entries(): IterableIterator<[string, Selection]>; put(id: string, row: Selection): Promise<void> }
