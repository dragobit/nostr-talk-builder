import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  getPublicKey,
  matchFilters,
  nip19,
  verifyEvent,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { compileScript } from "./compile";
import {
  buildScript,
  decodeIdentifier,
  importFromIdentifier,
  ImportError,
  type FetchEvents,
} from "./importer";
import { DEFAULT_PUBLISH_RELAYS } from "./issue";
import { signTalk } from "./sign";
import { TALK_SCRIPT_VERSION, type TalkScript } from "./types";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function fixture(): TalkScript {
  return {
    version: TALK_SCRIPT_VERSION,
    id: "script-1",
    title: "往復テスト会話",
    baseTimeSec: 1_700_000_000,
    personas: [
      {
        id: "pa",
        name: "A",
        key: KEY_A,
        pubkey: getPublicKey(hexToBytes(KEY_A)),
      },
      {
        id: "pb",
        name: "B",
        key: KEY_B,
        pubkey: getPublicKey(hexToBytes(KEY_B)),
      },
    ],
    lines: [
      { id: "l1", personaId: "pa", content: "root post", offsetSec: 0 },
      {
        id: "l2",
        personaId: "pb",
        content: "reply one",
        offsetSec: 60,
        replyTo: "l1",
      },
      {
        id: "l3",
        personaId: "pa",
        content: "nested reply",
        offsetSec: 120,
        replyTo: "l2",
      },
      { id: "l4", personaId: "pb", content: "flat reply", offsetSec: 180 },
    ],
  };
}

/** Signed canonical IR for the fixture script. */
function signedEvents(script: TalkScript): NostrEvent[] {
  const compiled = compileScript(script);
  const { events, skippedLineIds } = signTalk(script, compiled);
  expect(skippedLineIds).toEqual([]);
  return events;
}

interface StubFetch {
  fetch: FetchEvents;
  calls: { relays: string[]; filters: Filter[] }[];
}

/**
 * FetchEvents backed by an in-memory event set (pool.request semantics).
 * Applies each filter's `limit` to that filter's matches — a relay only
 * returns up to `limit` events per filter.
 */
function stubFetch(events: NostrEvent[]): StubFetch {
  const calls: StubFetch["calls"] = [];
  return {
    calls,
    fetch: async (relays, filters) => {
      calls.push({ relays, filters });
      const seen = new Set<string>();
      const out: NostrEvent[] = [];
      for (const filter of filters) {
        const matched = events.filter((e) => matchFilters([filter], e));
        for (const e of filter.limit ? matched.slice(0, filter.limit) : matched) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(e);
        }
      }
      return out;
    },
  };
}

function failingFetch(message: string): FetchEvents {
  return async () => {
    throw new Error(message);
  };
}

describe("decodeIdentifier", () => {
  const id = "f".repeat(64);

  it("decodes nevent with relay hints (no kind hint → unfiltered ids)", () => {
    const nevent = nip19.neventEncode({ id, relays: ["wss://nos.lol"] });
    const decoded = decodeIdentifier(nevent);
    expect(decoded.targetFilter).toEqual({ ids: [id] });
    expect(decoded.relays).toEqual(["wss://nos.lol/"]);
  });

  it("uses the nevent kind hint to narrow the first query", () => {
    const nevent = nip19.neventEncode({ id, kind: 1 });
    const decoded = decodeIdentifier(nevent);
    expect(decoded.targetFilter).toEqual({ ids: [id], kinds: [1] });
  });

  it("decodes note and falls back to publish relays", () => {
    localStorage.clear();
    const decoded = decodeIdentifier(nip19.noteEncode(id));
    expect(decoded.targetFilter).toEqual({ ids: [id] });
    expect(decoded.relays).toEqual(DEFAULT_PUBLISH_RELAYS);
  });

  it("decodes naddr into an address filter", () => {
    const naddr = nip19.naddrEncode({
      kind: 11,
      pubkey: "a".repeat(64),
      identifier: "thread-1",
      relays: ["wss://relay.example.com"],
    });
    const decoded = decodeIdentifier(naddr);
    expect(decoded.targetFilter).toEqual({
      kinds: [11],
      authors: ["a".repeat(64)],
      "#d": ["thread-1"],
    });
    expect(decoded.relays).toEqual(["wss://relay.example.com/"]);
  });

  it("rejects empty input and non-event identifier types", () => {
    expect(() => decodeIdentifier("")).toThrow(ImportError);
    expect(() => decodeIdentifier("   ")).toThrow(ImportError);
    expect(() => decodeIdentifier("not-bech32")).toThrow(ImportError);
    expect(() => decodeIdentifier(nip19.npubEncode("a".repeat(64)))).toThrow(
      ImportError,
    );
  });
});

