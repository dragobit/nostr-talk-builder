import type { NostrEvent } from "nostr-tools";
import type { PublishResponse } from "applesauce-relay";
import { normalizeURL } from "applesauce-core/helpers";

/** localStorage key holding the publish-target relay list (M3a). */
export const RELAY_STORAGE_KEY = "nostr-talk-builder:relays:v1";

/**
 * Open-write relays suitable for testing synthetic conversations.
 * Deliberately not the big public relays.
 */
export const DEFAULT_PUBLISH_RELAYS = ["wss://nos.lol", "wss://nostr.mom"];

export interface IssuePreset {
  label: string;
  description: string;
  /** false = no-op placeholder preset: nothing is sent to relays. */
  publishes: boolean;
}

/** Issue presets shipped in M3a; ids are stored on IssueRecord.preset. */
export const ISSUE_PRESETS = {
  "public-plain": {
    label: "既存クライアント用（平文＋公開リレー）",
    description: "署名済みイベントを下記リレーに平文のまま送信します。",
    publishes: true,
  },
  "app-only": {
    label: "アプリ内のみ",
    description:
      "何も送信されません。署名済みイベントはアプリ内 EventStore にのみ保持されます。",
    publishes: false,
  },
} as const satisfies Record<string, IssuePreset>;

export type IssuePresetId = keyof typeof ISSUE_PRESETS;

/** One issuance attempt: the signed IR offered to a relay set. */
export interface IssueRecord {
  id: string;
  /** Unix seconds when the issue ran. */
  issuedAt: number;
  /** Preset id (a key of ISSUE_PRESETS). */
  preset: string;
  /** Binding axis — reserved for M4, always empty in M3a. */
  bindings: string[];
  envelope: "plain";
  /** Relays the signed events were offered to. */
  relays: string[];
  /** event id -> "ok" or a failure reason. */
  results: Record<string, "ok" | string>;
}

/** True only for ws:// or wss:// URLs. */
export function isValidRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

/**
 * Normalize user-entered text into a relay URL. Protocol-less input gets
 * wss://; non-websocket schemes are rejected (returns null).
 */
export function normalizeRelayInput(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  // inputs without "scheme://" are treated as host[:port][/path];
  // "host:port" must not be misparsed as a scheme.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `wss://${url}`;
  if (!isValidRelayUrl(url)) return null;
  return new URL(url).toString();
}

/**
 * Read the persisted publish relays. Missing, corrupt, or empty-after-
 * filtering storage falls back to DEFAULT_PUBLISH_RELAYS.
 */
export function loadPublishRelays(): string[] {
  try {
    const raw = localStorage.getItem(RELAY_STORAGE_KEY);
    if (raw === null) return [...DEFAULT_PUBLISH_RELAYS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_PUBLISH_RELAYS];
    const relays = parsed.filter(
      (r): r is string => typeof r === "string" && isValidRelayUrl(r),
    );
    return relays.length > 0 ? relays : [...DEFAULT_PUBLISH_RELAYS];
  } catch {
    return [...DEFAULT_PUBLISH_RELAYS];
  }
}

/** Persist the publish relay list (best-effort, like saveStoredScript). */
export function savePublishRelays(relays: string[]): void {
  try {
    localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(relays));
  } catch (error) {
    console.warn("Failed to persist publish relays:", error);
  }
}

/** Per-relay outcome for one published event. */
export interface RelayResult {
  ok: boolean;
  message?: string;
}

/** event id -> relay url -> outcome (detailed view of an issue run). */
export type PublishOutcome = Record<string, Record<string, RelayResult>>;

/** Same call shape as RelayPool.publish. */
export type PublishFn = (
  relays: string[],
  event: NostrEvent,
) => Promise<PublishResponse[]>;

/**
 * Offer each signed event to every relay, sequentially in event order.
 * A throwing publish marks that event failed on all relays and continues
 * with the next — the outcome always covers every event x relay pair.
 */
export async function publishToRelays(
  events: NostrEvent[],
  relays: string[],
  publish: PublishFn,
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = {};
  for (const event of events) {
    const perRelay: Record<string, RelayResult> = {};
    for (const relay of relays)
      perRelay[relay] = { ok: false, message: "応答なし" };
    try {
      const responses = await publish(relays, event);
      // the pool normalizes relay urls (trailing slash) in `from`
      const byNormalized = new Map(
        relays.map((r) => [normalizeURL(r), r] as const),
      );
      for (const res of responses) {
        const relay = byNormalized.get(normalizeURL(res.from)) ?? res.from;
        perRelay[relay] = { ok: res.ok, message: res.message };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const relay of relays) perRelay[relay] = { ok: false, message };
    }
    outcome[event.id] = perRelay;
  }
  return outcome;
}

/**
 * Collapse per-relay outcomes into the record's per-event map: "ok" only
 * when every configured relay accepted; otherwise the reason lists each
 * failing relay as `relay: reason`.
 */
export function aggregateResults(
  outcome: PublishOutcome,
): Record<string, "ok" | string> {
  const results: Record<string, "ok" | string> = {};
  for (const [eventId, perRelay] of Object.entries(outcome)) {
    const failures = Object.entries(perRelay)
      .filter(([, r]) => !r.ok)
      .map(([relay, r]) => `${relay}: ${r.message ?? "unknown error"}`);
    results[eventId] = failures.length === 0 ? "ok" : failures.join(" / ");
  }
  return results;
}

export function createIssueRecord(input: {
  preset: string;
  relays: string[];
  results: Record<string, "ok" | string>;
}): IssueRecord {
  return {
    id: crypto.randomUUID(),
    issuedAt: Math.floor(Date.now() / 1000),
    preset: input.preset,
    bindings: [],
    envelope: "plain",
    relays: [...input.relays],
    results: { ...input.results },
  };
}
