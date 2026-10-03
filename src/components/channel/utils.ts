import { nip19 } from "nostr-tools";

/**
 * Prefill handed to the channel-open dialog (e.g. from an IssueHistoryView
 * concord record — channelKey is never persisted, so it is re-entered).
 */
export interface ChannelPrefill {
  channelId?: string;
  epoch?: string;
  /** Relays the channel was published to; defaults to the stored list. */
  relays?: string[];
}

/** Short npub label for a rumor author (same convention as the importer). */
export function shortNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey).slice(0, 12);
  } catch {
    return pubkey.slice(0, 12);
  }
}
