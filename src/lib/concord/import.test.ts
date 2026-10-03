import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  type NostrEvent,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { compileScript } from "../talkscript/compile";
import { ImportError } from "../talkscript/importer";
import { signTalk } from "../talkscript/sign";
import { TALK_SCRIPT_VERSION, type TalkScript } from "../talkscript/types";
import { deriveChannelStream } from "./derive";
import {
  buildRumor,
  sealRumor,
  wrapSeal,
  type Rumor,
} from "./envelope";
import {
  importFromChannel,
  scriptFromChannel,
  SYNTHETIC_ROOT_CONTENT,
} from "./import";
import { canonicalRumorId, type FetchWraps } from "./read";

const SK_A = hexToBytes("a".repeat(64));
const SK_B = hexToBytes("b".repeat(64));
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);

const CHANNEL_ID = "11".repeat(32);
const CHANNEL_KEY = "22".repeat(32);
const channel = {
  channelIdHex: CHANNEL_ID,
  channelKeyHex: CHANNEL_KEY,
  epoch: 0,
};
const streamPk = deriveChannelStream(channel).pk;

/** IR event → rumor for this channel (the app-minted shape). */
function rumorize(ir: NostrEvent): Rumor {
  return buildRumor(ir, channel.channelIdHex, BigInt(channel.epoch));
}

/** App-minted fixture: signed canonical IR → rumors (e/E refs point at
 * canonical ids, exactly like the M4c publish path). */
function threadFixture(): { script: TalkScript; irs: NostrEvent[]; rumors: Rumor[] } {
  const script: TalkScript = {
    version: TALK_SCRIPT_VERSION,
    id: "s",
    title: "チャンネルスレッド",
    baseTimeSec: 1_700_000_000,
    personas: [
      { id: "pa", name: "A", key: "a".repeat(64), pubkey: PK_A },
      { id: "pb", name: "B", key: "b".repeat(64), pubkey: PK_B },
    ],
    lines: [
      { id: "l1", personaId: "pa", content: "root line", offsetSec: 0 },
      {
        id: "l2",
        personaId: "pb",
        content: "reply line",
        offsetSec: 60,
        replyTo: "l1",
      },
      {
        id: "l3",
        personaId: "pa",
        content: "nested line",
        offsetSec: 120,
        replyTo: "l2",
      },
    ],
  };
  const compiled = compileScript(script);
  const { events } = signTalk(script, compiled);
  return { script, irs: events, rumors: events.map(rumorize) };
}

describe("scriptFromChannel — kind 11 root present", () => {
  it("rebuilds the thread via the canonical-id path (round-trip ids)", () => {
    const { script: src, irs, rumors } = threadFixture();
    const { script, warnings } = scriptFromChannel(rumors, channel, streamPk);

    expect(script.title).toBe(src.title);
    expect(script.baseTimeSec).toBe(src.baseTimeSec);
    expect(script.lines.map((l) => l.content)).toEqual([
      "root line",
      "reply line",
      "nested line",
    ]);
    expect(script.lines[2].replyTo).toBe(script.lines[1].id);
    expect(script.personas.map((p) => p.pubkey)).toEqual([PK_A, PK_B]);
    // canonical recovery: binding tags normalize away, so a recompiled
    // script produces the same canonical event ids as the wrapped IR
    expect(compileScript(script).events.map((e) => e.id)).toEqual(
      irs.map((e) => e.id),
    );
    // provenance + reissue note
    expect(warnings.some((w) => w.includes("ch:11111111"))).toBe(true);
    expect(warnings.some((w) => w.includes("epoch 0"))).toBe(true);
    expect(warnings.some((w) => w.includes("再発行可能"))).toBe(true);
  });

  it("resolves comments whose e/E refs point at rumor ids (native style)", () => {
    const rootRumor = rumorize(
      finalizeEvent(
        { kind: 11, content: "native root", tags: [], created_at: 100 },
        SK_A,
      ),
    );
    // a native Concord comment referencing the rumor id directly
    const child = rumorize(
      finalizeEvent(
        {
          kind: 1111,
          content: "native child",
          tags: [
            ["e", rootRumor.id],
            ["E", rootRumor.id],
          ],
          created_at: 110,
        },
        SK_B,
      ),
    );
    const { script } = scriptFromChannel(
      [rootRumor, child],
      channel,
      streamPk,
    );
    expect(script.lines).toHaveLength(2);
    expect(script.lines[1].content).toBe("native child");
  });

  it("picks the most-referenced kind 11 root and warns about extras", () => {
    const rootA = rumorize(
      finalizeEvent(
        { kind: 11, content: "root A", tags: [], created_at: 100 },
        SK_A,
      ),
    );
    const rootB = rumorize(
      finalizeEvent(
        { kind: 11, content: "root B", tags: [], created_at: 90 },
        SK_B,
      ),
    );
    const comment = rumorize(
      finalizeEvent(
        {
          kind: 1111,
          content: "comment on B",
          tags: [
            ["e", canonicalRumorId(rootB)],
            ["E", canonicalRumorId(rootB)],
          ],
          created_at: 120,
        },
        SK_A,
      ),
    );
    const { script, warnings } = scriptFromChannel(
      [rootA, rootB, comment],
      channel,
      streamPk,
    );
    expect(script.lines.map((l) => l.content)).toEqual([
      "root B",
      "comment on B",
    ]);
    expect(warnings.some((w) => w.includes("ルート候補が 2 件"))).toBe(true);
    // the losing root lands in the skipped aggregate
    expect(warnings.some((w) => w.includes("kind 11×1"))).toBe(true);
  });

  it("reports non-thread rumors as skipped (kind 9 + others)", () => {
    const { rumors } = threadFixture();
    const chat = rumorize(
      finalizeEvent(
        { kind: 9, content: "side chat", tags: [], created_at: 200 },
        SK_B,
      ),
    );
    const reaction = rumorize(
      finalizeEvent(
        { kind: 7, content: "+", tags: [], created_at: 210 },
        SK_B,
      ),
    );
    const { warnings } = scriptFromChannel(
      [...rumors, chat, reaction],
      channel,
      streamPk,
    );
    expect(
      warnings.some(
        (w) => w.includes("kind 9×1") && w.includes("kind 7×1"),
      ),
    ).toBe(true);
  });
});

