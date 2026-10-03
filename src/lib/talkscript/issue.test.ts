import { beforeEach, describe, expect, it } from "vitest";
import { nip19, type NostrEvent } from "nostr-tools";
import {
  aggregateResults,
  createIssueRecord,
  dedupeRelays,
  DEFAULT_PUBLISH_RELAYS,
  getIssuePreset,
  ISSUE_PRESETS,
  isValidRelayUrl,
  issueLinks,
  loadPublishRelays,
  normalizeRelayInput,
  publishToRelays,
  recordableParams,
  RELAY_STORAGE_KEY,
  savePublishRelays,
  type IssuePreset,
  type PublishOutcome,
} from "./issue";
import { deserializeTalkScript, serializeTalkScript } from "./persist";
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
    const restored = deserializeTalkScript(serializeTalkScript(fixture()));
    expect(restored.issues).toBeUndefined();
  });

  it("round-trips an issue record carrying params", () => {
    const script = fixture([
      record({
        preset: "nip29-chat",
        bindings: ["h"],
        params: { groupId: "test-group" },
      }),
    ]);
    const restored = deserializeTalkScript(serializeTalkScript(script));
    expect(restored).toEqual(script);
    expect(restored.issues?.[0].params).toEqual({ groupId: "test-group" });
    expect(restored.issues?.[0].bindings).toEqual(["h"]);
  });

  it("round-trips a concord-envelope record with channel params", () => {
    const script = fixture([
      record({
        preset: "concord",
        bindings: ["channel"],
        envelope: "concord" as const,
        params: { channelId: "ab".repeat(32), epoch: "0" },
      }),
    ]);
    const restored = deserializeTalkScript(serializeTalkScript(script));
    expect(restored).toEqual(script);
    expect(restored.issues?.[0].envelope).toBe("concord");
    expect(restored.issues?.[0].params).toEqual({
      channelId: "ab".repeat(32),
      epoch: "0",
    });
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

  it("round-trips through localStorage in canonical form", () => {
    savePublishRelays(["wss://a.example.com", "ws://b.example.com"]);
    expect(loadPublishRelays()).toEqual([
      "wss://a.example.com/",
      "ws://b.example.com/",
    ]);
  });

  it("drops stored entries that are not ws/wss urls", () => {
    localStorage.setItem(
      RELAY_STORAGE_KEY,
      JSON.stringify(["wss://ok.example.com", "https://evil.example.com", 42]),
    );
    expect(loadPublishRelays()).toEqual(["wss://ok.example.com/"]);
  });

  it("canonicalizes and dedupes stored entries", () => {
    localStorage.setItem(
      RELAY_STORAGE_KEY,
      JSON.stringify([
        "wss://nos.lol",
        "wss://nos.lol/",
        "wss://a.example.com",
      ]),
    );
    expect(loadPublishRelays()).toEqual([
      "wss://nos.lol/",
      "wss://a.example.com/",
    ]);
  });

  it("dedupes on save as well as load", () => {
    savePublishRelays(["wss://a.example.com", "wss://a.example.com/"]);
    expect(JSON.parse(localStorage.getItem(RELAY_STORAGE_KEY)!)).toEqual([
      "wss://a.example.com/",
    ]);
    expect(loadPublishRelays()).toEqual(["wss://a.example.com/"]);
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

describe("dedupeRelays", () => {
  it("collapses normalized-equivalent urls and keeps canonical form", () => {
    expect(
      dedupeRelays([
        "wss://a.example.com",
        "wss://a.example.com/",
        "wss://a.example.com:443",
        "wss://b.example.com",
      ]),
    ).toEqual(["wss://a.example.com/", "wss://b.example.com/"]);
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
  it("fills id/issuedAt and defaults bindings to none", () => {
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
    expect(rec.rootId).toBeUndefined();
    expect(rec.params).toBeUndefined();
  });

  it("stores wire bindings and non-secret params", () => {
    const rec = createIssueRecord({
      preset: "nip29-chat",
      relays: ["wss://groups.example.com"],
      bindings: ["h"],
      params: { groupId: "test-group" },
      results: { ev1: "ok" },
    });
    expect(rec.bindings).toEqual(["h"]);
    expect(rec.params).toEqual({ groupId: "test-group" });
  });

  it("stores the optional rootId", () => {
    const rec = createIssueRecord({
      preset: "public-plain",
      relays: ["wss://nos.lol"],
      rootId: "f".repeat(64),
      results: { ev1: "ok" },
    });
    expect(rec.rootId).toBe("f".repeat(64));
  });
});

describe("ISSUE_PRESETS", () => {
  it("describes every preset on the 3 issuance axes", () => {
    for (const preset of Object.values(ISSUE_PRESETS)) {
      expect(["plain", "concord"]).toContain(preset.envelope);
      expect(Array.isArray(preset.bindings)).toBe(true);
      expect(Array.isArray(preset.clientLinks)).toBe(true);
    }
    expect(ISSUE_PRESETS["public-plain"].clientLinks[0].urlTemplate).toContain(
      "{nevent}",
    );
  });

  it("registers the M3c-sweep client presets with their verified URL formats", () => {
    expect(ISSUE_PRESETS["ditto-plain"].clientLinks[0].urlTemplate).toBe(
      "https://ditto.pub/{nevent}",
    );
    expect(ISSUE_PRESETS["grimoire-plain"].clientLinks[0].urlTemplate).toBe(
      "https://grimoire.rocks/{nevent}",
    );
  });

  it("gives every clientLink a {nevent} placeholder and a label", () => {
    for (const preset of Object.values(ISSUE_PRESETS)) {
      for (const link of preset.clientLinks) {
        expect(link.label.length).toBeGreaterThan(0);
        expect(link.urlTemplate).toContain("{nevent}");
        // https:// for web viewers; nostr: is the verified Android
        // deep-link scheme (Amethyst resolves nostr: URIs directly)
        expect(
          ["https://", "nostr:"].some((s) => link.urlTemplate.startsWith(s)),
        ).toBe(true);
      }
    }
  });

  it("registers the Amethyst preset with the verified deep link", () => {
    // C5c verification on Android: nostr:nevent… opens Amethyst's Thread
    // view; https://njump.me/… resolves to the default browser instead
    const preset: IssuePreset = ISSUE_PRESETS["amethyst-plain"];
    expect(preset.clientLinks[0].urlTemplate).toBe("nostr:{nevent}");
    expect(preset.clientLinks[1].urlTemplate).toBe(
      "https://njump.me/{nevent}",
    );
  });

  it("offers at least one disabled preset announcing future work", () => {
    const disabled = Object.values(ISSUE_PRESETS).filter(
      (p: IssuePreset) => p.disabledReason !== undefined,
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const p of disabled) expect(p.publishes).toBe(false);
  });

  it("enables the h-bind and nip29-chat wire presets with a groupId param", () => {
    for (const id of ["h-bind", "nip29-chat"] as const) {
      const preset: IssuePreset = ISSUE_PRESETS[id];
      expect(preset.publishes).toBe(true);
      expect(preset.bindings).toEqual(["h"]);
      expect(preset.wire).toBe(id);
      expect(preset.disabledReason).toBeUndefined();
      expect(preset.params?.map((p) => p.key)).toEqual(["groupId"]);
    }
  });

  it("enables the concord preset with channel params, key kept secret", () => {
    const preset: IssuePreset = ISSUE_PRESETS["concord"];
    expect(preset.publishes).toBe(true);
    expect(preset.bindings).toEqual(["channel"]);
    expect(preset.envelope).toBe("concord");
    expect(preset.wire).toBeUndefined();
    expect(preset.clientLinks).toEqual([]);
    expect(preset.mintableChannel).toBe(true);
    const keys = preset.params?.map((p) => p.key);
    expect(keys).toEqual(["channelId", "channelKey", "epoch"]);
    const channelKey = preset.params?.find((p) => p.key === "channelKey");
    expect(channelKey?.secret).toBe(true);
    const epoch = preset.params?.find((p) => p.key === "epoch");
    expect(epoch?.defaultValue).toBe("0");
    // the secret param never reaches the record
    expect(
      recordableParams(preset, {
        channelId: "ab".repeat(32),
        channelKey: "cd".repeat(32),
        epoch: "3",
      }),
    ).toEqual({ channelId: "ab".repeat(32), epoch: "3" });
    // an untouched epoch still records its default
    expect(
      recordableParams(preset, {
        channelId: "ab".repeat(32),
        channelKey: "cd".repeat(32),
      }),
    ).toEqual({ channelId: "ab".repeat(32), epoch: "0" });
  });

  it("getIssuePreset returns undefined for unknown ids", () => {
    expect(getIssuePreset("public-plain")?.label).toBeTruthy();
    expect(getIssuePreset("no-such-preset")).toBeUndefined();
  });
});

describe("issueLinks", () => {
  const rootId = "f".repeat(64);
  const relays = ["wss://nos.lol/", "wss://nostr.mom/"];
  const okResults = { [rootId]: "ok" };
  // presets with no clientLinks of their own fall back to this link
  const NJUMP_FALLBACK = {
    label: "njump で開く",
    urlTemplate: "https://njump.me/{nevent}",
  };

  it("builds an njump link whose nevent restores id + relays", () => {
    const links = issueLinks({
      preset: "public-plain",
      relays,
      rootId,
      results: okResults,
    });
    expect(links).toHaveLength(1);
    expect(links[0].label).toBe("njump で開く");
    const nevent = links[0].url.replace("https://njump.me/", "");
    expect(nevent.startsWith("nevent1")).toBe(true);
    const decoded = nip19.decode(nevent);
    expect(decoded.type).toBe("nevent");
    if (decoded.type !== "nevent") throw new Error("unreachable");
    expect(decoded.data.id).toBe(rootId);
    expect(decoded.data.relays).toEqual(relays);
  });

  it("substitutes {nevent} into the preset's urlTemplate", () => {
    const links = issueLinks({
      preset: "public-plain",
      relays,
      rootId,
      results: okResults,
    });
    const expected = nip19.neventEncode({ id: rootId, relays });
    expect(links[0].url).toBe(`https://njump.me/${expected}`);
  });

  it("substitutes {nevent} into every client preset's urlTemplate", () => {
    const expected = nip19.neventEncode({ id: rootId, relays });
    for (const [id, preset] of Object.entries(ISSUE_PRESETS)) {
      const links = issueLinks({
        preset: id,
        relays,
        rootId,
        results: okResults,
      });
      const templates = preset.clientLinks.length
        ? preset.clientLinks
        : [NJUMP_FALLBACK];
      expect(links).toHaveLength(templates.length);
      templates.forEach((t, i) => {
        expect(links[i].label).toBe(t.label);
        expect(links[i].url).toBe(t.urlTemplate.replace("{nevent}", expected));
      });
    }
  });

  it("falls back to njump for unknown preset ids", () => {
    const links = issueLinks({
      preset: "future-preset",
      relays,
      rootId,
      results: okResults,
    });
    expect(links).toHaveLength(1);
    expect(links[0].url).toMatch(/^https:\/\/njump\.me\/nevent1/);
  });

  it("returns no links without a rootId", () => {
    expect(
      issueLinks({ preset: "public-plain", relays, results: okResults }),
    ).toEqual([]);
  });

  it("returns no links when the root was not ok on every relay", () => {
    expect(
      issueLinks({
        preset: "public-plain",
        relays,
        rootId,
        results: { [rootId]: "wss://nostr.mom: rejected" },
      }),
    ).toEqual([]);
  });
});
