/**
 * Concord rumor/seal/wrap envelope — mirrors armada `src/concord/lib/stream.ts`
 * (CORD-01): a NIP-59-reversed gift wrap where the author is the channel's
 * derived stream key and the `p` tag is a decoy, around an encrypted seal
 * signed by the author's real key, around an unsigned rumor:
 *
 *   wrap(kind 1059, signed by stream key, decoy p, randomized created_at)
 *     └ seal(kind 20013, signed by the real persona key)
 *         └ rumor(unsigned IR event + channel/epoch binding tags)
 *
 * Wrap `created_at` is randomized up to 2 days into the past (the NIP-17
 * metadata-reduction convention); rumor/seal keep the IR's own timestamps.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type NostrEvent,
} from "nostr-tools";
import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "nostr-tools/nip44";
import { ConcordError, type ChannelStream } from "./derive";

/** Durable stream wrap (armada KIND_WRAP). */
export const KIND_WRAP = 1059;
/** Encrypted seal — the only seal form chat uses (armada KIND_SEAL_ENCRYPTED). */
export const KIND_SEAL_ENCRYPTED = 20013;

/** NIP-44 hard plaintext cap — enforced before every encrypt (CORD-02 App. B). */
export const NIP44_MAX_PLAINTEXT = 65_535;

/** Wrap created_at is jittered at most this many seconds into the past. */
const WRAP_TIME_SKEW_SECS = 2 * 24 * 60 * 60;

/** An unsigned event plus its content-addressed id (a NIP-59 "rumor"). */
export type Rumor = Omit<NostrEvent, "sig">;

/** The binding tags a channel rumor must commit (CORD-03 §3). */
export function channelBindingTags(
  channelIdHex: string,
  epoch: number | bigint,
): string[][] {
  return [
    ["channel", channelIdHex],
    ["epoch", epoch.toString()],
  ];
}

function encryptChecked(convKey: Uint8Array, plaintext: string): string {
  if (new TextEncoder().encode(plaintext).length > NIP44_MAX_PLAINTEXT) {
    throw new ConcordError("plaintext exceeds the NIP-44 65,535-byte cap");
  }
  return nip44Encrypt(plaintext, convKey);
}

/**
 * Turn a canonical IR event into an unsigned rumor: the signature is dropped,
 * the channel/epoch binding tags are appended, and the id is re-hashed over
 * the bound tags — so a rumor id differs from its IR event's id.
 */
export function buildRumor(
  ir: Pick<NostrEvent, "kind" | "pubkey" | "created_at" | "content" | "tags">,
  channelIdHex: string,
  epoch: number | bigint,
): Rumor {
  const unsigned = {
    kind: ir.kind,
    pubkey: ir.pubkey,
    created_at: ir.created_at,
    content: ir.content,
    tags: [...ir.tags, ...channelBindingTags(channelIdHex, epoch)],
  };
  return { ...unsigned, id: getEventHash(unsigned as NostrEvent) };
}

/**
 * Seal a rumor with the author's real key: kind 20013, rumor JSON NIP-44-
 * encrypted under the stream conversation key, created_at mirroring the
 * rumor. One signer round-trip per send.
 */
export function sealRumor(
  rumor: Rumor,
  stream: ChannelStream,
  signerKey: Uint8Array,
): NostrEvent {
  // openWrap enforces rumor.pubkey === seal.pubkey — fail fast here instead
  // of minting a wrap readers must reject
  if (getPublicKey(signerKey) !== rumor.pubkey) {
    throw new ConcordError("seal signer does not match the rumor author");
  }
  const content = encryptChecked(stream.convKey, JSON.stringify(rumor));
  return finalizeEvent(
    {
      kind: KIND_SEAL_ENCRYPTED,
      content,
      tags: [],
      created_at: rumor.created_at,
    },
    signerKey,
  );
}

/**
 * Wrap a signed seal into the outer stream event: NIP-44 under the stream
 * conversation key, signed by the stream key, random ephemeral `p` (decoy —
 * not a recipient), created_at jittered into the past.
 */
export function wrapSeal(
  seal: NostrEvent,
  stream: ChannelStream,
  opts?: { decoyPubkey?: string; now?: () => number },
): NostrEvent {
  const decoyPubkey = opts?.decoyPubkey ?? getPublicKey(generateSecretKey());
  const now = opts?.now ?? (() => Date.now());
  const created_at =
    Math.floor(now() / 1000) - Math.floor(Math.random() * WRAP_TIME_SKEW_SECS);
  return finalizeEvent(
    {
      kind: KIND_WRAP,
      content: encryptChecked(stream.convKey, JSON.stringify(seal)),
      tags: [["p", decoyPubkey]],
      created_at,
    },
    stream.sk,
  );
}

/**
 * Open and fully verify one channel wrap: wrap author must be the stream
 * address, seal must be kind 20013 with a valid signature, and the rumor's
 * pubkey must equal the seal signer (anti re-seal) with its id re-hashed.
 */
export function openWrap(
  wrap: NostrEvent,
  stream: ChannelStream,
): { rumor: Rumor; seal: NostrEvent } {
  if (wrap.kind !== KIND_WRAP) {
    throw new ConcordError(`not a channel wrap: kind ${wrap.kind}`);
  }
  if (wrap.pubkey !== stream.pk) {
    throw new ConcordError("wrap author is not this stream's address");
  }

  let seal: NostrEvent;
  try {
    seal = JSON.parse(nip44Decrypt(wrap.content, stream.convKey)) as NostrEvent;
  } catch (error) {
    throw new ConcordError(
      `wrap decrypt: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (seal.kind !== KIND_SEAL_ENCRYPTED) {
    throw new ConcordError(`unknown seal kind ${seal.kind}`);
  }
  if (!verifyEvent(seal)) {
    throw new ConcordError("seal signature invalid");
  }

  let rumor: Rumor;
  try {
    rumor = JSON.parse(nip44Decrypt(seal.content, stream.convKey)) as Rumor;
  } catch (error) {
    throw new ConcordError(
      `rumor recover: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (rumor.pubkey !== seal.pubkey) {
    throw new ConcordError("rumor author does not match the seal's signer");
  }
  const expectedId = getEventHash({
    kind: rumor.kind,
    content: rumor.content,
    tags: rumor.tags,
    created_at: rumor.created_at,
    pubkey: rumor.pubkey,
  } as NostrEvent);
  if (rumor.id !== expectedId) {
    throw new ConcordError("rumor id is not its event hash");
  }
  return { rumor, seal };
}

/** Value of a tag required to appear at most once (binding must be unambiguous). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  let found: string | undefined;
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    if (found !== undefined) {
      throw new ConcordError(`duplicate binding tag: ${name}`);
    }
    found = tag[1];
  }
  return found;
}

/**
 * Enforce the channel binding on an opened rumor: the committed channel +
 * epoch must strict-equal the coordinate whose key opened the wrap
 * (anti-splice — armada `checkChannelBinding`).
 */
export function checkChannelBinding(
  rumor: Pick<Rumor, "tags">,
  channelIdHex: string,
  epoch: number | bigint,
): void {
  if (uniqueTag(rumor.tags, "channel") !== channelIdHex) {
    throw new ConcordError("channel-binding mismatch (splice)");
  }
  if (uniqueTag(rumor.tags, "epoch") !== epoch.toString()) {
    throw new ConcordError("epoch-binding mismatch (splice)");
  }
}
