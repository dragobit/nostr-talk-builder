import type { NostrEvent } from "nostr-tools";
import { compileScript } from "./compile";
import {
  aggregateResults,
  createIssueRecord,
  getIssuePreset,
  publishToRelays,
  type IssueRecord,
  type PublishFn,
  type PublishOutcome,
} from "./issue";
import { personaCanSign } from "./keys";
import { signTalk } from "./sign";
import type { TalkScript } from "./types";

export class ReissueError extends Error {}

/**
 * Why a history record cannot be re-sent right now; null when it can.
 * Re-sending only covers plain, unbound issuances — bound presets and
 * envelopes (NIP-29 h / wraps) are future scope.
 */
export function resendBlockReason(
  script: TalkScript,
  record: IssueRecord,
): string | null {
  const preset = getIssuePreset(record.preset);
  if (!preset)
    return `プリセット "${record.preset}" は現在のバージョンに存在しません`;
  if (preset.bindings.length > 0 || record.bindings.length > 0)
    return "束縛 (bindings) 付きの発行の再送信は未対応です";
  if (record.envelope !== "plain")
    return "envelope 付きの発行の再送信は未対応です";
  // no-publisher presets never produce records in practice, but a stored
  // one would resend to zero relays and record a bogus all-ok outcome
  if (!preset.publishes || record.relays.length === 0)
    return "送信先リレーのない発行は再送信できません";

  const personas = new Map(script.personas.map((p) => [p.id, p]));
  const missing = new Set<string>();
  for (const line of script.lines) {
    const persona = personas.get(line.personaId);
    if (!persona || !personaCanSign(persona))
      missing.add(persona?.name ?? line.personaId);
  }
  if (missing.size > 0)
    return `署名用の鍵を持たないペルソナがあります: ${[...missing].join(", ")}`;

  return null;
}

export interface ReissueResult {
  /** The new IssueRecord to append to script.issues. */
  record: IssueRecord;
  /** Full per-relay outcome of the resend. */
  outcome: PublishOutcome;
  /** Signed events that were sent (callers may add them to the store). */
  events: NostrEvent[];
  /** True when the re-sent root id differs from the source record's. */
  rootChanged: boolean;
}

/**
 * Re-send a past issuance: recompile the canonical IR, sign every line
 * with the personas' held keys, publish to the original record's relays,
 * and build the new IssueRecord (preset/relays inherited; rootId records
 * the re-sent root — rootChanged flags when it drifted from the original).
 */
export async function reissueRecord(
  script: TalkScript,
  record: IssueRecord,
  publish: PublishFn,
): Promise<ReissueResult> {
  const blocked = resendBlockReason(script, record);
  if (blocked) throw new ReissueError(blocked);

  const compiled = compileScript(script);
  const { events, skippedLineIds } = signTalk(script, compiled);
  if (skippedLineIds.length > 0)
    throw new ReissueError(
      `鍵を持たない行が ${skippedLineIds.length} 件あるため送信できません`,
    );

  const outcome = await publishToRelays(events, record.relays, publish);
  const rootId = compiled.events[0].id;
  const rootChanged = record.rootId !== undefined && record.rootId !== rootId;

  // resend only runs when bindings/envelope are at defaults, but copy the
  // issuance-channel fields through so the new record describes the same run
  const newRecord = createIssueRecord({
    preset: record.preset,
    bindings: record.bindings,
    envelope: record.envelope,
    params: record.params,
    relays: record.relays,
    rootId,
    results: aggregateResults(outcome),
  });

  return { record: newRecord, outcome, events, rootChanged };
}
