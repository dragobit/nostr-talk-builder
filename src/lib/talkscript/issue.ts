import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import type { PublishResponse } from "applesauce-relay";
import { normalizeURL } from "applesauce-core/helpers";

/** localStorage key holding the publish-target relay list (M3a). */
export const RELAY_STORAGE_KEY = "nostr-talk-builder:relays:v1";

/**
 * Open-write relays suitable for testing synthetic conversations.
 * Deliberately not the big public relays. Canonical form (normalizeURL),
 * matching what the pool reports back in PublishResponse.from.
 */
export const DEFAULT_PUBLISH_RELAYS = ["wss://nos.lol/", "wss://nostr.mom/"];

/** A link offered to the user after issuance: label + url template. */
export interface ClientLink {
  /** e.g. "njump で開く" */
  label: string;
  /** Template containing a {nevent} placeholder for the issued root. */
  urlTemplate: string;
}

export interface IssuePreset {
  label: string;
  description: string;
  /** false = no-op placeholder preset: nothing is sent to relays. */
  publishes: boolean;
  /** Binding axis — all presets are unbound in M3b; M4 adds "h" etc. */
  bindings: string[];
  /** Envelope axis — "plain" only in M3b; M4 adds "nip59" / "concord". */
  envelope: "plain";
  /** Expected-client links offered after a successful publish. */
  clientLinks: ClientLink[];
  /** Set to render the preset unselectable (announces future presets). */
  disabledReason?: string;
}

/** Issue presets; ids are stored on IssueRecord.preset. */
export const ISSUE_PRESETS = {
  "public-plain": {
    label: "既存クライアント用（平文＋公開リレー）",
    description: "署名済みイベントを下記リレーに平文のまま送信します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      { label: "njump で開く", urlTemplate: "https://njump.me/{nevent}" },
    ],
  },
  "coracle-plain": {
    label: "Coracle 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。Coracle はルートと各コメントを個別表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      {
        label: "Coracle で開く",
        urlTemplate: "https://coracle.social/notes/{nevent}",
      },
    ],
  },
  "iris-plain": {
    label: "Iris 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。Iris はルートと各コメント（親イベント付き）を表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      { label: "Iris で開く", urlTemplate: "https://iris.to/{nevent}" },
    ],
  },
  "jumble-plain": {
    label: "Jumble 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。Jumble は kind 11 ルートを描画しませんが、kind 1111 コメントをスレッド表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      {
        label: "Jumble で開く",
        urlTemplate: "https://jumble.social/notes/{nevent}",
      },
    ],
  },
  "nostrudel-plain": {
    label: "noStrudel 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。noStrudel はルートと各コメントを個別表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      {
        label: "noStrudel で開く",
        urlTemplate: "https://nostrudel.ninja/n/{nevent}",
      },
    ],
  },
  "snort-plain": {
    label: "Snort 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。Snort は kind 11 ルートを描画しませんが、kind 1111 コメントをスレッド表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      { label: "Snort で開く", urlTemplate: "https://snort.social/e/{nevent}" },
    ],
  },
  "ditto-plain": {
    label: "ditto 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。ditto は kind 11 ルートと kind 1111 コメントをスレッドとして一体表示します。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      { label: "ditto で開く", urlTemplate: "https://ditto.pub/{nevent}" },
    ],
  },
  "grimoire-plain": {
    label: "grimoire 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。grimoire はルートを単独イベントとしてプレビュー表示しますが、kind 1111 コメントは表示しません。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      {
        label: "grimoire で開く",
        urlTemplate: "https://grimoire.rocks/{nevent}",
      },
    ],
  },
  "app-only": {
    label: "アプリ内のみ",
    description:
      "何も送信されません。署名済みイベントはアプリ内 EventStore にのみ保持されます。",
    publishes: false,
    bindings: [],
    envelope: "plain",
    clientLinks: [],
  },
  "h-bind": {
    label: "NIP-29 グループ向け (h 束縛)",
    description:
      "kind 11/1111 に h タグを付けて NIP-29 グループへ束縛して発行します。",
    publishes: false,
    bindings: ["h"],
    envelope: "plain",
    clientLinks: [],
    disabledReason: "M4 で実装予定",
  },
} as const satisfies Record<string, IssuePreset>;

