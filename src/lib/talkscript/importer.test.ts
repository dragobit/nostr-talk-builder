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

/** FetchEvents backed by an in-memory event set (pool.request semantics). */
function stubFetch(events: NostrEvent[]): StubFetch {
  const calls: StubFetch["calls"] = [];
  return {
    calls,
    fetch: async (relays, filters) => {
      calls.push({ relays, filters });
      return events.filter((e) => matchFilters(filters, e));
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

  it("decodes nevent with relay hints", () => {
    const nevent = nip19.neventEncode({ id, relays: ["wss://nos.lol"] });
    const decoded = decodeIdentifier(nevent);
    expect(decoded.rootFilter).toEqual({ ids: [id], kinds: [11] });
    expect(decoded.relays).toEqual(["wss://nos.lol/"]);
  });

  it("decodes note and falls back to publish relays", () => {
    localStorage.clear();
    const decoded = decodeIdentifier(nip19.noteEncode(id));
    expect(decoded.rootFilter).toEqual({ ids: [id], kinds: [11] });
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
    expect(decoded.rootFilter).toEqual({
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
    expect(calls[0].filters).toEqual([{ ids: [published[0].id], kinds: [11] }]);
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
