import { getEventHash, type NostrEvent } from "nostr-tools";
import {
  createCommentTagsFromCommentPointer,
  type CommentEventPointer,
} from "applesauce-common/helpers/comment";
import { personaPubkey } from "./keys";
import {
  TALK_SCRIPT_VERSION,
  type CompiledTalk,
  type DraftEvent,
  type ScriptLine,
  type TalkScript,
} from "./types";

export const THREAD_KIND = 11;
export const COMMENT_KIND = 1111;

export class CompileError extends Error {}

function toCommentPointer(
  event: Pick<NostrEvent, "id" | "kind" | "pubkey">,
): CommentEventPointer {
  return {
    type: "event",
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
  };
}

function draft(partial: Omit<DraftEvent, "id">): DraftEvent {
  return { ...partial, id: getEventHash(partial as NostrEvent) };
}

function assertValid(script: TalkScript): Map<string, string> {
  if (script.version !== TALK_SCRIPT_VERSION)
    throw new CompileError(`unsupported script version ${script.version}`);
  if (script.lines.length === 0) throw new CompileError("script has no lines");

  const pubkeys = new Map<string, string>();
  for (const persona of script.personas) {
    const pk = personaPubkey(persona);
    if (!pk)
      throw new CompileError(
        `persona "${persona.name}" has no usable key or pubkey`,
      );
    pubkeys.set(persona.id, pk);
  }

  const earlier = new Set<string>();
  for (const line of script.lines) {
    if (!pubkeys.has(line.personaId))
      throw new CompileError(`line ${line.id} references unknown persona`);
    // parents must precede children in document order (the editor can only
    // create earlier-line refs, but reordering can break this)
    if (line.replyTo && !earlier.has(line.replyTo))
      throw new CompileError(
        `line ${line.id} replies to a later or unknown line`,
      );
    earlier.add(line.id);
  }
  return pubkeys;
}

/**
 * Deterministically compile a script into the IR event set:
 * lines[0] -> kind 11 root, the rest -> kind 1111 comments carrying
 * NIP-22 K/E/P (root scope) + k/e/p (parent item) tags.
 * Unsigned: ids are content hashes, so children can link before signing.
 */
export function compileScript(script: TalkScript): CompiledTalk {
  const pubkeys = assertValid(script);

  const byLineId: Record<string, DraftEvent> = {};
  const events: DraftEvent[] = [];

  const buildLine = (line: ScriptLine, index: number): DraftEvent => {
    const pubkey = pubkeys.get(line.personaId);
    if (!pubkey)
      throw new CompileError(
        `line ${line.id} has a persona with no usable pubkey`,
      );
    const created_at = script.baseTimeSec + line.offsetSec;

    if (index === 0) {
      return draft({
        kind: THREAD_KIND,
        pubkey,
        created_at,
        // NIP-7D asks for `title` (SHOULD); `subject` stays for clients
        // that read the legacy tag
        tags: [
          ["subject", script.title],
          ["title", script.title],
        ],
        content: line.content,
      });
    }

    const root = events[0];
    const parentEvent =
      line.replyTo && byLineId[line.replyTo] ? byLineId[line.replyTo] : root;

    const tags = [
      ...createCommentTagsFromCommentPointer(toCommentPointer(root), true),
      ...createCommentTagsFromCommentPointer(
        toCommentPointer(parentEvent),
        false,
      ),
    ];

    return draft({
      kind: COMMENT_KIND,
      pubkey,
      created_at,
      tags,
      content: line.content,
    });
  };

  script.lines.forEach((line, index) => {
    const event = buildLine(line, index);
    byLineId[line.id] = event;
    events.push(event);
  });

  return { byLineId, events };
}