export type IssuePresetId = keyof typeof ISSUE_PRESETS;

/** Look up a preset by id; undefined for ids stored by future versions. */
export function getIssuePreset(presetId: string): IssuePreset | undefined {
  return (ISSUE_PRESETS as Record<string, IssuePreset>)[presetId];
}

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
  /** kind 11 root event id at issue time (survives later script edits). */
  rootId?: string;
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
  return normalizeURL(url);
}

/**
 * Canonicalize and dedupe a relay list: "wss://a" and "wss://a/" are the
 * same relay. Output entries are always in normalizeURL form, so an
 * exact-string `includes` is a correct membership check.
 */
export function dedupeRelays(relays: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const relay of relays) {
    const canonical = normalizeURL(relay);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

/**
 * Read the persisted publish relays. Missing, corrupt, or empty-after-
 * filtering storage falls back to DEFAULT_PUBLISH_RELAYS. Returned entries
 * are always canonical (dedupeRelays form).
 */
export function loadPublishRelays(): string[] {
  try {
    const raw = localStorage.getItem(RELAY_STORAGE_KEY);
    if (raw === null) return [...DEFAULT_PUBLISH_RELAYS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_PUBLISH_RELAYS];
    const relays = dedupeRelays(
      parsed.filter(
        (r): r is string => typeof r === "string" && isValidRelayUrl(r),
      ),
    );
    return relays.length > 0 ? relays : [...DEFAULT_PUBLISH_RELAYS];
  } catch {
    return [...DEFAULT_PUBLISH_RELAYS];
  }
}

/** Persist the publish relay list canonically (best-effort). */
export function savePublishRelays(relays: string[]): void {
  try {
    const canonical = dedupeRelays(relays.filter(isValidRelayUrl));
    localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(canonical));
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
  /** kind 11 root event id, when the root was part of the publish. */
  rootId?: string;
  results: Record<string, "ok" | string>;
}): IssueRecord {
  return {
    id: crypto.randomUUID(),
    issuedAt: Math.floor(Date.now() / 1000),
    preset: input.preset,
    bindings: [],
    envelope: "plain",
    relays: [...input.relays],
    ...(input.rootId ? { rootId: input.rootId } : {}),
    results: { ...input.results },
  };
}

/** Fallback for presets without clientLinks (and unknown preset ids):
 * the IR is standard kind 11/1111, so any generic viewer can read it. */
const NJUMP_LINK: ClientLink = {
  label: "njump で開く",
  urlTemplate: "https://njump.me/{nevent}",
};

export interface ResolvedClientLink {
  label: string;
  url: string;
}

/**
 * Resolve the preset's client links for an issued record: the root's
 * nevent (relays hinted with the ones it was published to) is substituted
 * into each urlTemplate. Unknown preset ids and presets without links
 * fall back to njump. Returns [] when the record has no rootId or the
 * root was not accepted by every relay — a failed root's link would 404.
 */
export function issueLinks(
  record: Pick<IssueRecord, "rootId" | "relays" | "preset" | "results">,
): ResolvedClientLink[] {
  if (!record.rootId || record.results[record.rootId] !== "ok") return [];
  const nevent = nip19.neventEncode({
    id: record.rootId,
    relays: record.relays,
  });
  const links = getIssuePreset(record.preset)?.clientLinks ?? [NJUMP_LINK];
  const templates = links.length > 0 ? links : [NJUMP_LINK];
  return templates.map((link) => ({
    label: link.label,
    url: link.urlTemplate.replace("{nevent}", nevent),
  }));
}
