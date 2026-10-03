/**
 * Concord channel read side (M5-A) — the shared layer the channel viewer
 * and the future importer extension (M5-B2) both use:
 *
 *   channel coordinate → deriveChannelStream
 *     → fetchRumors: REQ {kinds:[1059], authors:[stream.pk]} paged
 *       backwards by `until` cursor (Plektos-style, PAGE=300)
 *     → per wrap: openWrap + checkChannelBinding into a RumorStore
 *       (Map<rumor id, Rumor>, deduped, per-wrap errors collected)
 *     → foldRumors: project the store to display rows (kind 9 + 1111 only)
 *
 * Relays only ever see the stream's public key as wrap author. NIP-42 is
 * minimal: the caller wires streamAuthSigner into the transport's
 * authenticate hook (applesauce `relay.authenticate`); relays that insist
 * on auth surface an honest failure.
 */
import {
  finalizeEvent,
  getEventHash,
  type EventTemplate,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { AuthRequiredError } from "applesauce-relay";
import { deriveChannelStream, type ChannelStream } from "./derive";
import {
  checkChannelBinding,
  KIND_WRAP,
  openWrap,
  type Rumor,
} from "./envelope";

/** History page size per REQ (Plektos-style paging). */
export const WRAP_PAGE_SIZE = 300;

/** Rumor kinds this reader renders as timeline rows. */
export const KIND_CHANNEL_CHAT = 9;
export const KIND_CHANNEL_COMMENT = 1111;

/** Channel coordinate as entered by the user (deriveChannelStream params). */
export interface ChannelCoordinate {
  channelIdHex: string;
  channelKeyHex: string;
  epoch: number | bigint | string;
}

/** An open channel session: coordinate + derived stream + relay list. */
export interface ChannelSession {
  channel: ChannelCoordinate;
  stream: ChannelStream;
  relays: string[];
}

/**
 * rumor id -> verified rumor. Rumors are unsigned — a RumorStore must
 * never be merged into the app's EventStore.
 */
export type RumorStore = Map<string, Rumor>;

export function createRumorStore(): RumorStore {
  return new Map();
}

/** Per-wrap failure record (a bad wrap never aborts a fetch). */
export interface WrapOpenError {
  wrapId: string;
  reason: string;
}

export interface WrapOpenResult {
  wrapId: string;
  rumor?: Rumor;
  error?: string;
}

/**
 * Wrap opener bound to one channel: openWrap verifies the envelope and
 * checkChannelBinding enforces the channel/epoch binding (anti-splice).
 * Wraps are immutable, so results — success or failure — are memoized
 * per wrap id (bulk history re-open is free).
 */
export function createWrapOpener(
  stream: ChannelStream,
  binding: { channelIdHex: string; epoch: number | bigint },
): (wrap: NostrEvent) => WrapOpenResult {
  const cache = new Map<string, WrapOpenResult>();
  return (wrap) => {
    const hit = cache.get(wrap.id);
    if (hit) return hit;
    let result: WrapOpenResult;
    try {
      const { rumor } = openWrap(wrap, stream);
      checkChannelBinding(rumor, binding.channelIdHex, binding.epoch);
      result = { wrapId: wrap.id, rumor };
    } catch (error) {
      result = {
        wrapId: wrap.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    cache.set(wrap.id, result);
    return result;
  };
}

/**
 * One-shot wrap fetch — same call shape as
 * `pool.request(relays, filters).pipe(toArray())`. Injected so fetchRumors
 * stays pure and testable (the FetchEvents pattern from the importer).
 */
export type FetchWraps = (
  relays: string[],
  filters: Filter[],
) => Promise<NostrEvent[]>;

/** NIP-42 signer: answers a relay's AUTH challenge with a kind 22242
 * event signed by the channel stream key. */
export function streamAuthSigner(stream: ChannelStream): {
  signEvent: (event: EventTemplate) => NostrEvent;
} {
  return {
    signEvent: (event: EventTemplate) => finalizeEvent(event, stream.sk),
  };
}

function isAuthRequired(error: unknown): boolean {
  if (error instanceof AuthRequiredError) return true;
  return error instanceof Error && error.message.includes("auth-required");
}

/**
 * Wrap a FetchWraps so an auth-required answer triggers one authenticate()
 * (caller-supplied, e.g. pool.relay(url).authenticate(streamAuthSigner(…)))
 * plus a single retry. Relays still refusing surface the auth-required
 * error honestly to the caller.
 */
export function withStreamAuth(
  fetch: FetchWraps,
  authenticate: (relays: string[]) => Promise<void>,
): FetchWraps {
  return async (relays, filters) => {
    try {
      return await fetch(relays, filters);
    } catch (error) {
      if (!isAuthRequired(error)) throw error;
      await authenticate(relays);
      return await fetch(relays, filters);
    }
  };
}

export interface FetchRumorsOptions {
  /** Store to accumulate into — pass a live store to merge new pages in. */
  store?: RumorStore;
  /** Fetch history strictly before this unix second (until cursor). */
  until?: number;
  /** Wraps per REQ page (default WRAP_PAGE_SIZE). */
  pageSize?: number;
  /** Max pages per call (default 20 — bounds runaway relays). */
  maxPages?: number;
  /** Called after each page with the count of unique wraps seen so far. */
  onProgress?: (opened: number) => void;
}

export interface FetchRumorsResult {
  rumors: RumorStore;
  errors: WrapOpenError[];
  pagesFetched: number;
  /** The last page hit the page cap: older history may remain —
   * continue by calling fetchRumors again with until = nextUntil. */
  mayHaveMore: boolean;
  /** until cursor for a follow-up call (set only when mayHaveMore). */
  nextUntil?: number;
  /**
   * A full page ended at this created_at second: any further wraps in
   * that second were skipped by the until-cursor step. Documented
   * limit — the same-second {since:t,until:t} drain is not implemented
   * in v1. Set on every full-page boundary (the wraps it may hide are
   * never fetched).
   */
  saturatedSecond?: number;
}

/** Normalize the coordinate's epoch to bigint (derive already validated). */
function epochBig(epoch: number | bigint | string): bigint {
  return BigInt(String(epoch).trim());
}

/**
 * Fetch a channel's wraps off relays and open them into a RumorStore.
 * Pages backwards from `until` (default: newest) with a `limit` page
 * cap; reverse-chronological so recent history arrives first. Pure —
 * the transport is the injected fetch.
 */
export async function fetchRumors(
  channel: ChannelCoordinate,
  relays: string[],
  fetch: FetchWraps,
  options: FetchRumorsOptions = {},
): Promise<FetchRumorsResult> {
  const stream = deriveChannelStream(channel);
  const epoch = epochBig(channel.epoch);
  const opener = createWrapOpener(stream, {
    channelIdHex: channel.channelIdHex,
    epoch,
  });

  const pageSize = options.pageSize ?? WRAP_PAGE_SIZE;
  const maxPages = options.maxPages ?? 20;
  const store = options.store ?? createRumorStore();
  const errors: WrapOpenError[] = [];
  const seenWraps = new Set<string>();

  let until = options.until;
  let pagesFetched = 0;
  let mayHaveMore = false;
  let saturatedSecond: number | undefined;

  while (pagesFetched < maxPages) {
    const filter: Filter = {
      kinds: [KIND_WRAP],
      authors: [stream.pk],
      limit: pageSize,
    };
    if (until !== undefined) filter.until = until;

    const wraps = await fetch(relays, [filter]);
    pagesFetched += 1;

    for (const wrap of wraps) {
      if (seenWraps.has(wrap.id)) continue;
      seenWraps.add(wrap.id);
      const result = opener(wrap);
      if (result.rumor) {
        store.set(result.rumor.id, result.rumor);
      } else {
        errors.push({
          wrapId: wrap.id,
          reason: result.error ?? "開封に失敗しました",
        });
      }
    }
    options.onProgress?.(seenWraps.size);
    // cooperative slice: let the UI paint between pages of bulk opens
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (wraps.length < pageSize) {
      mayHaveMore = false;
      until = undefined;
      break;
    }
    const oldest = Math.min(...wraps.map((w) => w.created_at));
    // Paging past `oldest` (until = oldest - 1) drops every other wrap in
    // that same second — flag it whenever a full page ends, not only when
    // the whole page sits in one second. The {since:t,until:t} drain that
    // would recover them is not implemented in v1.
    saturatedSecond = oldest;
    until = oldest - 1;
    mayHaveMore = true;
  }

  return {
    rumors: store,
    errors,
    pagesFetched,
    mayHaveMore,
    nextUntil: mayHaveMore ? until : undefined,
    saturatedSecond,
  };
}

/** A referenced rumor for display (kind 9 `q` quote / kind 1111 parent). */
export interface ChannelQuote {
  /** Referenced event id as written in the rumor's tag. */
  id: string;
  /** Present when the referenced rumor is in the store. */
  resolved?: { pubkey: string; kind: number; content: string };
}

export interface ChannelRow {
  rumor: Rumor;
  quote?: ChannelQuote;
  /** kind 1111 nesting depth in its e-tag chain (0 = top level). */
  depth: number;
}

export interface ChannelFold {
  /** kind 9 + 1111 rumors, created_at asc with id tiebreak. */
  rows: ChannelRow[];
  /** kind -> count for every non-row kind (11, 5, 3302, 7, …). */
  skipped: Map<number, number>;
}

/** Last tag value wins (NIP-22 parent-scope convention). */
function lastTagValue(rumor: Rumor, name: string): string | undefined {
  const tags = rumor.tags.filter((t) => t[0] === name && t[1]);
  return tags.at(-1)?.[1];
}

/**
 * Fold a RumorStore into display rows. Only kind 9 and kind 1111 rumors
 * become rows; every other kind counts into `skipped` ("未対応 kind N件").
 *
 * References resolve against both the rumor id and its canonical id:
 * rumors minted by wrapping a canonical IR event (M4c) carry e/E/q tags
 * pointing at the PRE-binding event id, so stripping the channel/epoch
 * binding tags and re-hashing recovers it. Native Concord rumors that
 * already reference rumor ids hit the direct lookup first.
 */
export function foldRumors(rumors: Iterable<Rumor>): ChannelFold {
  const all = [...rumors];
  const byId = new Map<string, Rumor>();
  const byCanonicalId = new Map<string, Rumor>();
  for (const rumor of all) {
    byId.set(rumor.id, rumor);
    const stripped = {
      kind: rumor.kind,
      pubkey: rumor.pubkey,
      created_at: rumor.created_at,
      content: rumor.content,
      tags: rumor.tags.filter(
        (t) => t[0] !== "channel" && t[0] !== "epoch",
      ),
    };
    const canonicalId = getEventHash(stripped as NostrEvent);
    if (canonicalId !== rumor.id) byCanonicalId.set(canonicalId, rumor);
  }
  const resolve = (id: string) => byId.get(id) ?? byCanonicalId.get(id);

  const quoteFor = (id: string): ChannelQuote => {
    const target = resolve(id);
    return target
      ? {
          id,
          resolved: {
            pubkey: target.pubkey,
            kind: target.kind,
            content: target.content,
          },
        }
      : { id };
  };

  const rowById = new Map<string, Rumor>(
    all
      .filter(
        (r) =>
          r.kind === KIND_CHANNEL_CHAT || r.kind === KIND_CHANNEL_COMMENT,
      )
      .map((r) => [r.id, r]),
  );

  // kind 1111 depth = length of the e-tag parent chain through other
  // 1111 rows; cycles and non-1111/missing parents bottom out at 0
  const depthMemo = new Map<string, number>();
  const depthOf = (rumor: Rumor, visiting: Set<string>): number => {
    const memoized = depthMemo.get(rumor.id);
    if (memoized !== undefined) return memoized;
    if (visiting.has(rumor.id)) return 0;
    visiting.add(rumor.id);
    const parentId = lastTagValue(rumor, "e");
    const parent = parentId !== undefined ? resolve(parentId) : undefined;
    const depth =
      parent && parent.kind === KIND_CHANNEL_COMMENT && rowById.has(parent.id)
        ? depthOf(parent, visiting) + 1
        : 0;
    visiting.delete(rumor.id);
    depthMemo.set(rumor.id, depth);
    return depth;
  };

  const skipped = new Map<number, number>();
  const out: ChannelRow[] = [];
  for (const rumor of all) {
    if (rumor.kind !== KIND_CHANNEL_CHAT && rumor.kind !== KIND_CHANNEL_COMMENT) {
      skipped.set(rumor.kind, (skipped.get(rumor.kind) ?? 0) + 1);
      continue;
    }
    let quote: ChannelQuote | undefined;
    let depth = 0;
    if (rumor.kind === KIND_CHANNEL_CHAT) {
      const quoted = lastTagValue(rumor, "q");
      if (quoted) quote = quoteFor(quoted);
    } else {
      const parent = lastTagValue(rumor, "e");
      if (parent) quote = quoteFor(parent);
      depth = depthOf(rumor, new Set());
    }
    out.push({ rumor, quote, depth });
  }
  out.sort((a, b) => a.rumor.created_at - b.rumor.created_at || a.rumor.id.localeCompare(b.rumor.id));
  return { rows: out, skipped };
}
