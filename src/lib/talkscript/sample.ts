import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { TalkScript } from "./types";
import { TALK_SCRIPT_VERSION } from "./types";

export function newId(): string {
  return crypto.randomUUID();
}

function newPersona(name: string) {
  const secretKey = generateSecretKey();
  return {
    id: newId(),
    name,
    key: nip19.nsecEncode(secretKey),
    pubkey: getPublicKey(secretKey),
  };
}

/** Two-persona demo script used as the initial app state. */
export function createSampleScript(): TalkScript {
  const alice = newPersona("アリス");
  const bob = newPersona("ボブ");
  const baseTimeSec = Math.floor(Date.now() / 1000) - 3600;

  const l1 = newId();
  const l2 = newId();
  const l3 = newId();
  const l4 = newId();

  return {
    version: TALK_SCRIPT_VERSION,
    id: newId(),
    title: "週末の計画",
    baseTimeSec,
    personas: [alice, bob],
    lines: [
      {
        id: l1,
        personaId: alice.id,
        content: "今週末どこか行く?",
        offsetSec: 0,
      },
      {
        id: l2,
        personaId: bob.id,
        content: "海か山で迷ってる。予報はどう?",
        offsetSec: 120,
        replyTo: l1,
      },
      {
        id: l3,
        personaId: alice.id,
        content: "土曜は晴れ、日曜は午後から雨らしい",
        offsetSec: 240,
        replyTo: l2,
      },
      {
        id: l4,
        personaId: bob.id,
        content: "じゃあ土曜の海で決まりだな",
        offsetSec: 420,
        replyTo: l3,
      },
    ],
  };
}
