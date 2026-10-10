import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import {
  convertToLlm,
  type SessionEntry,
  type SessionProjection,
} from '@earendil-works/pi-coding-agent';
import { digest, fail, type ClassifiedItem, type Resolution, type Json } from './checkpoint.js';

const BLOCKED_IMAGE_TEXT = 'Image reading is disabled.';

function replaceImages<T extends { type?: unknown; text?: unknown }>(
  content: T[],
  imageType: string,
  placeholder: T,
): T[] {
  if (!content.some((part) => part.type === imageType)) return content;
  return content
    .map((part) => (part.type === imageType ? placeholder : part))
    .filter(
      (part, i, all) =>
        !(
          part.type === placeholder.type &&
          part.text === BLOCKED_IMAGE_TEXT &&
          i > 0 &&
          all[i - 1].type === placeholder.type &&
          all[i - 1].text === BLOCKED_IMAGE_TEXT
        ),
    );
}

/** Match Pi 1.1.0's dynamic SDK conversion policy, including tool results and deduplication. */
export function convertWithImagePolicy(messages: AgentMessage[], blockImages: boolean): Message[] {
  const converted = convertToLlm(messages);
  if (!blockImages) return converted;
  return converted.map((message) => {
    if (
      (message.role !== 'user' && message.role !== 'toolResult') ||
      !Array.isArray(message.content)
    ) {
      return message;
    }
    return {
      ...message,
      content: replaceImages(message.content, 'image', {
        type: 'text',
        text: BLOCKED_IMAGE_TEXT,
      }),
    };
  });
}

/** Filter saved plaintext copies, never the opaque item or the original sealed transcript. */
function windowWithImagePolicy(window: ClassifiedItem[], blockImages: boolean): ClassifiedItem[] {
  const copy = structuredClone(window);
  if (!blockImages) return copy;
  for (const entry of copy) {
    if (entry.item.role !== 'user' || !Array.isArray(entry.item.content)) {
      continue;
    }
    entry.item.content = replaceImages<Json>(entry.item.content, 'input_image', {
      type: 'input_text',
      text: BLOCKED_IMAGE_TEXT,
    });
  }
  return copy;
}

export interface SourceMessage {
  message: AgentMessage;
  sourceId: string;
  actualUser: boolean;
}
export function sourceMessages(projection: SessionProjection): SourceMessage[] {
  return projection.entries.flatMap((e) =>
    e.messages.map((message) => ({
      message,
      sourceId: e.sourceEntry.id,
      actualUser: e.sourceEntry.type === 'message' && e.sourceEntry.message.role === 'user',
    })),
  );
}
export function effectiveSources(
  projection: SessionProjection,
  checkpoint: Resolution,
): SourceMessage[] {
  const sealed = new Set(
    checkpoint.kind === 'valid' ? checkpoint.details.coverage.map((c) => c.id) : [],
  );
  return sourceMessages(projection).filter(
    (s) =>
      s.message.role !== 'system' &&
      (!sealed.has(s.sourceId) ||
        (checkpoint.kind === 'valid' && s.sourceId === checkpoint.entry.id)),
  );
}
/**
 * Remove covered Pi contributions before normal preparation without changing system/tool deltas.
 * Canonical occurrences must remain an ordered prefix; only appended transient messages are supported.
 * Content sets would incorrectly remove legitimate repeated users.
 */
