import { describe, expect, it } from "vitest";
import { nip19, verifyEvent, type NostrEvent } from "nostr-tools";
import { compileScript } from "./compile";
import { aggregateResults } from "./issue";
import {
  compileWire,
  GROUP_CHAT_KIND,
  GROUP_JOIN_KIND,
  NO_KEY_REASON,
  publishWire,
  signWireEvents,
  WireError,
} from "./wire";
import type { TalkScript } from "./types";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const RELAY = "wss://groups.example.com/";
const GROUP = "test-group";

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
      {
        id: "l2",
        personaId: "pb",
        content: "second",
        offsetSec: 60,
        replyTo: "l1",
      },
      {
        id: "l3",
        personaId: "pa",
        content: "third",
        offsetSec: 120,
        replyTo: "l2",
      },
      { id: "l4", personaId: "pc", content: "unsigned", offsetSec: 180 },
    ],
  };
}

describe("compileWire h-bind", () => {
  it("re-compiles the IR shape with an h tag on every event, producing new ids", () => {
    const wire = compileWire(fixture(), "h-bind", { groupId: GROUP });
    const canonical = compileScript(fixture());

    expect(wire.events).toHaveLength(4);
    expect(wire.joinIds.size).toBe(0);
    expect(wire.events[0].draft.kind).toBe(11);
    for (const w of wire.events) {
      expect(w.draft.tags).toContainEqual(["h", GROUP]);
    }
    for (const w of wire.events.slice(1)) {
      expect(w.draft.kind).toBe(1111);
      // children reference the bound root, not the canonical one
      expect(w.draft.tags).toContainEqual([
        "E",
        wire.events[0].draft.id,
        "",
        wire.events[0].draft.pubkey,
      ]);
    }
    expect(wire.events.map((w) => w.draft.id)).not.toEqual(
      canonical.events.map((e) => e.id),
    );
  });

  it("is deterministic: same inputs produce identical event ids", () => {
    const a = compileWire(fixture(), "h-bind", { groupId: GROUP });
    const b = compileWire(fixture(), "h-bind", { groupId: GROUP });
    expect(a.events.map((w) => w.draft)).toEqual(b.events.map((w) => w.draft));
    // a different group id produces a different event set
    const c = compileWire(fixture(), "h-bind", { groupId: "other" });
    expect(c.events.map((w) => w.draft.id)).not.toEqual(
      a.events.map((w) => w.draft.id),
    );
  });
});

describe("compileWire nip29-chat", () => {
  it("projects every line to kind 9 with an h tag and joins first", () => {
    const wire = compileWire(
      fixture(),
      "nip29-chat",
      { groupId: GROUP },
      RELAY,
    );

    // one kind 9021 join per speaking persona (pa, pb, pc), sent first
    const joins = wire.events.filter((w) => w.draft.kind === GROUP_JOIN_KIND);
    expect(joins.map((w) => w.personaId)).toEqual(["pa", "pb", "pc"]);
    for (const j of joins) {
      expect(j.draft.tags).toEqual([["h", GROUP]]);
    }
    expect(wire.events.slice(0, joins.length)).toEqual(joins);
    expect(wire.joinIds.size).toBe(joins.length);

    // every line becomes a kind 9 message carrying only the h tag
    const messages = wire.events.slice(joins.length);
    expect(messages).toHaveLength(4);
    for (const [i, m] of messages.entries()) {
      expect(m.draft.kind).toBe(GROUP_CHAT_KIND);
      expect(m.draft.tags[0]).toEqual(["h", GROUP]);
      expect(m.draft.created_at).toBe(1_700_000_000 + [0, 60, 120, 180][i]);
      expect(m.draft.tags.flat()).not.toContain("subject");
      expect(m.draft.tags.flat()).not.toContain("title");
    }
    // the root line is a plain message: no q tag, raw content
    expect(messages[0].draft.content).toBe("first");
    expect(messages[0].draft.tags).toHaveLength(1);
  });

  it("quotes replyTo parents via a q tag and a nostr:nevent content prefix", () => {
    const wire = compileWire(
      fixture(),
      "nip29-chat",
      { groupId: GROUP },
      RELAY,
    );
    const messages = wire.events.filter(
      (w) => w.draft.kind === GROUP_CHAT_KIND,
    );
    const [rootMsg, l2, l3] = messages.map((w) => w.draft);

    // l2 replies to l1: q tag = [q, parentId, relayHint, parentPubkey]
    expect(l2.tags).toContainEqual(["q", rootMsg.id, RELAY, rootMsg.pubkey]);
    const embed = nip19.neventEncode({
      id: rootMsg.id,
      author: rootMsg.pubkey,
      relays: [RELAY],
    });
    expect(l2.content).toBe(`nostr:${embed}\nsecond`);

    // l3 replies to l2 — chains follow the projected parents
    expect(l3.tags).toContainEqual(["q", l2.id, RELAY, l2.pubkey]);
    expect(l3.content.startsWith("nostr:nevent1")).toBe(true);
    expect(l3.content.endsWith("\nthird")).toBe(true);
  });

  it("is deterministic: same inputs produce identical event ids", () => {
    const a = compileWire(fixture(), "nip29-chat", { groupId: GROUP }, RELAY);
    const b = compileWire(fixture(), "nip29-chat", { groupId: GROUP }, RELAY);
    expect(a.events.map((w) => w.draft)).toEqual(b.events.map((w) => w.draft));
  });

  it("requires a groupId", () => {
    expect(() => compileWire(fixture(), "nip29-chat", {}, RELAY)).toThrow(
      WireError,
    );
    expect(() => compileWire(fixture(), "h-bind", { groupId: "  " })).toThrow(
      WireError,
    );
  });
});

