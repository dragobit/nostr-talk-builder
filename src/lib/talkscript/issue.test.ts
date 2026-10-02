import { beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  aggregateResults,
  createIssueRecord,
  DEFAULT_PUBLISH_RELAYS,
  isValidRelayUrl,
  loadPublishRelays,
  normalizeRelayInput,
  publishToRelays,
  RELAY_STORAGE_KEY,
  savePublishRelays,
  type PublishOutcome,
} from "./issue";
import {
  deserializeTalkScript,
  serializeTalkScript,
} from "./persist";
import { TALK_SCRIPT_VERSION, type TalkScript } from "./types";

const KEY_A = "a".repeat(64);

function fixture(issues?: TalkScript["issues"]): TalkScript {
  return {
    version: TALK_SCRIPT_VERSION,
    id: "script-1",
    title: "テスト会話",
    baseTimeSec: 1_700_000_000,
    personas: [{ id: "pa", name: "A", key: KEY_A }],
    lines: [{ id: "l1", personaId: "pa", content: "first", offsetSec: 0 }],
    ...(issues ? { issues } : {}),
  };
}

function record(overrides: Partial<ReturnType<typeof createIssueRecord>> = {}) {
  return {
    id: "issue-1",
    issuedAt: 1_700_000_100,
    preset: "public-plain",
    bindings: [],
    envelope: "plain" as const,
    relays: ["wss://nos.lol", "wss://nostr.mom"],
    results: { "event-1": "ok", "event-2": "wss://nostr.mom: rejected" },
    ...overrides,
  };
}

describe("IssueRecord persistence", () => {
  it("round-trips a script carrying issues through serialize/deserialize", () => {
    const script = fixture([record()]);
    const restored = deserializeTalkScript(serializeTalkScript(script));
    expect(restored).toEqual(script);
    expect(restored.issues).toHaveLength(1);
    expect(restored.issues?.[0].results["event-2"]).toMatch(/rejected/);
  });

  it("accepts scripts with no issues field (additive optional)", () => {
    const restored = deserializeTalkScript(
      serializeTalkScript(fixture()),
    );
    expect(restored.issues).toBeUndefined();
  });

  it("rejects a malformed issue record", () => {
    const bad = record({ envelope: "wrapped" as never });
    const json = serializeTalkScript(fixture([bad]));
    expect(() => deserializeTalkScript(json)).toThrow(/issues/);
  });
});

describe("relay list persistence", () => {
  beforeEach(() => localStorage.removeItem(RELAY_STORAGE_KEY));

  it("returns the defaults when nothing is stored", () => {
    expect(loadPublishRelays()).toEqual(DEFAULT_PUBLISH_RELAYS);
  });

  it("round-trips through localStorage", () => {
    const relays = ["wss://a.example.com", "ws://b.example.com"];
    savePublishRelays(relays);
    expect(loadPublishRelays()).toEqual(relays);
  });

  it("drops stored entries that are not ws/wss urls", () => {
    localStorage.setItem(
      RELAY_STORAGE_KEY,
      JSON.stringify(["wss://ok.example.com", "https://evil.example.com", 42]),
    );
    expect(loadPublishRelays()).toEqual(["wss://ok.example.com"]);
  });

  it("falls back to defaults on corrupt or all-invalid storage", () => {
    localStorage.setItem(RELAY_STORAGE_KEY, "{not json");
    expect(loadPublishRelays()).toEqual(DEFAULT_PUBLISH_RELAYS);
    localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(["https://x.com"]));
    expect(loadPublishRelays()).toEqual(DEFAULT_PUBLISH_RELAYS);
  });
});

describe("relay url validation", () => {
  it("accepts ws:// and wss:// urls", () => {
    expect(isValidRelayUrl("wss://nos.lol")).toBe(true);
    expect(isValidRelayUrl("ws://localhost:7777")).toBe(true);
    expect(isValidRelayUrl("  wss://nos.lol/path  ")).toBe(true);
  });

  it("rejects non-websocket urls and garbage", () => {
    for (const url of [
      "https://nos.lol",
      "http://nos.lol",
      "ftp://nos.lol",
      "not a url",
      "",
    ]) {
      expect(isValidRelayUrl(url)).toBe(false);
      expect(normalizeRelayInput(url)).toBeNull();
    }
  });

  it("normalizes protocol-less input to wss://", () => {
    expect(normalizeRelayInput("nos.lol")).toBe("wss://nos.lol/");
    expect(normalizeRelayInput(" relay.example.com:7777 ")).toBe(
      "wss://relay.example.com:7777/",
    );
  });
});

describe("publishToRelays + aggregateResults", () => {
  const event = { id: "ev1", kind: 11 } as NostrEvent;

  it("maps per-relay responses back to the requested urls", async () => {
    const outcome = await publishToRelays(
      [event],
      ["wss://a.example.com", "wss://b.example.com"],
      async () => [
        // `from` is normalized (trailing slash) by the pool
        { ok: true, from: "wss://a.example.com/" },
        { ok: false, from: "wss://b.example.com/", message: "rejected" },
      ],
    );
    expect(outcome.ev1["wss://a.example.com"]).toEqual({ ok: true });
    expect(outcome.ev1["wss://b.example.com"]).toEqual({
      ok: false,
      message: "rejected",
    });
    expect(aggregateResults(outcome).ev1).toMatch(
      /wss:\/\/b\.example\.com: rejected/,
    );
  });

  it("marks every relay failed when publish throws, and continues", async () => {
    const ev2 = { id: "ev2", kind: 1111 } as NostrEvent;
    let calls = 0;
    const outcome = await publishToRelays(
      [event, ev2],
      ["wss://a.example.com"],
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection refused");
        return [{ ok: true, from: "wss://a.example.com/" }];
      },
    );
    expect(outcome.ev1["wss://a.example.com"].ok).toBe(false);
    expect(outcome.ev1["wss://a.example.com"].message).toBe(
      "connection refused",
    );
    expect(outcome.ev2["wss://a.example.com"].ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("reports no-response relays as failures", async () => {
    const outcome = await publishToRelays(
      [event],
      ["wss://a.example.com", "wss://b.example.com"],
      async () => [{ ok: true, from: "wss://a.example.com/" }],
    );
    expect(aggregateResults(outcome).ev1).toMatch(/wss:\/\/b\.example\.com/);
  });

  it("aggregates to ok only when every relay accepted", () => {
    const outcome: PublishOutcome = {
      ev1: {
        "wss://a": { ok: true },
        "wss://b": { ok: true },
      },
      ev2: {
        "wss://a": { ok: true },
        "wss://b": { ok: false, message: "rate-limited" },
      },
    };
    expect(aggregateResults(outcome)).toEqual({
      ev1: "ok",
      ev2: "wss://b: rate-limited",
    });
  });
});

describe("createIssueRecord", () => {
  it("fills id/issuedAt and freezes bindings+envelope for M3a", () => {
    const rec = createIssueRecord({
      preset: "public-plain",
      relays: ["wss://nos.lol"],
      results: { ev1: "ok" },
    });
    expect(rec.id).toBeTruthy();
    expect(rec.issuedAt).toBeGreaterThan(0);
    expect(rec.bindings).toEqual([]);
    expect(rec.envelope).toBe("plain");
    expect(rec.relays).toEqual(["wss://nos.lol"]);
    expect(rec.results).toEqual({ ev1: "ok" });
  });
});
