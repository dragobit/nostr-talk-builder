import {
  finalizeEvent,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools";
import { decodeSecretKey } from "./keys";
import type { CompiledTalk, TalkScript } from "./types";

export interface SignResult {
  /** Signed events in script order, root first. */
  events: NostrEvent[];
  /** Line ids that could not be signed (persona has no held key). */
  skippedLineIds: string[];
}

/**
 * Sign every draft whose persona holds a secret key in the script.
 * Unsigned drafts keep their ids — editing a line after signing changes its
 * id, which is exactly what invalidates the old signature.
 */
export function signTalk(
  script: TalkScript,
  compiled: CompiledTalk,
): SignResult {
  const secretKeys = new Map<string, Uint8Array>();
  for (const persona of script.personas) {
    if (!persona.key?.trim()) continue;
    try {
      secretKeys.set(persona.id, decodeSecretKey(persona.key));
    } catch {
      // unusable key: persona's lines are skipped
    }
  }

  const events: NostrEvent[] = [];
  const skippedLineIds: string[] = [];

  for (const line of script.lines) {
    const draft = compiled.byLineId[line.id];
    const secretKey = secretKeys.get(line.personaId);
    if (!draft) continue;
    if (!secretKey) {
      skippedLineIds.push(line.id);
      continue;
    }
    const template: EventTemplate = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    };
    const signed = finalizeEvent(template, secretKey);
    if (signed.id !== draft.id)
      throw new Error(
        `signed id ${signed.id} does not match draft id ${draft.id}`,
      );
    events.push(signed);
  }

  return { events, skippedLineIds };
}
