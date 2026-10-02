import { describe, expect, it } from "vitest";
import { verifyEvent } from "nostr-tools";
import { compileScript } from "./compile";
import { signTalk } from "./sign";
import type { TalkScript } from "./types";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function fixture(): TalkScript {
  return {
    version: 1,
    id: "script-1",
    title: "テスト会話",
    baseTimeSec: 1_700_000_000,
    personas: [
      { id: "pa", name: "A", key: KEY_A },
      { id: "pb", name: "B", key: KEY_B },
      { id: "pc", name: "C", pubkey: "f".repeat(64) },
    ],
    lines: [
      { id: "l1", personaId: "pa", content: "first", offsetSec: 0 },
      { id: "l2", personaId: "pb", content: "second", offsetSec: 60, replyTo: "l1" },
      { id: "l3", personaId: "pa", content: "third", offsetSec: 120, replyTo: "l2" },
      { id: "l4", personaId: "pc", content: "unsigned", offsetSec: 180 },
    ],
  };
}

describe("compileScript", () => {
  it("compiles lines[0] to a kind 11 root with a subject tag", () => {
    const { events } = compileScript(fixture());
    expect(events[0].kind).toBe(11);
    expect(events[0].tags).toEqual([["subject", "テスト会話"]]);
    expect(events[0].content).toBe("first");
    expect(events[0].created_at).toBe(1_700_000_000);
  });

  it("compiles replies to kind 1111 with K/E/P root scope and k/e/p parent scope", () => {
    const { events } = compileScript(fixture());
    const [root, second, third] = events;
    for (const comment of events.slice(1)) {
      expect(comment.kind).toBe(1111);
      expect(comment.tags).toContainEqual(["E", root.id, "", root.pubkey]);
      expect(comment.tags).toContainEqual(["K", "11"]);
      expect(comment.tags).toContainEqual(["P", root.pubkey]);
    }
    // l2 replies to l1 (the root itself)
    expect(second.tags).toContainEqual(["e", root.id, "", root.pubkey]);
    expect(second.tags).toContainEqual(["k", "11"]);
    // l3 replies to l2 (a comment)
    expect(third.tags).toContainEqual(["e", second.id, "", second.pubkey]);
    expect(third.tags).toContainEqual(["k", "1111"]);
    expect(third.tags).toContainEqual(["p", second.pubkey]);
  });

  it("defaults missing replyTo to the root", () => {
    const { events } = compileScript(fixture());
    const [root, , , unsigned] = events;
    expect(unsigned.tags).toContainEqual(["e", root.id, "", root.pubkey]);
    expect(unsigned.tags).toContainEqual(["k", "11"]);
  });

  it("is deterministic: same script compiles to identical events", () => {
    const a = compileScript(fixture());
    const b = compileScript(fixture());
    expect(a.events).toEqual(b.events);
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(a.events).toMatchSnapshot();
  });
});

describe("personaPubkey fallback", () => {
  it("resolves an undecodable key via the declared pubkey", () => {
    const script = fixture();
    script.personas[0].key = "nsec1invalid";
    script.personas[0].pubkey = "e".repeat(64);
    const { events } = compileScript(script);
    expect(events[0].pubkey).toBe("e".repeat(64));
    const { skippedLineIds } = signTalk(script, compileScript(script));
    expect(skippedLineIds).toEqual(["l1", "l3", "l4"]);
  });
});

describe("signTalk", () => {
  it("signs drafts of personas with held keys, keeps ids, skips the rest", () => {
    const script = fixture();
    const compiled = compileScript(script);
    const { events, skippedLineIds } = signTalk(script, compiled);

    expect(skippedLineIds).toEqual(["l4"]);
    expect(events).toHaveLength(3);
    for (const event of events) expect(verifyEvent(event)).toBe(true);
    expect(events.map((e) => e.id)).toEqual(
      compiled.events.slice(0, 3).map((e) => e.id),
    );
  });
});
