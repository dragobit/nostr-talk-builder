/**
 * Concord channel → TalkScript import (M5-B2). Shares the read side's
 * fetchRumors pipeline; the script mapping splits on whether the channel
 * contains a kind 11 root rumor:
 *
 *   root rumor present  → canonicalize (strip channel/epoch binding tags,
 *     re-hash, translate e/E refs into canonical id space) and take the
 *     normal buildScript path — a bound republish reproduces the same
 *     channel ("束縛付き発行なら同チャンネルへ再発行可能")
 *   no root (kind 9 chat, or 1111 orphans) → synthesize a root line owned
 *     by the stream persona, baseTimeSec = oldest rumor, q/e refs map to
 *     replyTo when the parent is in the collected set
 *
 * Provenance lives in the warnings (channelId/epoch), not in TalkScript
 * fields — a persist-schema change stays unnecessary.
 */
import { getEventHash, type NostrEvent } from "nostr-tools";
import { THREAD_KIND } from "../talkscript/compile";
import {
  buildScript,
  ImportError,
  shortNpub,
  type ImportResult,
} from "../talkscript/importer";
import { newId } from "../talkscript/sample";
import {
  TALK_SCRIPT_VERSION,
  type Persona,
  type ScriptLine,
  type TalkScript,
} from "../talkscript/types";
import { dedupeRelays } from "../talkscript/issue";
import { deriveChannelStream } from "./derive";
import type { Rumor } from "./envelope";
import {
  canonicalRumorId,
  fetchRumors,
  KIND_CHANNEL_CHAT,
  KIND_CHANNEL_COMMENT,
  lastTagValue,
  type ChannelCoordinate,
  type FetchRumorsOptions,
  type FetchWraps,
} from "./read";

/** Content of the synthesized root line for a rootless channel. */
export const SYNTHETIC_ROOT_CONTENT = "（Concord チャンネル取り込み）";

function channelTitle(channel: ChannelCoordinate): string {
  return `Concord ch:${channel.channelIdHex.slice(0, 8)}`;
}

function epochText(channel: ChannelCoordinate): string {
  try {
    return BigInt(String(channel.epoch).trim()).toString();
  } catch {
    return String(channel.epoch);
  }
}

/** Aggregate "未対応 kind N件" counts into one warning line. */
function skippedKindsWarning(skipped: Map<number, number>): string | null {
  if (skipped.size === 0) return null;
  const total = [...skipped.values()].reduce((a, b) => a + b, 0);
  const detail = [...skipped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([kind, count]) => `kind ${kind}×${count}`)
    .join(", ");
  return `未対応 kind の rumor ${total} 件を取り込み対象外にしました（${detail}）`;
}

/**
 * Build a TalkScript from an already-collected RumorStore (the channel
 * view's live store works as-is — no extra fetch). Pure and synchronous.
 * Throws ImportError only when the store holds nothing.
 */
export function scriptFromChannel(
  rumors: Iterable<Rumor>,
  channel: ChannelCoordinate,
  streamPk: string,
): { script: TalkScript; warnings: string[] } {
  const all = [...rumors];
  if (all.length === 0)
    throw new ImportError("チャンネルに開封できた rumor がありません");

  const warnings: string[] = [
    `Concord チャンネル ch:${channel.channelIdHex.slice(0, 8)} epoch ${epochText(channel)} から取り込みました`,
  ];

  const roots = all.filter((r) => r.kind === THREAD_KIND);
  if (roots.length > 0) return threadPath(all, roots, channel, warnings);
  return chatPath(all, channel, streamPk, warnings);
}

/**
 * Rootful path: the kind 11 root rumor plus kind 1111 descendants go
 * through buildScript in canonical id space — binding tags stripped, ids
 * re-hashed, and e/E tag values rewritten rumor id → canonical id so both
 * app-minted rumors (which reference pre-binding ids) and native rumors
 * (which may reference rumor ids) resolve.
 */