describe("importFromIdentifier", () => {
  it("rebuilds a script that recompiles to byte-identical events", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const root = published[0];
    const nevent = nip19.neventEncode({ id: root.id, relays: [] });
    const { fetch } = stubFetch(published);

    const { script: imported, warnings } = await importFromIdentifier(
      nevent,
      fetch,
    );
    expect(warnings).toEqual([]);

    // personas are pubkey-only references in first-appearance order
    expect(imported.personas).toHaveLength(2);
    expect(imported.personas[0].pubkey).toBe(script.personas[0].pubkey);
    expect(imported.personas[0].key).toBeUndefined();
    expect(imported.personas[0].name).toMatch(/^npub1/);

    expect(imported.title).toBe(script.title);
    expect(imported.baseTimeSec).toBe(script.baseTimeSec);
    expect(imported.id).not.toBe(script.id);
    expect(imported.issues).toBeUndefined();
    expect(imported.lines).toHaveLength(script.lines.length);
    expect(imported.lines.map((l) => l.content)).toEqual(
      script.lines.map((l) => l.content),
    );

    // the round trip: imported script recompiles to identical events
    expect(compileScript(imported).events).toEqual(
      compileScript(script).events,
    );
  });

  it("round-trips signed events again once persona keys are re-entered", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const { fetch } = stubFetch(published);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    // ownership: re-entering each persona's key restores signing and the
    // same event ids
    const keyByPubkey = new Map(
      script.personas.map((p) => [p.pubkey!, p.key!] as const),
    );
    for (const persona of imported.personas)
      persona.key = keyByPubkey.get(persona.pubkey!)!;

    const compiled = compileScript(imported);
    const { events, skippedLineIds } = signTalk(imported, compiled);
    expect(skippedLineIds).toEqual([]);
    // schnorr signatures carry aux randomness: ids and templates are
    // byte-identical, sigs differ between signing runs
    expect(events.map(({ sig: _sig, ...e }) => e)).toEqual(
      published.map(({ sig: _sig, ...e }) => e),
    );
    for (const event of events) expect(verifyEvent(event)).toBe(true);
  });

  it("normalizes foreign tags away (recompiled ids differ)", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const keyBytes = hexToBytes(KEY_A);

    // a foreign kind 11 root carrying extra tags (title, client)
    const foreignRoot = finalizeEvent(
      {
        kind: 11,
        created_at: published[0].created_at,
        tags: [
          ["title", published[0].content],
          ["subject", "foreign subject"],
          ["client", "other-app"],
        ],
        content: published[0].content,
      },
      keyBytes,
    );
    const { fetch } = stubFetch([foreignRoot]);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(foreignRoot.id),
      fetch,
    );
    // subject wins over title
    expect(imported.title).toBe("foreign subject");
    const [recompiled] = compileScript(imported).events;
    // M3d: compile emits both subject and title (NIP-7D SHOULD)
    expect(recompiled.tags).toEqual([
      ["subject", "foreign subject"],
      ["title", "foreign subject"],
    ]);
    expect(recompiled.id).not.toBe(foreignRoot.id);
  });

  it("prefers subject over title, and title over empty", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const keyBytes = hexToBytes(KEY_B);

    const titleOnly = finalizeEvent(
      {
        kind: 11,
        created_at: published[0].created_at,
        tags: [["title", "title tag"]],
        content: "x",
      },
      keyBytes,
    );
    const { fetch } = stubFetch([titleOnly]);
    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(titleOnly.id),
      fetch,
    );
    expect(imported.title).toBe("title tag");
  });

  it("treats a comment whose parent was not fetched as a root reply, with warning", async () => {
    const script = fixture();
    const published = signedEvents(script);
    // drop the intermediate comment l2 — l3's parent is now missing
    const events = published.filter((_, i) => i !== 1);
    const { fetch } = stubFetch(events);

    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    expect(imported.lines).toHaveLength(3);
    const nested = imported.lines.find((l) => l.content === "nested reply")!;
    expect(nested.replyTo).toBeUndefined();
    expect(warnings.some((w) => w.includes("収集セットに無い"))).toBe(true);
  });

  it("clamps negative offsets and warns on time inversion vs the root", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const keyBytes = hexToBytes(KEY_B);
    const earlier = finalizeEvent(
      {
        kind: 1111,
        created_at: published[0].created_at - 60,
        tags: [
          ["E", published[0].id],
          ["K", "11"],
          ["e", published[0].id],
          ["k", "11"],
        ],
        content: "too early",
      },
      keyBytes,
    );
    const { fetch } = stubFetch([...published, earlier]);

    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    const line = imported.lines.find((l) => l.content === "too early")!;
    expect(line.offsetSec).toBe(0);
    expect(warnings.some((w) => w.includes("ルートより前"))).toBe(true);
  });

  it("drops a replyTo that would violate parent-before-child ordering", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const [root, c1] = published;
    const keyA = hexToBytes(KEY_A);

    // child timestamped earlier than its parent
    const child = finalizeEvent(
      {
        kind: 1111,
        created_at: c1.created_at - 30,
        tags: [
          ["E", root.id],
          ["K", "11"],
          ["e", c1.id],
          ["k", "1111"],
          ["p", c1.pubkey],
        ],
        content: "out-of-order child",
      },
      keyA,
    );
    const { fetch } = stubFetch([root, c1, child]);

    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    const line = imported.lines.find(
      (l) => l.content === "out-of-order child",
    )!;
    expect(line.replyTo).toBeUndefined();
    expect(warnings.some((w) => w.includes("親より前"))).toBe(true);
    // and the imported script compiles (invariant preserved)
    expect(() => compileScript(imported)).not.toThrow();
  });

  it("warns when a comment has no e tag and keeps it as a root reply", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const orphan = finalizeEvent(
      {
        kind: 1111,
        created_at: published[0].created_at + 10,
        tags: [
          ["E", published[0].id],
          ["K", "11"],
        ],
        content: "no parent tag",
      },
      hexToBytes(KEY_B),
    );
    const { fetch } = stubFetch([...published, orphan]);

    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    const line = imported.lines.find((l) => l.content === "no parent tag")!;
    expect(line.replyTo).toBeUndefined();
    expect(warnings.some((w) => w.includes("e タグ"))).toBe(true);
  });

  it("orders equal timestamps by event id (deterministic)", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const [root] = published;
    const sameTime = root.created_at + 500;
    const mk = (key: Uint8Array, content: string) =>
      finalizeEvent(
        {
          kind: 1111,
          created_at: sameTime,
          tags: [
            ["E", root.id],
            ["K", "11"],
            ["e", root.id],
            ["k", "11"],
          ],
          content,
        },
        key,
      );
    const ev1 = mk(hexToBytes(KEY_A), "tie-a");
    const ev2 = mk(hexToBytes(KEY_B), "tie-b");
    const { fetch } = stubFetch([root, ev2, ev1]);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    const contents = imported.lines.slice(1).map((l) => l.content);
    const expected = [ev1, ev2]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => e.content);
    expect(contents).toEqual(expected);
  });

  it("excludes comments bound to a different root", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const other = finalizeEvent(
      {
        kind: 1111,
        created_at: published[0].created_at + 10,
        tags: [
          ["E", "e".repeat(64)],
          ["K", "11"],
          ["e", "e".repeat(64)],
          ["k", "11"],
        ],
        content: "other thread",
      },
      hexToBytes(KEY_B),
    );
    // a non-conforming relay could return this for an #E filter anyway
    const { fetch } = stubFetch([...published, other]);
    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    expect(imported.lines.map((l) => l.content)).not.toContain("other thread");
  });

  it("dedupes events returned by multiple relays", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const { fetch } = stubFetch([...published, ...published]);
    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    expect(imported.lines).toHaveLength(published.length);
  });

  it("drops events whose id does not match their content", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const forged = { ...published[1], id: "0".repeat(64) };
    const { fetch } = stubFetch([...published, forged]);
    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    expect(imported.lines).toHaveLength(published.length);
  });

  it("uses nevent relay hints for both queries", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const hint = "wss://hint.example.com";
    const nevent = nip19.neventEncode({ id: published[0].id, relays: [hint] });
    const { fetch, calls } = stubFetch(published);

    const { relays } = await importFromIdentifier(nevent, fetch);
    expect(relays).toEqual([hint + "/"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].relays).toEqual([hint + "/"]);
    // no kind hint in the nevent → detection query is unfiltered
    expect(calls[0].filters).toEqual([{ ids: [published[0].id] }]);
    expect(calls[1].filters).toEqual([
      { kinds: [1111], "#E": [published[0].id] },
    ]);
  });

  it("falls back to publish relays when the identifier has no hints", async () => {
    localStorage.clear();
    const script = fixture();
    const published = signedEvents(script);
    const { fetch, calls } = stubFetch(published);
    await importFromIdentifier(nip19.noteEncode(published[0].id), fetch);
    expect(calls[0].relays).toEqual(DEFAULT_PUBLISH_RELAYS);
  });

  it("warns (not errors) when no comments exist", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const { fetch } = stubFetch([published[0]]);
    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(published[0].id),
      fetch,
    );
    expect(imported.lines).toHaveLength(1);
    expect(warnings.some((w) => w.includes("コメント"))).toBe(true);
  });

  it("throws an honest error when the root is not found", async () => {
    const { fetch } = stubFetch([]);
    await expect(
      importFromIdentifier(nip19.noteEncode("f".repeat(64)), fetch),
    ).rejects.toThrow(ImportError);
    await expect(
      importFromIdentifier(nip19.noteEncode("f".repeat(64)), fetch),
    ).rejects.toThrow(/見つかりません/);
  });

  it("wraps fetch failures as ImportError", async () => {
    await expect(
      importFromIdentifier(
        nip19.noteEncode("f".repeat(64)),
        failingFetch("connection refused"),
      ),
    ).rejects.toThrow(/問い合わせに失敗/);
  });

  it("resolves a naddr filter to the latest kind 11 event", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const root = published[0];
    const naddr = nip19.naddrEncode({
      kind: 11,
      pubkey: root.pubkey,
      identifier: "t",
      relays: [],
    });
    // the stub relay returns the addressed event for the kind+author+d query
    const laxFetch: FetchEvents = async () => [root];
    const { script: imported } = await importFromIdentifier(naddr, laxFetch);
    expect(imported.lines).toHaveLength(1);
  });
});

