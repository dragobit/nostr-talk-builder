import type { NostrEvent } from "nostr-tools";
import type { IssueRecord } from "./issue";

export const TALK_SCRIPT_VERSION = 1;

export interface Persona {
  id: string;
  name: string;
  /**
   * Secret key held by the app for batch signing: `nsec1...` or 64-char hex.
   * Empty means the key lives elsewhere (bunker, hardware) — draft lines stay
   * unsigned until a signer is provided.
   */
  key?: string;
  /** Expected pubkey (hex) for personas whose key is not held in the app. */
  pubkey?: string;
}

export interface ScriptLine {
  id: string;
  personaId: string;
  content: string;
  /** Seconds after `TalkScript.baseTimeSec`. */
  offsetSec: number;
  /** Line id this line replies to; omitted means "reply to the root post". */
  replyTo?: string;
}

export interface TalkScript {
  version: number;
  id: string;
  /** Becomes the kind 11 `subject` tag. */
  title: string;
  /** Absolute unix seconds the line offsets are anchored to. */
  baseTimeSec: number;
  personas: Persona[];
  /** lines[0] is the root post (kind 11); the rest compile to kind 1111. */
  lines: ScriptLine[];
  /** Issuance receipts (M3a) — additive optional field, version stays 1. */
  issues?: IssueRecord[];
}

/** A deterministic unsigned event: the id is final, only `sig` is missing. */
export type DraftEvent = Omit<NostrEvent, "sig">;

export interface CompiledTalk {
  /** Event keyed by script line id — lines[0] maps to the kind 11 root. */
  byLineId: Record<string, DraftEvent>;
  /** All events in script order, root first. */
  events: DraftEvent[];
}
