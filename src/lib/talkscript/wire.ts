import {
  finalizeEvent,
  getEventHash,
  nip19,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools";
import { compileScript } from "./compile";
import {
  publishToRelays,
  type IssueWireMode,
  type PublishFn,
  type PublishOutcome,
  type RelayResult,
} from "./issue";
import { decodeSecretKey, personaPubkey } from "./keys";
import type { DraftEvent, TalkScript } from "./types";

export const GROUP_CHAT_KIND = 9;
export const GROUP_JOIN_KIND = 9021;

/** Failure reason recorded for wire events whose persona key is not held. */
export const NO_KEY_REASON = "ペルソナの鍵なし";

export class WireError extends Error {}

/** A wire event plus the persona expected to sign it. */
export interface WireEvent {
  draft: DraftEvent;
  personaId: string;
}

/**
 * A publish-time event set compiled from the script (M4a).
 * Join requests (kind 9021) come first in `events` and are sent before the
 * message events; `joinIds` marks them so `duplicate:` answers count as ok.
 */
export interface WireTalk {
  events: WireEvent[];
  /** Ids of the kind 9021 join events — a prefix of `events`. */
  joinIds: Set<string>;
}

function draftOf(partial: Omit<DraftEvent, "id">): DraftEvent {
  return { ...partial, id: getEventHash(partial as NostrEvent) };
}

/**
 * h-bind: the canonical IR shape (kind 11 + kind 1111) with an `h` tag on
 * every event. The tag is injected at compile time, so children's e/E
 * references point at the new bound root id — a different event set from
 * the canonical IR.
 */
function compileHBound(script: TalkScript, groupId: string): WireTalk {
  const compiled = compileScript(script, { extraTags: [["h", groupId]] });
  return {
    events: script.lines.map((line) => ({
      draft: compiled.byLineId[line.id],
      personaId: line.personaId,
    })),
    joinIds: new Set(),
  };
}

/**
 * nip29-chat: project every line to a kind 9 chat message bound to the
 * group by an `h` tag. Lines replying to an earlier line quote it with a
 * `q` tag and a `nostr:nevent1...` content prefix (NIP-C7). The script
 * title is not emitted. Each persona that speaks first sends a kind 9021
 * join request; joins are deterministic (re-issuing yields the same
 * event, which the relay answers with `duplicate:`).
 */
function compileChat(
  script: TalkScript,
  groupId: string,
  relayHint?: string,
): WireTalk {
  // runs the shared validation + pubkey resolution; the canonical IR
  // itself is unused
  compileScript(script);
  const personas = new Map(script.personas.map((p) => [p.id, p]));
  const pubkeyOf = (personaId: string): string => {
    const pubkey = personaPubkey(personas.get(personaId)!);
    if (!pubkey) throw new WireError(`persona ${personaId} has no pubkey`);
    return pubkey;
  };

  const joins: WireEvent[] = [];
  const messages: WireEvent[] = [];
  const byLineId: Record<string, DraftEvent> = {};
  const seenPersonas = new Set<string>();

  for (const line of script.lines) {
    const pubkey = pubkeyOf(line.personaId);
    const created_at = script.baseTimeSec + line.offsetSec;

    if (!seenPersonas.has(line.personaId)) {
      seenPersonas.add(line.personaId);
      joins.push({
        personaId: line.personaId,
        draft: draftOf({
          kind: GROUP_JOIN_KIND,
          pubkey,
          created_at,
          tags: [["h", groupId]],
          content: "",
        }),
      });
    }

    const parent = line.replyTo ? byLineId[line.replyTo] : undefined;
    const tags = [["h", groupId]];
    let content = line.content;
    if (parent) {
      tags.push(["q", parent.id, relayHint ?? "", parent.pubkey]);
      const nevent = nip19.neventEncode({
        id: parent.id,
        author: parent.pubkey,
        relays: relayHint ? [relayHint] : [],
      });
      content = `nostr:${nevent}\n${line.content}`;
    }
    const draft = draftOf({
      kind: GROUP_CHAT_KIND,
      pubkey,
      created_at,
      tags,
      content,
    });
    byLineId[line.id] = draft;
    messages.push({ draft, personaId: line.personaId });
  }

  return {
    events: [...joins, ...messages],
    joinIds: new Set(joins.map((j) => j.draft.id)),
  };
}

/**
 * Compile the publish-time event set for a wire preset.
 * `relayHint` (the first publish relay) feeds the q tag / embedded nevent.
 */
export function compileWire(
  script: TalkScript,
  mode: IssueWireMode,
  params: Record<string, string>,
  relayHint?: string,
): WireTalk {
  const groupId = params.groupId?.trim();
  if (!groupId) throw new WireError("param groupId is required");
  switch (mode) {
    case "h-bind":
      return compileHBound(script, groupId);
    case "nip29-chat":
      return compileChat(script, groupId, relayHint);
  }
}

/**
 * Sign wire drafts with each persona's held key at issue time.
 * Personas without a decodable key produce NO_KEY_REASON failure rows
 * keyed by the unsigned draft id — honest failures, never silent skips.
 */
export function signWireEvents(
  script: TalkScript,
  events: WireEvent[],
): { signed: NostrEvent[]; failures: Record<string, string> } {
  const secretKeys = new Map<string, Uint8Array>();
  for (const persona of script.personas) {
    if (!persona.key?.trim()) continue;
    try {
      secretKeys.set(persona.id, decodeSecretKey(persona.key));
    } catch {
      // undecodable key: this persona's events fail with NO_KEY_REASON
    }
  }

  const signed: NostrEvent[] = [];
  const failures: Record<string, string> = {};
  for (const { draft, personaId } of events) {
    const secretKey = secretKeys.get(personaId);
    if (!secretKey) {
      failures[draft.id] = NO_KEY_REASON;
      continue;
    }
    const template: EventTemplate = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    };
    const signed_ = finalizeEvent(template, secretKey);
    if (signed_.id !== draft.id)
      throw new WireError(
        `signed id ${signed_.id} does not match draft id ${draft.id}`,
      );
    signed.push(signed_);
  }
  return { signed, failures };
}

/** kind 9021 counts as accepted on `ok` or on a `duplicate:` rejection. */
function joinAccepted(result: RelayResult): boolean {
  return result.ok || (result.message ?? "").startsWith("duplicate:");
}

/**
 * Publish the signed wire events: join requests first (a `duplicate:`
 * answer means the persona is already a member and counts as accepted),
 * then the message events. The outcome covers every signed event.
 */
export async function publishWire(
  wire: WireTalk,
  signed: NostrEvent[],
  relays: string[],
  publish: PublishFn,
): Promise<PublishOutcome> {
  const joinEvents = signed.filter((e) => wire.joinIds.has(e.id));
  const messageEvents = signed.filter((e) => !wire.joinIds.has(e.id));

  const joinOutcome = await publishToRelays(joinEvents, relays, publish);
  for (const perRelay of Object.values(joinOutcome)) {
    for (const [relay, result] of Object.entries(perRelay)) {
      if (joinAccepted(result))
        perRelay[relay] = { ok: true, message: result.message };
    }
  }
  const messageOutcome = await publishToRelays(messageEvents, relays, publish);
  return { ...joinOutcome, ...messageOutcome };
}