describe("kind 1 / NIP-10 thread import", () => {
  const note = (
    content: string,
    key: string,
    created_at: number,
    tags: string[][] = [],
  ): NostrEvent =>
    finalizeEvent(
      { kind: 1, content, tags, created_at },
      hexToBytes(key),
    );

  const T0 = 1_700_000_000;

  /** Marked NIP-10 thread: root, direct reply (root-only tag), nested
   * reply (root+reply), plus an e-mention of the root that must be
   * ignored. */
  function markedThread() {
    const root = note("k1 root post", KEY_A, T0);
    const direct = note("k1 direct reply", KEY_B, T0 + 60, [
      ["e", root.id, "", "root"],
    ]);
    const nested = note("k1 nested reply", KEY_A, T0 + 120, [
      ["e", root.id, "", "root"],
      ["e", direct.id, "", "reply", "b".repeat(64)],
    ]);
    // mentions the root but is not part of the thread structure
    const mentioner = note("k1 unrelated mention", KEY_B, T0 + 150, [
      ["e", root.id, "", "mention"],
    ]);
    return { root, direct, nested, mentioner };
  }

  it("imports a marked thread by its root note", async () => {
    const { root, direct, nested, mentioner } = markedThread();
    const { fetch } = stubFetch([root, direct, nested, mentioner]);

    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    expect(imported.lines.map((l) => l.content)).toEqual([
      "k1 root post",
      "k1 direct reply",
      "k1 nested reply",
    ]);
    expect(imported.lines[2].replyTo).toBe(imported.lines[1].id);
    expect(imported.personas.map((p) => p.pubkey)).toEqual([
      getPublicKey(hexToBytes(KEY_A)),
      getPublicKey(hexToBytes(KEY_B)),
    ]);
    expect(imported.baseTimeSec).toBe(T0);
    expect(imported.title).toBe("k1 root post");
    // kind-1 sources are inherently a fork (recompile → kind 11 + 1111)
    expect(warnings.some((w) => w.includes("kind 11"))).toBe(true);
    expect(warnings.some((w) => w.includes("フォーク"))).toBe(true);
  });

  it("resolves the root when the identifier points mid-thread", async () => {
    const { root, direct, nested } = markedThread();
    const { fetch, calls } = stubFetch([root, direct, nested]);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(nested.id),
      fetch,
    );
    // nested → rootId via its root marker → ids fetch of the root →
    // then the #e descendant query
    expect(calls[0].filters).toEqual([{ ids: [nested.id] }]);
    expect(calls[1].filters).toEqual([{ ids: [root.id], kinds: [1] }]);
    expect(calls[2].filters).toEqual([
      { kinds: [1], "#e": [root.id], limit: 200 },
    ]);
    expect(imported.lines.map((l) => l.content)).toEqual([
      "k1 root post",
      "k1 direct reply",
      "k1 nested reply",
    ]);
  });

  it("walks the reply chain when the target has only a reply marker", async () => {
    const root = note("walkup root", KEY_A, T0);
    const mid = note("walkup mid", KEY_B, T0 + 10, [
      ["e", root.id, "", "root"],
    ]);
    // a reply with only a "reply" marker — no root reference
    const leaf = note("walkup leaf", KEY_A, T0 + 20, [
      ["e", mid.id, "", "reply"],
    ]);
    const { fetch, calls } = stubFetch([root, mid, leaf]);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(leaf.id),
      fetch,
    );
    // leaf → parent mid → mid's root marker → root fetch → descendants
    expect(calls[1].filters).toEqual([{ ids: [mid.id], kinds: [1] }]);
    expect(calls[2].filters).toEqual([{ ids: [root.id], kinds: [1] }]);
    expect(imported.lines).toHaveLength(3);
    expect(imported.lines[2].replyTo).toBe(imported.lines[1].id);
  });

  it("interprets the deprecated positional form (first e = root, last e = parent)", async () => {
    const root = note("legacy root", KEY_A, T0);
    const direct = note("legacy direct", KEY_B, T0 + 10, [
      ["e", root.id, "wss://relay.example.com"],
    ]);
    // [root, mention, parent] — the middle e is a mention, ignored
    const nested = note("legacy nested", KEY_A, T0 + 20, [
      ["e", root.id],
      ["e", "d".repeat(64)],
      ["e", direct.id],
    ]);
    const { fetch } = stubFetch([root, direct, nested]);

    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    expect(imported.lines.map((l) => l.content)).toEqual([
      "legacy root",
      "legacy direct",
      "legacy nested",
    ]);
    expect(imported.lines[2].replyTo).toBe(imported.lines[1].id);
  });

  it("excludes events that merely mention the root", async () => {
    const { root, direct, nested, mentioner } = markedThread();
    const { fetch } = stubFetch([root, direct, nested, mentioner]);
    const { script: imported } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    expect(imported.lines.map((l) => l.content)).not.toContain(
      "k1 unrelated mention",
    );
  });

  it("flattens replies deeper than the depth cap under the root with a warning", async () => {
    const root = note("deep root", KEY_A, T0);
    const chain = [root];
    for (let i = 1; i <= 6; i++) {
      chain.push(
        note(`deep ${i}`, KEY_A, T0 + i, [
          ["e", root.id, "", "root"],
          ["e", chain[i - 1].id, "", "reply"],
        ]),
      );
    }
    const { fetch } = stubFetch(chain);
    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    expect(imported.lines).toHaveLength(7);
    // depth 1-4 nest; depth 5+ flattens to root
    const nestedIds = imported.lines
      .slice(1)
      .filter((l) => l.replyTo)
      .map((l) => l.replyTo);
    expect(nestedIds).toHaveLength(4);
    expect(warnings.some((w) => w.includes("深さ上限"))).toBe(true);
  });

  it("warns when the descendant query hits the limit", async () => {
    const root = note("big root", KEY_A, T0);
    const replies = Array.from({ length: 210 }, (_, i) =>
      note(`bulk ${i}`, KEY_B, T0 + 100 + i, [["e", root.id, "", "root"]]),
    );
    const { fetch } = stubFetch([root, ...replies]);
    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    // only the first 200 (filter limit) are collected
    expect(imported.lines).toHaveLength(201);
    expect(warnings.some((w) => w.includes("打ち切り"))).toBe(true);
  });

  it("attaches replies whose parent is missing under the root with a warning", async () => {
    const { root, direct } = markedThread();
    // the parent is nowhere to be found — its child falls back to root
    const orphanChild = note("k1 orphan child", KEY_B, T0 + 300, [
      ["e", root.id, "", "root"],
      ["e", "c".repeat(64), "", "reply"],
    ]);
    const { fetch } = stubFetch([root, direct, orphanChild]);
    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    const line = imported.lines.find((l) => l.content === "k1 orphan child")!;
    expect(line.replyTo).toBeUndefined();
    expect(warnings.some((w) => w.includes("収集セットに無い"))).toBe(true);
  });

  it("clamps a reply older than the root to offset 0 with a warning", async () => {
    const root = note("k1 time root", KEY_A, T0);
    const early = note("k1 early reply", KEY_B, T0 - 500, [
      ["e", root.id, "", "root"],
    ]);
    const { fetch } = stubFetch([root, early]);
    const { script: imported, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    expect(imported.lines[1].offsetSec).toBe(0);
    expect(warnings.some((w) => w.includes("ルートより前"))).toBe(true);
  });

  it("throws when the referenced root is unreachable", async () => {
    const leaf = note("k1 dangling leaf", KEY_A, T0, [
      ["e", "e".repeat(64), "", "root"],
    ]);
    const { fetch } = stubFetch([leaf]);
    await expect(
      importFromIdentifier(nip19.noteEncode(leaf.id), fetch),
    ).rejects.toThrow(/見つかりません/);
  });

  it("throws for unsupported target kinds", async () => {
    const react = finalizeEvent(
      {
        kind: 7,
        content: "+",
        tags: [],
        created_at: T0,
      },
      hexToBytes(KEY_A),
    );
    const { fetch } = stubFetch([react]);
    await expect(
      importFromIdentifier(nip19.noteEncode(react.id), fetch),
    ).rejects.toThrow(/未対応のイベント kind 7/);
  });

  it("uses the nevent kind hint for the detection query", async () => {
    const { root, direct, nested } = markedThread();
    const { fetch, calls } = stubFetch([root, direct, nested]);
    await importFromIdentifier(
      nip19.neventEncode({ id: root.id, kind: 1 }),
      fetch,
    );
    expect(calls[0].filters).toEqual([{ ids: [root.id], kinds: [1] }]);
  });

  it("still imports a kind 11 thread when the note kind hint says 11", async () => {
    const script = fixture();
    const published = signedEvents(script);
    const { fetch } = stubFetch(published);
    const { script: imported } = await importFromIdentifier(
      nip19.neventEncode({ id: published[0].id, kind: 11 }),
      fetch,
    );
    expect(imported.lines).toHaveLength(4);
  });
});

describe("buildScript", () => {
  it("produces a valid empty title when the root has neither subject nor title", () => {
    const script = fixture();
    const published = signedEvents(script);
    const bare = finalizeEvent(
      {
        kind: 11,
        created_at: published[0].created_at,
        tags: [],
        content: "untitled",
      },
      hexToBytes(KEY_A),
    );
    const { script: imported } = buildScript(bare, []);
    expect(imported.title).toBe("");
    expect(() => compileScript(imported)).not.toThrow();
  });
});