function threadPath(
  all: Rumor[],
  roots: Rumor[],
  channel: ChannelCoordinate,
  warnings: string[],
): { script: TalkScript; warnings: string[] } {
  const canonicalByRumorId = new Map(
    all.map((r) => [r.id, canonicalRumorId(r)] as const),
  );
  const toCanonical = (id: string) => canonicalByRumorId.get(id) ?? id;

  let root = roots[0];
  if (roots.length > 1) {
    // pick the candidate the kind 1111s' root-scope E tags reference most;
    // ties break on oldest created_at then id (deterministic)
    const score = new Map<string, number>(roots.map((r) => [r.id, 0]));
    for (const r of all) {
      if (r.kind !== KIND_CHANNEL_COMMENT) continue;
      const ref = toCanonical(lastTagValue(r, "E") ?? "");
      for (const candidate of roots) {
        if (ref === canonicalByRumorId.get(candidate.id)) {
          score.set(candidate.id, score.get(candidate.id)! + 1);
          break;
        }
      }
    }
    root = [...roots].sort(
      (a, b) =>
        score.get(b.id)! - score.get(a.id)! ||
        a.created_at - b.created_at ||
        a.id.localeCompare(b.id),
    )[0];
    warnings.push(
      `kind 11 ルート候補が ${roots.length} 件あります — 最も参照されるものを採用しました`,
    );
  }

  const canonicalize = (r: Rumor): Rumor => {
    const tags = r.tags
      .filter((t) => t[0] !== "channel" && t[0] !== "epoch")
      .map((t) =>
        (t[0] === "e" || t[0] === "E") && t[1]
          ? [t[0], toCanonical(t[1]), ...t.slice(2)]
          : t,
      );
    const body = {
      kind: r.kind,
      pubkey: r.pubkey,
      created_at: r.created_at,
      content: r.content,
      tags,
    };
    return { ...body, id: getEventHash(body as NostrEvent) };
  };

  const comments = all
    .filter((r) => r.kind === KIND_CHANNEL_COMMENT)
    .map(canonicalize);
  const built = buildScript(canonicalize(root), comments);

  if (!built.script.title) built.script.title = channelTitle(channel);

  const skipped = new Map<number, number>();
  for (const r of all) {
    if (r.kind === KIND_CHANNEL_COMMENT || r === root) continue;
    skipped.set(r.kind, (skipped.get(r.kind) ?? 0) + 1);
  }
  const skippedNote = skippedKindsWarning(skipped);
  if (skippedNote) warnings.push(skippedNote);
  warnings.push(
    "束縛タグ (channel/epoch) は取り込み時に正規化で外れます — 束縛付き発行なら同チャンネルへ再発行可能です",
  );

  return { script: built.script, warnings: [...warnings, ...built.warnings] };
}

/**
 * Rootless path: TalkScript requires lines[0] = root, so synthesize one
 * owned by a `channel` persona (pubkey = stream pk — nobody holds the
 * stream key, so it is always a fork). baseTimeSec = oldest rumor's
 * created_at; kind 9 `q` tags and kind 1111 `e` parents map to replyTo
 * when the parent is in the collected set (resolved by rumor id and
 * canonical id alike).
 */