describe("signWireEvents", () => {
  it("signs with persona keys and records NO_KEY_REASON for the rest", () => {
    const script = fixture();
    const wire = compileWire(script, "nip29-chat", { groupId: GROUP }, RELAY);
    const { signed, failures } = signWireEvents(script, wire.events);

    // pc has no held key: its join + message fail honestly
    const pcEvents = wire.events.filter((w) => w.personaId === "pc");
    expect(pcEvents).toHaveLength(2);
    for (const w of pcEvents) expect(failures[w.draft.id]).toBe(NO_KEY_REASON);

    for (const event of signed) expect(verifyEvent(event)).toBe(true);
    expect(signed.map((e) => e.id)).toEqual(
      wire.events.filter((w) => !failures[w.draft.id]).map((w) => w.draft.id),
    );
  });
});

describe("publishWire", () => {
  it("sends joins before messages and counts duplicate: as accepted", async () => {
    const script = fixture();
    const wire = compileWire(script, "nip29-chat", { groupId: GROUP }, RELAY);
    const { signed, failures } = signWireEvents(script, wire.events);
    void failures;

    const sent: string[] = [];
    const outcome = await publishWire(
      wire,
      signed,
      [RELAY],
      async (_relays, event: NostrEvent) => {
        sent.push(event.id);
        if (wire.joinIds.has(event.id))
          return [
            {
              ok: false,
              from: RELAY,
              message: "duplicate: already a member",
            },
          ];
        return [{ ok: true, from: RELAY }];
      },
    );

    // joins were sent first, in order
    const signedJoins = signed
      .filter((e) => wire.joinIds.has(e.id))
      .map((e) => e.id);
    expect(sent.slice(0, signedJoins.length)).toEqual(signedJoins);

    // duplicate: answers aggregate to "ok"
    const results = aggregateResults(outcome);
    for (const id of signedJoins) expect(results[id]).toBe("ok");
  });

  it("keeps honest failures for rejected joins", async () => {
    const script = fixture();
    const wire = compileWire(script, "nip29-chat", { groupId: GROUP }, RELAY);
    const { signed } = signWireEvents(script, wire.events);

    const outcome = await publishWire(wire, signed, [RELAY], async () => [
      { ok: false, from: RELAY, message: "blocked: not a member" },
    ]);
    const results = aggregateResults(outcome);
    for (const id of signed
      .filter((e) => wire.joinIds.has(e.id))
      .map((e) => e.id))
      expect(results[id]).toMatch(/blocked: not a member/);
  });
});
