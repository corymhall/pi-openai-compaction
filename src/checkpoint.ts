import { createHash, randomUUID } from 'node:crypto';
import type {
  CompactionEntry,
  SessionEntry,
  SessionProjection,
} from '@earendil-works/pi-coding-agent';

export type Json = Record<string, unknown>;
export const TYPE = 'pi-openai-compaction-v2';
export const WARNING =
  '[pi-openai-compaction: encrypted history requires this extension; not a portable summary]';
export class CompactionError extends Error {}
export function fail(message: string): never {
  throw new CompactionError(message);
}
export function record(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export interface Identity {
  provider: string;
  api: string;
  model: string;
  endpoint: string;
  account: string;
}
/**
 * Wire data plus Pi provenance. A wire-user role alone does not make an actual user.
 * Saved copies are authoritative even after truncation or image filtering: source IDs
 * establish provenance, never permission to rehydrate content from sealed raw history.
 */
export interface ClassifiedItem {
  item: Json;
  sourceKind: 'user' | 'history' | 'checkpoint';
  sourceIds: string[];
}
export interface Coverage {
  id: string;
  hash: string;
}
/**
 * Branch-local replay state, not a portable textual summary.
 * `coverage` seals represented original entries (including prior checkpoints and edits).
 * `window` is chronological retained user copies followed by exactly one opaque item.
 * Forks may reuse this evidence; session IDs deliberately are not identity constraints.
 */
export interface Checkpoint {
  type: typeof TYPE;
  version: 1;
  anchor: string;
  identity: Identity;
  coveredThrough: string;
  coverage: Coverage[];
  window: ClassifiedItem[];
  responseId: string;
}
export type Resolution =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; entry: CompactionEntry; details: Checkpoint };
export function newAnchor(): string {
  return `${WARNING}\nCheckpoint ${randomUUID()}`;
}
function identityValid(value: unknown): value is Identity {
  return (
    record(value) &&
    ['provider', 'api', 'model', 'endpoint', 'account'].every(
      (k) => typeof value[k] === 'string' && Boolean(value[k]),
    )
  );
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}
export function ownsCheckpoint(entry: CompactionEntry): boolean {
  const d = entry.details;
  return (
    (record(d) &&
      ((typeof d.type === 'string' && d.type.startsWith('pi-openai-compaction')) ||
        d.type === 'openai-native-compaction')) ||
    (typeof entry.summary === 'string' &&
      (entry.summary.startsWith(WARNING) || entry.summary === 'NATIVE_COMPACTION_MARKER'))
  );
}
/** Resolve only the latest compaction: a newer ordinary summary supersedes old opaque state. */
export function resolveCheckpoint(branch: SessionEntry[]): Resolution {
  const entry = branch.filter((e): e is CompactionEntry => e.type === 'compaction').at(-1);
  if (!entry) return { kind: 'absent' };
  const d = entry.details;
  if (!ownsCheckpoint(entry)) return { kind: 'absent' };
  const invalid = (reason: string): Resolution => ({ kind: 'invalid', reason });
  if (!record(d) || d.type !== TYPE || d.version !== 1) {
    return invalid(
      'Unsupported checkpoint/prototype version. Navigate before it or start a new session.',
    );
  }
  if (
    typeof d.anchor !== 'string' ||
    !d.anchor.startsWith(WARNING) ||
    d.anchor !== entry.summary ||
    typeof d.coveredThrough !== 'string' ||
    typeof d.responseId !== 'string' ||
    !d.responseId ||
    !identityValid(d.identity) ||
    !Array.isArray(d.coverage) ||
    !d.coverage.length ||
    !Array.isArray(d.window) ||
    !d.window.length
  ) {
    return invalid('Malformed encrypted checkpoint.');
  }
  if (
    !d.coverage.every((c) => record(c) && typeof c.id === 'string' && typeof c.hash === 'string') ||
    !d.window.every(
      (w) =>
        record(w) &&
        record(w.item) &&
        strings(w.sourceIds) &&
        ['user', 'checkpoint'].includes(String(w.sourceKind)),
    )
  ) {
    return invalid('Malformed checkpoint provenance.');
  }
  const details = d as unknown as Checkpoint;
  if (new Set(details.coverage.map((c) => c.id)).size !== details.coverage.length) {
    return invalid('Duplicate checkpoint coverage.');
  }
  const encrypted = details.window.filter((w) => w.sourceKind === 'checkpoint');
  if (
    encrypted.length !== 1 ||
    details.window.at(-1) !== encrypted[0] ||
    encrypted[0].item.type !== 'compaction' ||
    typeof encrypted[0].item.encrypted_content !== 'string' ||
    !encrypted[0].item.encrypted_content.trim() ||
    details.window.some(
      (w) => w.sourceKind === 'user' && (w.item.role !== 'user' || w.item.type === 'compaction'),
    )
  ) {
    return invalid('Invalid replacement window.');
  }
  const index = branch.findIndex((e) => e.id === entry.id);
  const through = branch.findIndex((e) => e.id === details.coveredThrough);
  if (through < 0 || through >= index) {
    return invalid('Checkpoint coverage boundary is missing.');
  }
  const sealed = new Set(details.coverage.map((c) => c.id));
  for (const c of details.coverage) {
    const sourceIndex = branch.findIndex((e) => e.id === c.id);
    if (sourceIndex < 0 || sourceIndex > through || digest(branch[sourceIndex]) !== c.hash) {
      return invalid(
        'Sealed history changed or is missing. Navigate before the checkpoint or start a new session.',
      );
    }
  }
  if (details.window.some((w) => w.sourceIds.some((id) => !sealed.has(id)))) {
    return invalid('Retained source is outside sealed coverage.');
  }
  if (
    details.window.some(
      (w) =>
        w.sourceKind === 'user' &&
        (w.sourceIds.length !== 1 ||
          !w.sourceIds.every((id) => {
            const source = branch.find((e) => e.id === id);
            return source?.type === 'message' && source.message.role === 'user';
          }) ||
          !Array.isArray(w.item.content) ||
          !w.item.content.every(
            (p) =>
              record(p) &&
              ((p.type === 'input_text' && typeof p.text === 'string') ||
                (p.type === 'input_image' && typeof p.image_url === 'string')),
          )),
    )
  ) {
    return invalid('Retained user classification/content is invalid.');
  }
  if (branch.slice(index + 1).some((e) => e.type === 'context_edit' && sealed.has(e.targetId))) {
    return invalid(
      'An edit targets sealed history. Navigate before the checkpoint or start a new session.',
    );
  }
  return { kind: 'valid', entry, details };
}
export function requireCheckpoint(
  branch: SessionEntry[],
): Exclude<Resolution, { kind: 'invalid' }> {
  const resolved = resolveCheckpoint(branch);
  if (resolved.kind === 'invalid') fail(resolved.reason);
  return resolved;
}
export function assertIdentity(actual: Identity, expected: Identity): void {
  if (
    actual.provider !== expected.provider ||
    actual.api !== expected.api ||
    actual.model !== expected.model ||
    actual.endpoint !== expected.endpoint ||
    actual.account !== expected.account
  ) {
    fail(
      'Checkpoint requires its producing model, account and endpoint. Navigate before it or start a new session.',
    );
  }
}
/** Carry prior seals forward even when their users no longer fit the retention window. */
export function coverageFor(
  branch: SessionEntry[],
  projection: SessionProjection,
  previous: Resolution,
): Coverage[] {
  const ids = new Set(previous.kind === 'valid' ? previous.details.coverage.map((c) => c.id) : []);
  for (const e of projection.entries) {
    if (
      e.messages.length ||
      ['message', 'custom_message', 'branch_summary', 'compaction'].includes(e.sourceEntry.type)
    ) {
      ids.add(e.sourceEntry.id);
    }
  }
  // Preserve edits that defined the sealed effective contributions, including omissions.
  for (const e of branch) {
    if (e.type === 'context_edit' && ids.has(e.targetId)) ids.add(e.id);
  }
  return branch.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, hash: digest(e) }));
}
