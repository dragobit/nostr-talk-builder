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

/** An input field a preset asks the user to fill at issue time. */
export interface IssueParam {
  /** Key in the params record handed to the wire compiler. */
  key: string;
  label: string;
  placeholder?: string;
  /** Render masked and keep the value out of IssueRecord.params. */
  secret?: boolean;
  /** Value used when the field is left empty (e.g. epoch "0"). */
  defaultValue?: string;
}

/**
 * Wire-compile modes: the preset publishes a dedicated event set
 * re-compiled from the script at issue time (M4a), not the canonical IR.
 */
export type IssueWireMode = "h-bind" | "nip29-chat";

/** Envelope the signed events are sent under (M4c adds "concord"). */
export type IssueEnvelope = "plain" | "concord";

export interface IssuePreset {
  label: string;
  description: string;
  /** false = no-op placeholder preset: nothing is sent to relays. */
  publishes: boolean;
  /** Binding axis — all presets are unbound in M3b; M4 adds "h" etc. */
  bindings: string[];
  /** Envelope axis — "plain" sends signed events as-is; "concord" wraps them. */
  envelope: IssueEnvelope;
  /** Expected-client links offered after a successful publish. */
  clientLinks: ClientLink[];
  /** Input fields rendered when the preset is selected (M4a). */
  params?: IssueParam[];
  /** Set when the preset publishes a wire-compiled event set (M4a). */
  wire?: IssueWireMode;
  /** Set to render the preset unselectable (announces future presets). */
  disabledReason?: string;
  /**
   * Render a "mint a fresh channel" button that fills the channel
   * coordinate params (channelId/channelKey/epoch) with random values.
   */
  mintableChannel?: boolean;
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
  "amethyst-plain": {
    label: "Amethyst 用（平文＋公開リレー）",
    description:
      "署名済みイベントを下記リレーに平文のまま送信します。Amethyst (Android) は kind 11 ルート（subject/title が見出し表示）と kind 1111 コメントをインデント付きのネストスレッドとして一体表示します。nostr: リンクは Amethyst が入った Android 端末で直接開きます（デスクトップでは njump のプレビューを使ってください）。",
    publishes: true,
    bindings: [],
    envelope: "plain",
    clientLinks: [
      {
        label: "Amethyst で開く (nostr: URI)",
        urlTemplate: "nostr:{nevent}",
      },
      {
        label: "njump で開く",
        urlTemplate: "https://njump.me/{nevent}",
      },
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
      "台本から全イベントに h タグを付けた別イベント集合をコンパイルし直して発行します（正準 IR とは別のイベント id になります）。発行先にはグループが属するリレーのみ指定してください。",
    publishes: true,
    bindings: ["h"],
    envelope: "plain",
    clientLinks: [],
    params: [
      {
        key: "groupId",
        label: "グループ ID",
        placeholder: "group-id",
      },
    ],
    wire: "h-bind",
  },
  "nip29-chat": {
    label: "NIP-29 グループチャット (kind 9 投影)",
    description:
      "全行を kind 9 チャットメッセージに投影して発行します（別イベント集合・kind 11/1111 やタイトルは送信されません）。発行前に各ペルソナの kind 9021 参加要求を送信します。発行先にはグループが属するリレーのみ指定してください。",
    publishes: true,
    bindings: ["h"],
    envelope: "plain",
    clientLinks: [],
    params: [
      {
        key: "groupId",
        label: "グループ ID",
        placeholder: "group-id",
      },
    ],
    wire: "nip29-chat",
  },
  concord: {
    label: "Concord チャンネル (rumor→seal→wrap)",
    description:
      "署名済みイベントを Concord エンベロープ (kind 1059 wrap) に包んで発行します。Armada 等の Concord クライアント向け — 公開 reader が無いため、現状の検証は往復復号とリレー到達確認のみです。チャンネル鍵は発行レコードに保存されません。",
    publishes: true,
    bindings: ["channel"],
    envelope: "concord",
    clientLinks: [],
    params: [
      {
        key: "channelId",
        label: "チャンネル ID (hex)",
        placeholder: "64文字のhex",
      },
      {
        key: "channelKey",
        label: "チャンネル鍵 (hex・レコードに記録されません)",
        placeholder: "64文字のhex",
        secret: true,
      },
      {
        key: "epoch",
        label: "エポック",
        placeholder: "0",
        defaultValue: "0",
      },
    ],
    mintableChannel: true,
  },
  "channel-bind": {
    label: "チャンネル束縛 (予定)",
    description: "channel+epoch 束縛での発行プリセット。",
    publishes: false,
    bindings: ["channel"],
    envelope: "plain",
    clientLinks: [],
    disabledReason: "M4b 以降で実装予定",
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
  envelope: IssueEnvelope;
  /** Relays the signed events were offered to. */
  relays: string[];
  /** kind 11 root event id at issue time (survives later script edits). */
  rootId?: string;
  /** Non-secret preset parameters used for this issue run (M4a). */
  params?: Record<string, string>;
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
  /** Bindings applied by the wire compile (defaults to none). */
  bindings?: string[];
  /** Envelope the events were sent under (defaults to "plain"). */
  envelope?: IssueEnvelope;
  /** Non-secret params used for the run (see recordableParams). */
  params?: Record<string, string>;
}): IssueRecord {
  return {
    id: crypto.randomUUID(),
    issuedAt: Math.floor(Date.now() / 1000),
    preset: input.preset,
    bindings: [...(input.bindings ?? [])],
    envelope: input.envelope ?? "plain",
    relays: [...input.relays],
    ...(input.rootId ? { rootId: input.rootId } : {}),
    ...(input.params ? { params: { ...input.params } } : {}),
    results: { ...input.results },
  };
}

/**
 * Params safe to persist on an IssueRecord: entries declared `secret`
 * by the preset are dropped so credentials never reach storage/export.
 */
export function recordableParams(
  preset: IssuePreset,
  values: Record<string, string>,
): Record<string, string> | undefined {
  if (!preset.params?.length) return undefined;
  const out: Record<string, string> = {};
  for (const param of preset.params) {
    if (param.secret) continue;
    const value = values[param.key]?.trim() || param.defaultValue;
    if (value) out[param.key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
