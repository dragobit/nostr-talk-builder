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

/** kind 1 text note — the NIP-10 thread import source (B1). */
export const NOTE_KIND = 1;
/** Max descendants collected for one kind-1 thread (design: ~200). */
export const KIND1_THREAD_LIMIT = 200;
/** Deepest reply nesting kept under a kind-1 root (design: ~4 levels). */
export const KIND1_MAX_DEPTH = 4;
/** Bounded parent walk when resolving a mid-thread kind-1 target. */
const KIND1_MAX_ROOT_HOPS = 8;

/** Unsigned event shape (a Nostr rumor): buildScript never reads `sig`. */
export type UnsignedEvent = Omit<NostrEvent, "sig">;

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
  /**
   * Relay filter that selects the identified event. For nevent/note it is
   * an `ids` query — restricted to the nevent's kind hint when present,
   * unfiltered otherwise (the event's own kind picks the import route).
   */
  targetFilter: Filter;
  /** Query target: nevent/naddr relay hints, else the publish relay list. */
  relays: string[];
}

/** NIP-19 identifier -> target filter + relays. Throws ImportError. */
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
      const { id, relays, kind } = decoded.data;
      return {
        targetFilter: {
          ids: [id],
          ...(kind !== undefined ? { kinds: [kind] } : {}),
        },
        relays: resolveRelays(relays),
      };
    }
    case "note": {
      return {
        // a note carries no kind hint — fetch unfiltered and let the
        // returned event's kind select the import route
        targetFilter: { ids: [decoded.data] },
        relays: resolveRelays([]),
      };
    }
    case "naddr": {
      const { kind, pubkey, identifier, relays } = decoded.data;
      return {
        targetFilter: {
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

function tagValue(
  event: Pick<UnsignedEvent, "tags">,
  name: string,
): string | undefined {
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

export function shortNpub(pubkey: string): string {
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
 * Unsigned rumors (Concord channels) work as-is: only content fields are
 * read, never `sig`.
 */
export function buildScript(
  root: UnsignedEvent,
  comments: UnsignedEvent[],
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
 * Fetch the event a NIP-19 identifier points at and rebuild a TalkScript
 * by its kind: kind 11 → root + kind 1111 descendants (NIP-22); kind 1 →
 * NIP-10 thread. Honest errors: bad identifiers, unreachable relays, a
 * missing target, and unsupported kinds all throw ImportError.
 */
export async function importFromIdentifier(
  input: string,
  fetch: FetchEvents,
): Promise<ImportResult> {
  const { targetFilter, relays } = decodeIdentifier(input);

  const found = await fetchEvents(fetch, relays, [targetFilter]);
  const target = dedupeById(validOnly(found)).sort(
    (a, b) => b.created_at - a.created_at,
  )[0];
  if (!target)
    throw new ImportError(
      "対象イベントが見つかりませんでした（リレーにイベントが存在しない可能性があります）",
    );

  if (target.kind === THREAD_KIND)
    return importThreadRoot(target, relays, fetch);
  if (target.kind === NOTE_KIND)
    return importKind1Thread(target, relays, fetch);
  throw new ImportError(
    `未対応のイベント kind ${target.kind} です（kind 11 スレッド / kind 1 スレッドのみ取り込めます）`,
  );
}

/** Existing path: a kind 11 root plus its NIP-22 kind 1111 descendants. */
async function importThreadRoot(
  root: NostrEvent,
  relays: string[],
  fetch: FetchEvents,
): Promise<ImportResult> {
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

/** NIP-10 thread structure read off an event's `e` tags. */
export interface Nip10Refs {
  /** Root of the thread the event belongs to (marked "root" or first-e). */
  rootId?: string;
  /** Event this one replies to (marked "reply" or last-e); equals rootId
   * for direct replies to the root. */
  parentId?: string;
}

/**
 * Interpret an event's `e` tags by NIP-10: marked "root"/"reply" tags win
 * (a lone "root" tag means a direct reply to the root); without any
 * markers the deprecated positional form applies — first `e` = root,
 * last `e` = reply target, anything between = mention. Mentions
 * (e-marker "mention", `p` tags, uninterpreted leftovers) never yield a
 * thread position.
 */
export function nip10Refs(event: Pick<UnsignedEvent, "tags">): Nip10Refs {
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  let marked = false;
  let rootId: string | undefined;
  let replyId: string | undefined;
  for (const tag of eTags) {
    const marker = tag[3];
    // any marker field — root/reply/mention/unknown — puts the event in
    // the marked form; only root/reply assign a thread position
    if (marker !== undefined) marked = true;
    if (marker === "root") rootId ??= tag[1];
    else if (marker === "reply") replyId ??= tag[1];
  }
  if (marked) {
    // direct replies to the root carry only a "root" tag — their parent
    // is the root itself
    return { rootId, parentId: replyId ?? rootId };
  }
  return { rootId: eTags[0]?.[1], parentId: eTags.at(-1)?.[1] };
}

async function fetchById(
  fetch: FetchEvents,
  relays: string[],
  id: string,
  kind: number,
): Promise<NostrEvent | undefined> {
  const found = await fetchEvents(fetch, relays, [
    { ids: [id], kinds: [kind] },
  ]);
  return dedupeById(validOnly(found))[0];
}

/**
 * Resolve the thread root for a kind-1 target: the target itself when
 * top-level, otherwise the event its NIP-10 tags name — walking the
 * reply chain (bounded) when only a parent reference exists. `chain`
 * carries the events walked through (target first), all proven members
 * of the thread — they are not necessarily returned by the descendant
 * query (a reply-marked-only event does not reference the root).
 */
async function resolveKind1Root(
  target: NostrEvent,
  relays: string[],
  fetch: FetchEvents,
): Promise<{ root: NostrEvent; chain: NostrEvent[] }> {
  const chain: NostrEvent[] = [target];
  let current = target;
  for (let hop = 0; ; hop++) {
    const refs = nip10Refs(current);
    const wanted = refs.rootId ?? refs.parentId;
    if (!wanted || wanted === current.id) return { root: current, chain };
    if (hop >= KIND1_MAX_ROOT_HOPS)
      throw new ImportError(
        "スレッドのルート参照が深すぎるため取り込みを中止しました",
      );
    const next = await fetchById(fetch, relays, wanted, NOTE_KIND);
    if (!next)
      throw new ImportError(
        `スレッドの参照先イベント ${wanted.slice(0, 8)}… が見つかりませんでした`,
      );
    chain.push(next);
    current = next;
  }
}

/**
 * kind 1 / NIP-10 route: resolve the thread root for the target, collect
 * descendants by `#e` on the root (bounded by KIND1_THREAD_LIMIT), and
 * rebuild parent links by marker interpretation.
 */
async function importKind1Thread(
  target: NostrEvent,
  relays: string[],
  fetch: FetchEvents,
): Promise<ImportResult> {
  const { root, chain } = await resolveKind1Root(target, relays, fetch);

  const fetched = await fetchEvents(fetch, relays, [
    { kinds: [NOTE_KIND], "#e": [root.id], limit: KIND1_THREAD_LIMIT },
  ]);
  const notes = dedupeById(validOnly(fetched));
  const truncated = notes.length >= KIND1_THREAD_LIMIT;

  // a `#e` match can also be a mere mention of the root — keep only
  // events whose interpreted root is this root. Chain events are proven
  // members even without a root reference of their own.
  const chainIds = new Set(chain.map((e) => e.id));
  const members = dedupeById([...chain, ...notes]).filter(
    (e) =>
      e.id !== root.id &&
      (chainIds.has(e.id) || nip10Refs(e).rootId === root.id),
  );

  const { script, warnings } = buildKind1Script(root, members);
  warnings.unshift(
    "kind 1 スレッドは kind 11 + kind 1111 に変換されて再コンパイルされます（常にフォーク的な取り込みで、byte 一致の往復は kind 11/1111 ソースのみです）",
  );
  if (truncated)
    warnings.push(
      `スレッドが大きすぎるため先頭 ${KIND1_THREAD_LIMIT} 件で打ち切りました`,
    );
  if (members.length === 0)
    warnings.push(
      "kind 1 の返信は見つかりませんでした（ルートのみの台本として取り込みます）",
    );

  return { script, warnings, relays };
}

/**
 * Rebuild a TalkScript skeleton from a kind-1 root plus its collected
 * replies (already filtered to this thread). Same line/offset/persona
 * conventions as buildScript, but parents come from NIP-10 marker
 * interpretation: events whose parent is missing, time-inverted, or
 * beyond KIND1_MAX_DEPTH nest under the root with a warning.
 */
export function buildKind1Script(
  root: UnsignedEvent,
  replies: UnsignedEvent[],
): { script: TalkScript; warnings: string[] } {
  const warnings: string[] = [];
  const sorted = [...replies].sort(
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

  const depthByEventId = new Map<string, number>([[root.id, 0]]);
  const lines: ScriptLine[] = ordered.map((event, index) => {
    const offsetSec = event.created_at - root.created_at;
    if (offsetSec < 0)
      warnings.push(
        `イベント ${event.id.slice(0, 8)}… の作成時刻がルートより前のため 0 に丸めました`,
      );

    let replyTo: string | undefined;
    let depth = 1;
    if (index > 0) {
      const parentId = nip10Refs(event).parentId;
      if (parentId && parentId !== root.id) {
        const parentIndex = indexByEventId.get(parentId);
        const target = lineIdByEventId.get(parentId);
        const parentDepth = depthByEventId.get(parentId);
        if (parentIndex === undefined || !target || parentDepth === undefined) {
          warnings.push(
            `イベント ${event.id.slice(0, 8)}… の親 ${parentId.slice(0, 8)}… が収集セットに無いためルート直下に付け替えました`,
          );
        } else if (parentIndex >= index) {
          // parent must precede child (compile invariant)
          warnings.push(
            `イベント ${event.id.slice(0, 8)}… の作成時刻が親より前のためルート直下に付け替えました`,
          );
        } else if (parentDepth + 1 > KIND1_MAX_DEPTH) {
          warnings.push(
            `イベント ${event.id.slice(0, 8)}… のネストが深さ上限 (${KIND1_MAX_DEPTH}) を超えたためルート直下に付け替えました`,
          );
        } else {
          replyTo = target;
          depth = parentDepth + 1;
        }
      }
      depthByEventId.set(event.id, depth);
    }

    return {
      id: lineIdByEventId.get(event.id)!,
      personaId: personaByPubkey.get(event.pubkey)!,
      content: event.content,
      offsetSec: Math.max(0, offsetSec),
      ...(replyTo ? { replyTo } : {}),
    };
  });

  // kind 1 has no subject/title — derive a title from the root's first
  // line so the republished kind 11 root stays identifiable
  const firstLine = root.content.split("\n", 1)[0].trim();
  const script: TalkScript = {
    version: TALK_SCRIPT_VERSION,
    id: newId(),
    title: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine,
    baseTimeSec: root.created_at,
    personas,
    lines,
  };
  return { script, warnings };
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
