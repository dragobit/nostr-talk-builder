import { getEventHash, nip19, type Filter, type NostrEvent } from "nostr-tools";
import { COMMENT_KIND, THREAD_KIND } from "./compile";
import { dedupeRelays, isValidRelayUrl, loadPublishRelays } from "./issue";
import { newId } from "./sample";
import {
  TALK_SCRIPT_VERSION,
  type Persona,
  type ScriptLine,
  type TalkScript,
} from "./types";

export class ImportError extends Error {}

/**
 * One-shot event fetch — same call shape as binding
 * `pool.request(relays, filters).pipe(toArray())`. Injected so the importer
 * stays pure and testable.
 */
export type FetchEvents = (
  relays: string[],
  filters: Filter[],
) => Promise<NostrEvent[]>;

interface DecodedIdentifier {
  /** Relay filter that selects the kind 11 root event. */
  rootFilter: Filter;
  /** Query target: nevent/naddr relay hints, else the publish relay list. */
  relays: string[];
}

/** NIP-19 identifier -> root filter + relays. Throws ImportError. */
export function decodeIdentifier(input: string): DecodedIdentifier {
  const trimmed = input.trim();
  if (!trimmed)
    throw new ImportError("nevent / note / naddr を入力してください");

  let decoded: nip19.DecodedResult;
  try {
    decoded = nip19.decode(trimmed);
  } catch (error) {
    throw new ImportError(
      `NIP-19 識別子を読み取れませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  switch (decoded.type) {
    case "nevent": {
      const { id, relays } = decoded.data;
      return {
        rootFilter: { ids: [id], kinds: [THREAD_KIND] },
        relays: resolveRelays(relays),
      };
    }
    case "note": {
      return {
        rootFilter: { ids: [decoded.data], kinds: [THREAD_KIND] },
        relays: resolveRelays([]),
      };
    }
    case "naddr": {
      const { kind, pubkey, identifier, relays } = decoded.data;
      return {
        rootFilter: {
          kinds: [kind],
          authors: [pubkey],
          "#d": [identifier],
        },
        relays: resolveRelays(relays),
      };
    }
    default:
      throw new ImportError(
        `対応していない識別子タイプです: ${decoded.type}（nevent / note / naddr のみ）`,
      );
  }
}

/** Relay hints canonicalized; falls back to the publish relay list. */
function resolveRelays(hints: string[] | undefined): string[] {
  const relays = dedupeRelays((hints ?? []).filter(isValidRelayUrl));
  return relays.length > 0 ? relays : loadPublishRelays();
}

export interface ImportResult {
  script: TalkScript;
  /** Non-fatal deviations applied while rebuilding the script. */
  warnings: string[];
  /** Relays the thread was fetched from (hints or publish defaults). */
  relays: string[];
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function dedupeById(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/** Drop events whose id does not match their content hash. */
function validOnly(events: NostrEvent[]): NostrEvent[] {
  return events.filter((e) => {
    try {
      return e.id === getEventHash(e);
    } catch {
      return false;
    }
  });
}

function shortNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey).slice(0, 12);
  } catch {
    return pubkey.slice(0, 12);
  }
}

/**
 * Rebuild a TalkScript skeleton from an already-fetched event set:
 * a kind 11 root plus its kind 1111 descendants (NIP-22 uppercase E tag
 * pointing at the root). Pure — see importFromIdentifier for fetching.
 */
export function buildScript(
  root: NostrEvent,
  comments: NostrEvent[],
): { script: TalkScript; warnings: string[] } {
  const warnings: string[] = [];

  // Only true descendants of this thread: the NIP-22 root-scope E tag
  // must reference the root (a comment whose e-tag points into our set
  // but whose E-tag names another root belongs to a different thread).
  const descendants = comments.filter((e) =>
    e.tags.some((t) => t[0] === "E" && t[1] === root.id),
  );

  // Deterministic line order: created_at asc, event id tiebreak.
  const sorted = [...descendants].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  const ordered = [root, ...sorted];

  // Personas in order of first appearance (root author first).
  const personas: Persona[] = [];
  const personaByPubkey = new Map<string, string>();
  for (const event of ordered) {
    if (!personaByPubkey.has(event.pubkey)) {
      const id = `persona-${personas.length + 1}`;
      personas.push({
        id,
        name: shortNpub(event.pubkey),
        pubkey: event.pubkey,
      });
      personaByPubkey.set(event.pubkey, id);
    }
  }

  const lineIdByEventId = new Map<string, string>();
  for (const event of ordered) lineIdByEventId.set(event.id, newId());
  const indexByEventId = new Map<string, number>();
  ordered.forEach((event, index) => indexByEventId.set(event.id, index));

  const lines: ScriptLine[] = ordered.map((event, index) => {
    const offsetSec = event.created_at - root.created_at;
    if (offsetSec < 0)
      warnings.push(
        `イベント ${event.id.slice(0, 8)}… の作成時刻がルートより前のため 0 に丸めました`,
      );

    let replyTo: string | undefined;
    if (index > 0) {
      const parentId = tagValue(event, "e");
      if (!parentId) {
        warnings.push(
          `イベント ${event.id.slice(0, 8)}… に親参照 (e タグ) が無いためルート直下に付け替えました`,
        );
      } else if (parentId === root.id) {
        // direct reply to the root: ScriptLine.replyTo stays unset
      } else {
        const parentIndex = indexByEventId.get(parentId);
        const target = lineIdByEventId.get(parentId);
        if (parentIndex === undefined || !target) {
          warnings.push(
            `イベント ${event.id.slice(0, 8)}… の親 ${parentId.slice(0, 8)}… が収集セットに無いためルート直下に付け替えました`,
          );
        } else if (parentIndex >= index) {
          // parent must precede child (compile invariant): a child
          // timestamped earlier than its parent would break ordering
          warnings.push(
            `イベント ${event.id.slice(0, 8)}… の作成時刻が親より前のためルート直下に付け替えました`,
          );
        } else {
          replyTo = target;
        }
      }
    }

    return {
      id: lineIdByEventId.get(event.id)!,
      personaId: personaByPubkey.get(event.pubkey)!,
      content: event.content,
      offsetSec: Math.max(0, offsetSec),
      ...(replyTo ? { replyTo } : {}),
    };
  });

  const script: TalkScript = {
    version: TALK_SCRIPT_VERSION,
    id: newId(),
    title: tagValue(root, "subject") ?? tagValue(root, "title") ?? "",
    baseTimeSec: root.created_at,
    personas,
    lines,
  };
  return { script, warnings };
}

/**
 * Fetch a kind 11 root + its kind 1111 descendants for a NIP-19 identifier
 * and rebuild a TalkScript. Honest errors: bad identifiers, unreachable
 * relays, and a missing root all throw ImportError.
 */
export async function importFromIdentifier(
  input: string,
  fetch: FetchEvents,
): Promise<ImportResult> {
  const { rootFilter, relays } = decodeIdentifier(input);

  const roots = await fetchEvents(fetch, relays, [rootFilter]);
  const root = dedupeById(validOnly(roots))
    .filter((e) => e.kind === THREAD_KIND)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!root)
    throw new ImportError(
      "kind 11 のルートイベントが見つかりませんでした（リレーにイベントが存在しない可能性があります）",
    );

  const rawComments = await fetchEvents(fetch, relays, [
    { kinds: [COMMENT_KIND], "#E": [root.id] },
  ]);
  const comments = dedupeById(validOnly(rawComments));

  const { script, warnings } = buildScript(root, comments);
  if (comments.length === 0)
    warnings.push(
      "kind 1111 コメントは見つかりませんでした（ルートのみの台本として取り込みます）",
    );

  return { script, warnings, relays };
}

async function fetchEvents(
  fetch: FetchEvents,
  relays: string[],
  filters: Filter[],
): Promise<NostrEvent[]> {
  try {
    return await fetch(relays, filters);
  } catch (error) {
    throw new ImportError(
      `リレーへの問い合わせに失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
