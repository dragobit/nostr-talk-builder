import type { NostrEvent } from "nostr-tools";
import type { DraftEvent } from "./types";

/** Serialize IR events as JSONL — one JSON event object per line. */
export function dumpEventsJsonl(
  events: (DraftEvent | NostrEvent)[],
): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}
