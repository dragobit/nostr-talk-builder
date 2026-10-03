/**
 * Concord channel stream key derivation — mirrors CORD-02 Appendix A (frozen)
 * as implemented by armada `src/concord/lib/derive.ts`:
 *
 *   HKDF-SHA256(ikm = channelKey[32], salt = ∅, info, L = 32)
 *   info = utf8("concord/channel") || 0x00 || channelId[32] || epoch_u64be
 *
 * The derived secret key is the channel's stream identity: its x-only pubkey
 * is the stream address (the wrap `author`), and the NIP-44 self-ECDH
 * conversation key encrypts every envelope layer.
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { getConversationKey } from "nostr-tools/nip44";

export class ConcordError extends Error {}

const LABEL_CHANNEL = "concord/channel";
const ASCII = new TextEncoder();
const U64_MAX = (1n << 64n) - 1n;

/** A channel's stream keypair + NIP-44 conversation key. */
export interface ChannelStream {
  /** Derived secp256k1 secret key (signs the channel's wraps). */
  sk: Uint8Array;
  /** x-only pubkey hex — the stream's public address (wrap `author`). */
  pk: string;
  /** NIP-44 conversation key (self-ECDH) encrypting wrap and seal. */
  convKey: Uint8Array;
}

/** A freshly minted channel coordinate (all values random / zero). */
export interface MintedChannel {
  channelId: string;
  channelKey: string;
  epoch: number;
}

function hex32(name: string, hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new ConcordError(`${name} must be 64-char hex`);
  }
  return hexToBytes(trimmed.toLowerCase());
}

function toEpoch(epoch: number | bigint | string): bigint {
  if (typeof epoch === "string") {
    const trimmed = epoch.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new ConcordError(`epoch must be a non-negative integer`);
    }
    epoch = BigInt(trimmed);
  }
  if (typeof epoch === "number") {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new ConcordError(`epoch must be a non-negative integer`);
    }
    epoch = BigInt(epoch);
  }
  if (epoch < 0n || epoch > U64_MAX) {
    throw new ConcordError(`epoch out of u64 range`);
  }
  return epoch;
}

/** `utf8(label) || 0x00 || id[32] || epoch_u64be` — epoch always present here. */
function buildInfo(label: string, id32: Uint8Array, epoch: bigint): Uint8Array {
  if (id32.length !== 32) throw new ConcordError("id must be 32 bytes");
  const labelBytes = ASCII.encode(label);
  const out = new Uint8Array(labelBytes.length + 1 + 32 + 8);
  out.set(labelBytes, 0);
  out.set(id32, labelBytes.length + 1);
  new DataView(out.buffer).setBigUint64(
    labelBytes.length + 1 + 32,
    epoch,
    false,
  );
  return out;
}

/** HKDF-SHA256, zero-length salt, 32-byte output (armada `hkdf32`). */
function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

/**
 * Reduce an hkdf seed to a valid secp256k1 secret key: on an invalid scalar
 * (~2^-128) append an incrementing counter byte to the info and retry — the
 * A.3 convention, so any conforming implementation derives the same key.
 */
function hkdfToSecretKey(ikm: Uint8Array, baseInfo: Uint8Array): Uint8Array {
  const seed = hkdf32(ikm, baseInfo);
  if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  for (let counter = 0; counter <= 0xff; counter++) {
    const info = new Uint8Array(baseInfo.length + 1);
    info.set(baseInfo, 0);
    info[baseInfo.length] = counter;
    const retry = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(retry)) return retry;
  }
  throw new ConcordError("scalar rejection 257 times running is impossible");
}

/**
 * Derive a channel's chat-plane stream key from its coordinate:
 * the channel key is the IKM, the channel id + epoch the HKDF info.
 * (Private-channel shape: keyed by the channel's own key, not a community root.)
 */
export function deriveChannelStream(params: {
  channelIdHex: string;
  channelKeyHex: string;
  epoch: number | bigint | string;
}): ChannelStream {
  const channelId = hex32("channelId", params.channelIdHex);
  const channelKey = hex32("channelKey", params.channelKeyHex);
  const epoch = toEpoch(params.epoch);
  const sk = hkdfToSecretKey(
    channelKey,
    buildInfo(LABEL_CHANNEL, channelId, epoch),
  );
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  return { sk, pk, convKey: getConversationKey(sk, pk) };
}

/** Mint a fresh channel: random 32-byte id + key, epoch 0. */
export function mintChannel(): MintedChannel {
  return {
    channelId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    channelKey: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    epoch: 0,
  };
}