describe("scriptFromChannel — no kind 11 root (synthetic root)", () => {
  const chatRumor = (
    content: string,
    key: Uint8Array,
    created_at: number,
    tags: string[][] = [],
  ): Rumor =>
    rumorize(
      finalizeEvent({ kind: 9, content, tags, created_at }, key),
    );

  it("synthesizes a root line owned by the channel stream persona", () => {
    const first = chatRumor("older", SK_A, 100);
    const second = chatRumor("newer", SK_B, 160);
    const { script, warnings } = scriptFromChannel(
      [second, first],
      channel,
      streamPk,
    );

    expect(script.title).toBe("Concord ch:11111111");
    expect(script.baseTimeSec).toBe(100);
    expect(script.lines).toHaveLength(3);
    expect(script.lines[0].content).toBe(SYNTHETIC_ROOT_CONTENT);
    expect(script.lines[0].offsetSec).toBe(0);
    // the synthetic root's persona is the stream identity — a pubkey-only
    // persona nobody can sign for (always a fork)
    expect(script.personas[0].pubkey).toBe(streamPk);
    expect(script.personas[0].key).toBeUndefined();
    expect(script.lines[1].content).toBe("older");
    expect(script.lines[1].offsetSec).toBe(0);
    expect(script.lines[2].content).toBe("newer");
    expect(script.lines[2].offsetSec).toBe(60);
    expect(warnings.some((w) => w.includes("ルートは合成"))).toBe(true);
    expect(warnings.some((w) => w.includes("kind 11"))).toBe(true);
    // compiles into a valid kind 11 + 1111 event set
    expect(() => compileScript(script)).not.toThrow();
  });

  it("maps q tags to replyTo when the parent is in the collected set", () => {
    const parent = chatRumor("quoted", SK_A, 100);
    const child = chatRumor("quoting", SK_B, 130, [["q", parent.id]]);
    const orphan = chatRumor("dangling quote", SK_A, 150, [
      ["q", "d".repeat(64)],
    ]);
    const { script, warnings } = scriptFromChannel(
      [parent, child, orphan],
      channel,
      streamPk,
    );
    const byContent = new Map(script.lines.map((l) => [l.content, l]));
    expect(byContent.get("quoting")!.replyTo).toBe(
      byContent.get("quoted")!.id,
    );
    // a dangling q is just a quote — kept as a flat line without warning
    expect(byContent.get("dangling quote")!.replyTo).toBeUndefined();
    expect(
      warnings.filter((w) => w.includes("収集セットに無い")),
    ).toHaveLength(0);
  });

  it("resolves q refs written against canonical ids too", () => {
    const parent = chatRumor("canonical parent", SK_A, 100);
    const child = chatRumor("canonical quoting", SK_B, 130, [
      ["q", canonicalRumorId(parent)],
    ]);
    const { script } = scriptFromChannel([parent, child], channel, streamPk);
    const byContent = new Map(script.lines.map((l) => [l.content, l]));
    expect(byContent.get("canonical quoting")!.replyTo).toBe(
      byContent.get("canonical parent")!.id,
    );
  });

  it("maps kind 1111 e parents and warns on dangling parents", () => {
    const parent = rumorize(
      finalizeEvent(
        { kind: 1111, content: "rootless 1111", tags: [], created_at: 100 },
        SK_A,
      ),
    );
    const child = rumorize(
      finalizeEvent(
        {
          kind: 1111,
          content: "child 1111",
          tags: [["e", parent.id]],
          created_at: 130,
        },
        SK_B,
      ),
    );
    const dangling = rumorize(
      finalizeEvent(
        {
          kind: 1111,
          content: "dangling 1111",
          tags: [["e", "e".repeat(64)]],
          created_at: 140,
        },
        SK_B,
      ),
    );
    const { script, warnings } = scriptFromChannel(
      [parent, child, dangling],
      channel,
      streamPk,
    );
    const byContent = new Map(script.lines.map((l) => [l.content, l]));
    expect(byContent.get("child 1111")!.replyTo).toBe(
      byContent.get("rootless 1111")!.id,
    );
    expect(byContent.get("dangling 1111")!.replyTo).toBeUndefined();
    expect(warnings.some((w) => w.includes("収集セットに無い"))).toBe(true);
  });

  it("warns about skipped kinds and keeps just the synthetic root if nothing is a row", () => {
    const onlyReaction = rumorize(
      finalizeEvent(
        { kind: 7, content: "+", tags: [], created_at: 50 },
        SK_A,
      ),
    );
    const { script, warnings } = scriptFromChannel(
      [onlyReaction],
      channel,
      streamPk,
    );
    expect(script.lines).toHaveLength(1);
    expect(script.lines[0].content).toBe(SYNTHETIC_ROOT_CONTENT);
    expect(script.baseTimeSec).toBe(50);
    expect(warnings.some((w) => w.includes("kind 7×1"))).toBe(true);
  });

  it("throws ImportError on an empty store", () => {
    expect(() => scriptFromChannel([], channel, streamPk)).toThrow(
      ImportError,
    );
  });
});

