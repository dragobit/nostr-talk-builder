import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import type { Persona } from "./types";

/** Decode an `nsec1...` or 64-char hex secret key into raw bytes. */
export function decodeSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("not an nsec key");
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return hexToBytes(trimmed);
  throw new Error("expected nsec1... or 64-char hex secret key");
}

/** Generate a fresh secret key, returned as an nsec string. */
export function generateSecretKeyNsec(): string {
  return nip19.nsecEncode(generateSecretKey());
}

/**
 * Resolve the pubkey a persona signs with.
 * Prefers the held secret key; falls back to the declared pubkey field.
 */
export function personaPubkey(persona: Persona): string | null {
  if (persona.key?.trim()) {
    try {
      return getPublicKey(decodeSecretKey(persona.key));
    } catch {
      // undecodable key: fall back to the declared pubkey
    }
  }
  const pk = persona.pubkey?.trim();
  return pk && /^[0-9a-f]{64}$/i.test(pk) ? pk.toLowerCase() : null;
}

/** True when the app holds a usable secret key for this persona. */
export function personaCanSign(persona: Persona): boolean {
  return persona.key?.trim() ? isValidSecretKey(persona.key) : false;
}

function isValidSecretKey(input: string): boolean {
  try {
    decodeSecretKey(input);
    return true;
  } catch {
    return false;
  }
}