export function filterContext(
  messages: AgentMessage[],
  projection: SessionProjection,
  checkpoint: Resolution,
): AgentMessage[] {
  if (checkpoint.kind !== 'valid') return messages;
  const sources = sourceMessages(projection).filter((s) => s.message.role !== 'system');
  const received = messages.filter((m) => m.role !== 'system');
  if (
    received.length < sources.length ||
    sources.some((s, i) => digest(s.message) !== digest(received[i]))
  ) {
    fail(
      'Context no longer matches canonical source provenance; other history transforms are unsupported.',
    );
  }
  const sealed = new Set(checkpoint.details.coverage.map((c) => c.id));
  let i = 0;
  return messages.filter((m) => {
    if (m.role === 'system') return true;
    const source = sources[i++];
    return !source || source.sourceId === checkpoint.entry.id || !sealed.has(source.sourceId);
  });
}
/** Validate the adapter's ordered user occurrences against Pi source entries before retention. */
export function classifyWire(
  input: Json[],
  sources: SourceMessage[],
  blockImages = false,
): ClassifiedItem[] {
  const users = sources.flatMap((s) =>
    convertWithImagePolicy([s.message], blockImages)
      .filter((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
      .filter((m) => typeof m.content === 'string' || m.content.length > 0)
      .map((m) => ({ source: s, message: m })),
  );
  let userIndex = 0;
  const classified = input.map((item) => {
    if (item.role !== 'user') {
      return {
        item,
        sourceKind: 'history' as const,
        sourceIds: [],
      };
    }
    const user = users[userIndex++];
    if (!user) fail('Codex serializer user/source correspondence failed.');
    // The pinned serializer emits exactly one wire user per nonempty LLM user, in order.
    // Check text and images too, to detect alternate provider serializers or transformations.
    const expected =
      typeof user.message.content === 'string'
        ? [{ type: 'text' as const, text: user.message.content }]
        : user.message.content;
    const content = item.content;
    if (
      !Array.isArray(content) ||
      content.length !== expected.length ||
      expected.some((part, i) => {
        const wire = content[i] as Json;
        return part.type === 'text'
          ? wire.type !== 'input_text' || wire.text !== sanitize(part.text)
          : wire.type !== 'input_image' ||
              wire.image_url !== `data:${part.mimeType};base64,${part.data}`;
      })
    ) {
      fail('Codex serializer changed user content/source correspondence.');
    }
    return {
      item,
      sourceKind: user.source.actualUser ? ('user' as const) : ('history' as const),
      sourceIds: [user.source.sourceId],
    };
  });
  if (userIndex !== users.length) {
    fail('Codex serializer omitted a projected user contribution.');
  }
  return classified;
}
function sanitize(text: string): string {
  // Match Pi's wire sanitization of unpaired UTF-16 surrogates without changing valid Unicode.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}
export function anchorText(summary: string): string {
  const converted = convertToLlm([
    { role: 'compactionSummary', summary, tokensBefore: 0, timestamp: 0 },
  ]);
  const user = converted[0];
  if (
    user.role !== 'user' ||
    typeof user.content === 'string' ||
    user.content[0]?.type !== 'text'
  ) {
    fail('Pi compaction anchor conversion changed.');
  }
  return user.content[0].text;
}
function findAnchorIndex(input: Json[], anchor: string): number {
  const text = anchorText(anchor);
  const matches = input.flatMap((item, i) =>
    item.role === 'user' &&
    (item.content === text ||
      (Array.isArray(item.content) &&
        item.content.length === 1 &&
        item.content[0].type === 'input_text' &&
        item.content[0].text === text))
      ? [i]
      : [],
  );
  if (matches.length !== 1) {
    fail('Exact encrypted checkpoint anchor is missing or duplicated.');
  }
  return matches[0];
}
/** Expand one exact display anchor at the wire seam; ambiguous/missing anchors fail closed. */
export function replaceAnchor(input: Json[], checkpoint: Resolution, blockImages = false): Json[] {
  if (checkpoint.kind !== 'valid') return input;
  const index = findAnchorIndex(input, checkpoint.details.anchor);
  return [
    ...input.slice(0, index),
    ...windowWithImagePolicy(checkpoint.details.window, blockImages).map((w) => w.item),
    ...input.slice(index + 1),
  ];
}
/** Recursive input inherits saved classifications, not classifications guessed from wire roles. */
export function expandClassified(
  input: ClassifiedItem[],
  checkpoint: Resolution,
  blockImages = false,
): ClassifiedItem[] {
  if (checkpoint.kind !== 'valid') return input;
  const index = findAnchorIndex(
    input.map((c) => c.item),
    checkpoint.details.anchor,
  );
  // Wire identity and Pi provenance must name the same occurrence. Check before
  // expanding so the saved window is cloned/filtered once, without hashing image payloads.
  const sourceIndex = input.findIndex((c) => c.sourceIds.includes(checkpoint.entry.id));
  if (sourceIndex < 0) fail('Checkpoint anchor lacks source provenance.');
  if (sourceIndex !== index) fail('Checkpoint anchor/provenance mismatch.');
  return [
    ...input.slice(0, index),
    ...windowWithImagePolicy(checkpoint.details.window, blockImages),
    ...input.slice(index + 1),
  ];
}
export function snapshot(
  branch: SessionEntry[],
  instructions: string,
  reasoning: string,
  tools: unknown,
  blockImages = false,
): string {
  return digest({ branch, instructions, reasoning, tools, blockImages });
}
