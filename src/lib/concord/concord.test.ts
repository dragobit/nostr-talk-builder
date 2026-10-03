import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  nip44,
  type NostrEvent,
} from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import {
  channelBindingTags,
  checkChannelBinding,
  buildRumor,
  openWrap,
  sealRumor,
  wrapSeal,
  KIND_SEAL_ENCRYPTED,
  KIND_WRAP,
  type Rumor,
} from "./envelope";
import { deriveChannelStream, mintChannel } from "./derive";

const SK_A = hexToBytes("a".repeat(64));
const SK_B = hexToBytes("b".repeat(64));
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);

const CHANNEL_ID = "11".repeat(32);
const CHANNEL_KEY = "22".repeat(32);

function irEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "f".repeat(64),
    sig: "e".repeat(128),
    kind: 1111,
    pubkey: PK_A,
    created_at: 1_700_000_000,
    tags: [
      ["e", "root-id"],
      ["K", "11"],
    ],
    content: "hello",
    ...overrides,
  };
}

function stream() {
  return deriveChannelStream({
    channelIdHex: CHANNEL_ID,
    channelKeyHex: CHANNEL_KEY,
    epoch: 0,
  });
}

describe("deriveChannelStream", () => {
  it("matches an independent HKDF-SHA256 oracle for the derived sk", () => {
    // info = utf8("concord/channel") || 0x00 || channelId[32] || epoch_u64be
    const info = new Uint8Array("concord/channel".length + 1 + 32 + 8);
    info.set(new TextEncoder().encode("concord/channel"), 0);
    info.set(hexToBytes(CHANNEL_ID), "concord/channel".length + 1);
    new DataView(info.buffer).setBigUint64(
      "concord/channel".length + 1 + 32,
      0n,
      false,
    );
    const expectedSk = hkdfSync(
      "sha256",
      Buffer.from(hexToBytes(CHANNEL_KEY)),
      Buffer.alloc(0),
      Buffer.from(info),
      32,
    );
    const s = stream();
    expect(bytesToHex(s.sk)).toBe(Buffer.from(expectedSk).toString("hex"));
    expect(s.pk).toBe(getPublicKey(s.sk));
    expect(s.convKey).toHaveLength(32);
  });

  it("is deterministic per (channelId, channelKey, epoch) and epoch-sensitive", () => {
    const a = stream();
    const again = stream();
    expect(a.pk).toBe(again.pk);
    const otherEpoch = deriveChannelStream({
      channelIdHex: CHANNEL_ID,
      channelKeyHex: CHANNEL_KEY,
      epoch: 1,
    });
    expect(otherEpoch.pk).not.toBe(a.pk);
    const otherId = deriveChannelStream({
      channelIdHex: "33".repeat(32),
      channelKeyHex: CHANNEL_KEY,
      epoch: 0,
    });
    expect(otherId.pk).not.toBe(a.pk);
  });

  it("accepts decimal-string epochs and rejects malformed input", () => {
    const byString = deriveChannelStream({
      channelIdHex: CHANNEL_ID,
      channelKeyHex: CHANNEL_KEY,
      epoch: "7",
    });
    const byNumber = deriveChannelStream({
      channelIdHex: CHANNEL_ID,
      channelKeyHex: CHANNEL_KEY,
      epoch: 7,
    });
    expect(byString.pk).toBe(byNumber.pk);
    expect(() =>
      deriveChannelStream({
        channelIdHex: "zz".repeat(32),
        channelKeyHex: CHANNEL_KEY,
        epoch: 0,
      }),
    ).toThrow(/64-char hex/);
    expect(() =>
      deriveChannelStream({
        channelIdHex: CHANNEL_ID,
        channelKeyHex: CHANNEL_KEY,
        epoch: "abc",
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      deriveChannelStream({
        channelIdHex: CHANNEL_ID,
        channelKeyHex: CHANNEL_KEY,
        epoch: "-1",
      }),
    ).toThrow(/non-negative integer/);
  });
});

describe("mintChannel", () => {
  it("returns a random 64-hex channelId/channelKey at epoch 0", () => {
    const minted = mintChannel();
    expect(minted.channelId).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.channelKey).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.epoch).toBe(0);
    expect(mintChannel().channelId).not.toBe(minted.channelId);
  });
});