describe("importFromChannel", () => {
  const wrapIr = (ir: Omit<NostrEvent, "id" | "sig" | "pubkey">, sk: Uint8Array) => {
    const s = deriveChannelStream(channel);
    const signed = finalizeEvent(ir, sk);
    const rumor = buildRumor(signed, channel.channelIdHex, BigInt(channel.epoch));
    return wrapSeal(sealRumor(rumor, s, sk), s);
  };

  it("fetches, opens, and folds wraps through the shared pipeline", async () => {
    const wraps = [
      wrapIr({ kind: 9, content: "hello", tags: [], created_at: 100 }, SK_A),
      wrapIr({ kind: 9, content: "world", tags: [], created_at: 160 }, SK_B),
    ];
    const fetch: FetchWraps = async () => wraps;
    const { script, warnings, relays } = await importFromChannel(
      channel,
      ["wss://nos.lol"],
      fetch,
    );
    expect(script.lines.map((l) => l.content)).toEqual([
      SYNTHETIC_ROOT_CONTENT,
      "hello",
      "world",
    ]);
    expect(relays).toEqual(["wss://nos.lol/"]);
    expect(warnings.some((w) => w.includes("ルートは合成"))).toBe(true);
  });

  it("surfaces unopenable wraps as a warning count", async () => {
    const good = wrapIr(
      { kind: 9, content: "good", tags: [], created_at: 100 },
      SK_A,
    );
    // wrap author is not the channel stream key → unwrap fails
    const broken = { ...good, pubkey: PK_B, id: "f".repeat(64) };
    const fetch: FetchWraps = async () => [good, broken];
    const { warnings } = await importFromChannel(
      channel,
      ["wss://nos.lol"],
      fetch,
    );
    expect(warnings.some((w) => w.includes("開封できなかった wrap が 1 件"))).toBe(
      true,
    );
  });

  it("throws ImportError when nothing opens", async () => {
    const fetch: FetchWraps = async () => [];
    await expect(
      importFromChannel(channel, ["wss://nos.lol"], fetch),
    ).rejects.toThrow(ImportError);
    await expect(
      importFromChannel(channel, ["wss://nos.lol"], fetch),
    ).rejects.toThrow(/rumor がありません/);
  });

  it("warns when history hit the page cap", async () => {
    const wrap = wrapIr(
      { kind: 9, content: "x", tags: [], created_at: 100 },
      SK_A,
    );
    // every page returns a full page → fetchRumors keeps paging until cap
    const fetch: FetchWraps = async () => [wrap, { ...wrap, id: getEventHash({...wrap, content: "dup"} as NostrEvent) }];
    const { warnings } = await importFromChannel(
      channel,
      ["wss://nos.lol"],
      fetch,
      { pageSize: 2, maxPages: 3 },
    );
    expect(warnings.some((w) => w.includes("ページ上限"))).toBe(true);
  });

  it("rejects an invalid coordinate as ImportError", async () => {
    const fetch: FetchWraps = async () => [];
    await expect(
      importFromChannel(
        { channelIdHex: "not-hex", channelKeyHex: CHANNEL_KEY, epoch: 0 },
        ["wss://nos.lol"],
        fetch,
      ),
    ).rejects.toThrow(/チャンネル座標が不正/);
  });
});