function chatPath(
  all: Rumor[],
  channel: ChannelCoordinate,
  streamPk: string,
  warnings: string[],
): { script: TalkScript; warnings: string[] } {
  const rows = all
    .filter(
      (r) => r.kind === KIND_CHANNEL_CHAT || r.kind === KIND_CHANNEL_COMMENT,
    )
    .sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    );
  // rows may be empty (channel of only non-row kinds): anchor on the
  // oldest collected rumor either way so offsets stay non-negative
  const baseTimeSec = Math.min(...all.map((r) => r.created_at));

  const skipped = new Map<number, number>();
  for (const r of all) {
    if (r.kind === KIND_CHANNEL_CHAT || r.kind === KIND_CHANNEL_COMMENT)
      continue;
    skipped.set(r.kind, (skipped.get(r.kind) ?? 0) + 1);
  }
  const skippedNote = skippedKindsWarning(skipped);
  if (skippedNote) warnings.push(skippedNote);

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const byCanonicalId = new Map<string, Rumor>();
  for (const r of rows) {
    const canonicalId = canonicalRumorId(r);
    if (canonicalId !== r.id) byCanonicalId.set(canonicalId, r);
  }
  const resolve = (id: string) => byId.get(id) ?? byCanonicalId.get(id);

  const channelPersona: Persona = {
    id: "channel",
    name: "channel",
    pubkey: streamPk,
  };
  const personas: Persona[] = [channelPersona];
  const personaByPubkey = new Map<string, string>([[streamPk, "channel"]]);
  for (const r of rows) {
    if (!personaByPubkey.has(r.pubkey)) {
      const id = `persona-${personas.length + 1}`;
      personas.push({ id, name: shortNpub(r.pubkey), pubkey: r.pubkey });
      personaByPubkey.set(r.pubkey, id);
    }
  }

  const lineIdByRumorId = new Map<string, string>();
  for (const r of rows) lineIdByRumorId.set(r.id, newId());
  const indexByRumorId = new Map<string, number>();
  rows.forEach((r, index) => indexByRumorId.set(r.id, index));

  const rootLine: ScriptLine = {
    id: newId(),
    personaId: channelPersona.id,
    content: SYNTHETIC_ROOT_CONTENT,
    offsetSec: 0,
  };

  const lines: ScriptLine[] = [
    rootLine,
    ...rows.map((r, index) => {
      // kind 9 quotes via `q`, kind 1111 replies via `e` (last wins)
      const ref = lastTagValue(
        r,
        r.kind === KIND_CHANNEL_CHAT ? "q" : "e",
      );
      let replyTo: string | undefined;
      if (ref) {
        const parent = resolve(ref);
        const parentIndex = parent ? indexByRumorId.get(parent.id) : undefined;
        if (parent && parentIndex !== undefined) {
          if (parentIndex < index) {
            replyTo = lineIdByRumorId.get(parent.id);
          } else {
            warnings.push(
              `rumor ${r.id.slice(0, 8)}… の参照先が自身より後のためルート直下に付け替えました`,
            );
          }
        } else if (r.kind === KIND_CHANNEL_COMMENT) {
          // a dangling q is just a quote; a dangling e loses a parent
          warnings.push(
            `rumor ${r.id.slice(0, 8)}… の親参照が収集セットに無いためルート直下に付け替えました`,
          );
        }
      }
      return {
        id: lineIdByRumorId.get(r.id)!,
        personaId: personaByPubkey.get(r.pubkey)!,
        content: r.content,
        offsetSec: r.created_at - baseTimeSec,
        ...(replyTo ? { replyTo } : {}),
      };
    }),
  ];

  warnings.push(
    "ルートは合成です。再発行は新規 kind 11 スレッドとして行われます",
  );

  const script: TalkScript = {
    version: TALK_SCRIPT_VERSION,
    id: newId(),
    title: channelTitle(channel),
    baseTimeSec,
    personas,
    lines,
  };
  return { script, warnings };
}

/**
 * Fetch a channel's wraps with the shared fetchRumors pipeline and build
 * a TalkScript. Transport errors and unopenable wraps surface honestly.
 */
export async function importFromChannel(
  channel: ChannelCoordinate,
  relays: string[],
  fetch: FetchWraps,
  options?: FetchRumorsOptions,
): Promise<ImportResult> {
  let streamPk: string;
  try {
    streamPk = deriveChannelStream(channel).pk;
  } catch (error) {
    throw new ImportError(
      `チャンネル座標が不正です: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const result = await fetchRumors(channel, relays, fetch, options);
  if (result.rumors.size === 0) {
    const suffix =
      result.errors.length > 0
        ? `（${result.errors.length} 件の wrap は開封に失敗しました）`
        : "";
    throw new ImportError(
      `チャンネルに開封できた rumor がありません${suffix}`,
    );
  }

  const { script, warnings } = scriptFromChannel(
    result.rumors.values(),
    channel,
    streamPk,
  );
  if (result.errors.length > 0)
    warnings.push(
      `開封できなかった wrap が ${result.errors.length} 件ありました（取り込み対象外です）`,
    );
  if (result.mayHaveMore)
    warnings.push(
      "履歴がページ上限に達したため、古い rumor が未取得の可能性があります",
    );
  if (result.saturatedSecond !== undefined)
    warnings.push(
      "同一秒に大量の wrap があるため一部未読の可能性があります",
    );

  return { script, warnings, relays: dedupeRelays(relays) };
}
