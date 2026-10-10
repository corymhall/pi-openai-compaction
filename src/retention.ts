import { fail, record, type ClassifiedItem, type Json } from './checkpoint.js';

// Adapted from Codex c0c230e: compact_remote_v2{,_images}.rs and utils/string/truncate.rs
// (Apache-2.0). Estimates, not exact backend tokens. Pi serializes images at detail:auto.
export const USER_BUDGET = 64_000;
export function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
export function middleTruncate(text: string, tokens: number): string {
  const budget = tokens * 4;
  const bytes = Buffer.byteLength(text);
  if (bytes <= budget) return text;
  const leftBudget = Math.ceil(budget / 2),
    rightBudget = Math.floor(budget / 2);
  const chars = Array.from(text);
  let left = '',
    right = '',
    used = 0;
  for (const char of chars) {
    const size = Buffer.byteLength(char);
    if (used + size > leftBudget) break;
    left += char;
    used += size;
  }
  used = 0;
  for (const char of chars.slice().reverse()) {
    const size = Buffer.byteLength(char);
    if (used + size > rightBudget) break;
    right = char + right;
    used += size;
  }
  return `${left}…${Math.ceil((bytes - budget) / 4)} tokens truncated…${right}`;
}
function partTokens(part: Json): number {
  if (part.type === 'input_image') return Math.ceil(7373 / 4);
  return typeof part.text === 'string' ? textTokens(part.text) : 0;
}
function openLabel(part: Json): boolean {
  return (
    part.type === 'input_text' &&
    typeof part.text === 'string' &&
    (part.text === '<image>' || (part.text.startsWith('<image name=') && part.text.endsWith('>')))
  );
}
function closeLabel(part: Json): boolean {
  return part.type === 'input_text' && part.text === '</image>';
}
/** Newest-first selection, chronological replay; clip at one boundary and never backfill older users. */
export function retainUsers(items: ClassifiedItem[], budget = USER_BUDGET): ClassifiedItem[] {
  let remaining = budget;
  const retained: ClassifiedItem[] = [];
  for (const source of items
    .filter((c) => c.sourceKind === 'user')
    .slice()
    .reverse()) {
    if (remaining === 0) break;
    if (!Array.isArray(source.item.content) || !source.item.content.every(record)) {
      fail('Unsupported retained user wire content.');
    }
    const parts = source.item.content as Json[];
    const charge = Math.max(
      1,
      parts.reduce((n, p) => n + partTokens(p), 0),
    );
    if (charge <= remaining) {
      retained.push(structuredClone(source));
      remaining -= charge;
      continue;
    }
    const hasImages = parts.some((p) => p.type === 'input_image');
    const result: Json[] = [];
    const pending = structuredClone(parts);
    if (hasImages) {
      while (pending.length) {
        const last = pending.length - 1;
        const imageIndex =
          pending[last].type === 'input_image'
            ? last
            : closeLabel(pending[last]) && last > 0 && pending[last - 1].type === 'input_image'
              ? last - 1
              : -1;
        if (imageIndex >= 0) {
          const start =
            imageIndex > 0 && openLabel(pending[imageIndex - 1]) ? imageIndex - 1 : imageIndex;
          const group = pending.splice(start);
          const count = group.reduce((n, p) => n + partTokens(p), 0);
          if (count <= remaining) {
            remaining -= count;
            result.unshift(...group);
          } else {
            remaining = 0;
          }
        } else {
          const part = pending.pop()!;
          if (remaining > 0 && typeof part.text === 'string') {
            const count = partTokens(part);
            if (count > remaining) {
              part.text = middleTruncate(part.text, remaining);
              remaining = 0;
            } else {
              remaining -= count;
            }
            if (part.text) result.unshift(part);
          }
        }
      }
    } else {
      for (const part of pending) {
        if (!remaining || typeof part.text !== 'string') continue;
        const count = partTokens(part);
        if (count > remaining) {
          part.text = middleTruncate(part.text, remaining);
          remaining = 0;
        } else {
          remaining -= count;
        }
        if (part.text) result.push(part);
      }
    }
    if (result.length) {
      const copy = structuredClone(source);
      copy.item.content = result;
      retained.push(copy);
    }
    // Never backfill an oversized boundary image with older messages.
    remaining = 0;
  }
  return retained.reverse();
}
function estimatedTokens(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((n, v) => n + estimatedTokens(v), 0);
  }
  if (record(value)) {
    if (value.type === 'input_image') return Math.ceil(7373 / 4);
    if (value.type === 'compaction') return 0; // the entire checkpoint is opaque, including extra fields
    // Tool declarations include model-visible schema keys and JSON structure.
    // Ciphertext is opaque; exclude its bytes from the heuristic rather than claiming its size.
    return Object.entries(value).reduce(
      (n, [key, v]) =>
        n +
        (key === 'encrypted_content'
          ? 0
          : key === 'tools'
            ? textTokens(JSON.stringify(v))
            : estimatedTokens(v)),
      0,
    );
  }
  return typeof value === 'string' ? textTokens(value) : 1;
}
function containsEncrypted(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEncrypted);
  return (
    record(value) &&
    (Object.hasOwn(value, 'encrypted_content') || Object.values(value).some(containsEncrypted))
  );
}
/** Fit only the eligible output suffix on a copy; unknown opaque size is bounded by wire bytes. */
export function fitRequest(
  body: Json,
  input: ClassifiedItem[],
  contextWindow: number,
  maxBytes = 20 * 1024 * 1024,
): ClassifiedItem[] {
  const result = structuredClone(input);
  const size = () => estimatedTokens({ ...body, input: result.map((c) => c.item) });
  // Codex rewrites only the eligible suffix and stops at the first non-output boundary.
  for (let i = result.length - 1; size() > contextWindow && i >= 0; i--) {
    const item = result[i].item;
    if (
      !['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(
        String(item.type),
      ) ||
      containsEncrypted(item)
    ) {
      break;
    }
    if (item.type === 'tool_search_output') {
      item.tools = [];
    } else {
      item.output = 'Output exceeded the available model context and was truncated';
    }
  }
  if (size() > contextWindow) {
    fail(
      'Compaction input exceeds the estimated model budget; user input and checkpoints will not be truncated.',
    );
  }
  // Independent conservative local wire-byte guard, not a verified backend limit.
  if (Buffer.byteLength(JSON.stringify({ ...body, input: result.map((c) => c.item) })) > maxBytes) {
    fail('Compaction input exceeds the local wire-byte safety limit.');
  }
  return result;
}