describe("buildRumor", () => {
  it("drops the sig, appends channel/epoch tags, and re-hashes the id", () => {
    const ir = irEvent();
    const rumor = buildRumor(ir, CHANNEL_ID, 0n);
    expect("sig" in rumor).toBe(false);
    expect(rumor.tags.slice(-2)).toEqual([
      ["channel", CHANNEL_ID],
      ["epoch", "0"],
    ]);
    expect(rumor.id).toBe(getEventHash(rumor as NostrEvent));
    expect(rumor.id).not.toBe(ir.id);
    // non-binding fields pass through untouched
    expect(rumor.tags.slice(0, -2)).toEqual(ir.tags);
    expect(rumor.created_at).toBe(ir.created_at);
    expect(rumor.content).toBe(ir.content);
  });
});

describe("envelope round-trip", () => {
  function wrapAll(irs: NostrEvent[], keys: Map<string, Uint8Array>) {
    const s = stream();
    return irs.map((ir) => {
      const rumor = buildRumor(ir, CHANNEL_ID, 0n);
      const sk = keys.get(rumor.pubkey);
      if (!sk) throw new Error("no key");
      return wrapSeal(sealRumor(rumor, s, sk), s);
    });
  }

  it("builds rumor -> seal -> wrap and opens every wrap back to the rumor", () => {
    const irs = [
      irEvent({ kind: 11, pubkey: PK_A, content: "root post" }),
      irEvent({ kind: 1111, pubkey: PK_B, content: "reply" }),
      irEvent({ kind: 1111, pubkey: PK_A, content: "third" }),
    ];
    const keys = new Map([
      [PK_A, SK_A],
      [PK_B, SK_B],
    ]);
    const s = stream();
    const wraps = wrapAll(irs, keys);
    expect(wraps).toHaveLength(3);

    const rumors = irs.map((ir) => buildRumor(ir, CHANNEL_ID, 0n));
    for (const [i, wrap] of wraps.entries()) {
      expect(wrap.kind).toBe(KIND_WRAP);
      expect(wrap.pubkey).toBe(s.pk);
      // decoy p tag: a real pubkey that is neither the stream nor an author
      expect(wrap.tags).toHaveLength(1);
      expect(wrap.tags[0][0]).toBe("p");
      expect(wrap.tags[0][1]).toMatch(/^[0-9a-f]{64}$/);
      expect([s.pk, PK_A, PK_B]).not.toContain(wrap.tags[0][1]);
      // NIP-17-style jitter: at most 2 days in the past, never the future
      const now = Math.floor(Date.now() / 1000);
      expect(wrap.created_at).toBeLessThanOrEqual(now);
      expect(wrap.created_at).toBeGreaterThanOrEqual(now - 172800);

      const opened = openWrap(wrap, s);
      expect(opened.rumor).toEqual(rumors[i]);
      expect(opened.seal.kind).toBe(KIND_SEAL_ENCRYPTED);
      expect(opened.seal.created_at).toBe(rumors[i].created_at);
      checkChannelBinding(opened.rumor, CHANNEL_ID, 0n);
    }
  });

  it("is deterministic at the rumor layer and seal envelope structure", () => {
    const ir = irEvent();
    const s = stream();
    const again = deriveChannelStream({
      channelIdHex: CHANNEL_ID,
      channelKeyHex: CHANNEL_KEY,
      epoch: 0,
    });
    const rumor1 = buildRumor(ir, CHANNEL_ID, 0n);
    const rumor2 = buildRumor(ir, CHANNEL_ID, 0n);
    expect(rumor1).toEqual(rumor2);
    // seal content carries a random NIP-44 nonce, so the ciphertext (and id)
    // differs every run — the envelope structure and plaintext do not
    const seal1 = sealRumor(rumor1, s, SK_A);
    const seal2 = sealRumor(rumor2, again, SK_A);
    expect({ ...seal1, content: "", id: "", sig: "" }).toEqual({
      ...seal2,
      content: "",
      id: "",
      sig: "",
    });
    expect(nip44.decrypt(seal1.content, s.convKey)).toBe(
      nip44.decrypt(seal2.content, s.convKey),
    );
  });

  it("rejects a wrap when opened with the wrong stream key", () => {
    const s = stream();
    const rumor = buildRumor(irEvent(), CHANNEL_ID, 0n);
    const wrap = wrapSeal(sealRumor(rumor, s, SK_A), s);
    const wrongStream = deriveChannelStream({
      channelIdHex: CHANNEL_ID,
      channelKeyHex: "44".repeat(32),
      epoch: 0,
    });
    expect(() => openWrap(wrap, wrongStream)).toThrow(/stream's address/);
  });

  it("rejects tampered wrap and seal contents", () => {
    const s = stream();
    const rumor = buildRumor(irEvent(), CHANNEL_ID, 0n);
    const seal = sealRumor(rumor, s, SK_A);
    const wrap = wrapSeal(seal, s);

    const tamperedWrap: NostrEvent = {
      ...wrap,
      content: `${wrap.content.slice(0, -2)}aa`,
    };
    expect(() => openWrap(tamperedWrap, s)).toThrow();

    // a wrap carrying a different stream's seal is unopenable
    const other = deriveChannelStream({
      channelIdHex: "55".repeat(32),
      channelKeyHex: CHANNEL_KEY,
      epoch: 0,
    });
    const foreignSeal = sealRumor(rumor, other, SK_A);
    const foreignWrap = wrapSeal(foreignSeal, s); // wrapped by s, sealed under other
    expect(() => openWrap(foreignWrap, s)).toThrow();
  });

  it("rejects a re-seal: rumor author must equal the seal signer", () => {
    // hand-craft a B-signed seal over A's rumor (sealRumor refuses to)
    const s = stream();
    const rumor = buildRumor(irEvent({ pubkey: PK_A }), CHANNEL_ID, 0n);
    const { encrypt } = nip44;
    const forgedSeal = finalizeEvent(
      {
        kind: KIND_SEAL_ENCRYPTED,
        content: encrypt(JSON.stringify(rumor), s.convKey),
        tags: [],
        created_at: rumor.created_at,
      },
      SK_B,
    );
    const forgedWrap = wrapSeal(forgedSeal, s);
    expect(() => openWrap(forgedWrap, s)).toThrow(
      /does not match the seal's signer/,
    );
  });

  it("rejects a seal signed by a different key than the rumor author", () => {
    const s = stream();
    const rumor = buildRumor(irEvent({ pubkey: PK_A }), CHANNEL_ID, 0n);
    expect(() => sealRumor(rumor, s, SK_B)).toThrow(/seal signer/);
  });
});

describe("checkChannelBinding", () => {
  it("passes on match, rejects channel/epoch mismatch and duplicates", () => {
    const rumor = buildRumor(irEvent(), CHANNEL_ID, 3n);
    expect(() => checkChannelBinding(rumor, CHANNEL_ID, 3n)).not.toThrow();
    expect(() => checkChannelBinding(rumor, "66".repeat(32), 3n)).toThrow(
      /channel-binding/,
    );
    expect(() => checkChannelBinding(rumor, CHANNEL_ID, 4n)).toThrow(
      /epoch-binding/,
    );
    const dup: Pick<Rumor, "tags"> = {
      tags: [
        ...channelBindingTags(CHANNEL_ID, 3n),
        ["channel", "77".repeat(32)],
      ],
    };
    expect(() => checkChannelBinding(dup, CHANNEL_ID, 3n)).toThrow(
      /duplicate binding tag/,
    );
  });
});
