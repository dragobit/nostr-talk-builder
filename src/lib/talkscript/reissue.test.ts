import { describe, expect, it } from "vitest";
import { getPublicKey, type NostrEvent } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { compileScript } from "./compile";
import { createIssueRecord, type IssueRecord } from "./issue";
import { reissueRecord, resendBlockReason, ReissueError } from "./reissue";
import { TALK_SCRIPT_VERSION, type TalkScript } from "./types";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function fixture(): TalkScript {
  return {
    version: TALK_SCRIPT_VERSION,
    id: "script-1",
    title: "再送信テスト",
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
      { id: "l1", personaId: "pa", content: "root", offsetSec: 0 },
      { id: "l2", personaId: "pb", content: "reply", offsetSec: 60 },
    ],
  };
}

const RELAYS = ["wss://nos.lol/", "wss://nostr.mom/"];

function record(script: TalkScript, overrides: Partial<IssueRecord> = {}) {
  const rootId = compileScript(script).events[0].id;
  // overrides apply to the record itself so tests can simulate fields
  // createIssueRecord does not take (bindings/envelope of future versions)
  return {
    ...createIssueRecord({
      preset: "public-plain",
      relays: RELAYS,
      rootId,
      results: {},
    }),
    ...overrides,
  };
}

/** PublishFn stub: every relay accepts. */
const allOk =
  (sent: NostrEvent[]) => async (relays: string[], event: NostrEvent) => {
    sent.push(event);
    return relays.map((from) => ({ ok: true, from, message: "" }));
  };

describe("resendBlockReason", () => {
  it("returns null for a plain record when every persona can sign", () => {
    const script = fixture();
    expect(resendBlockReason(script, record(script))).toBeNull();
  });

  it("blocks unknown preset ids", () => {
    const script = fixture();
    const rec = record(script, { preset: "future-preset" });
    expect(resendBlockReason(script, rec)).toMatch(/存在しません/);
  });

  it("blocks no-publisher presets and records with empty relays", () => {
    const script = fixture();
    const appOnly = record(script, { preset: "app-only" });
    expect(resendBlockReason(script, appOnly)).toMatch(/リレー/);
    const noRelays = record(script, { relays: [] });
    expect(resendBlockReason(script, noRelays)).toMatch(/リレー/);
  });

  it("blocks bound issuances (preset or record bindings)", () => {
    const script = fixture();
    const bound = record(script, { preset: "h-bind", bindings: ["h"] });
    expect(resendBlockReason(script, bound)).toMatch(/束縛/);
    const recordBound = record(script, { bindings: ["h"] });
    expect(resendBlockReason(script, recordBound)).toMatch(/束縛/);
  });

  it("blocks non-plain envelopes written by future versions", () => {
    const script = fixture();
    const wrapped = { ...record(script), envelope: "nip59" as never };
    expect(resendBlockReason(script, wrapped)).toMatch(/envelope/);
  });

  it("blocks when any line's persona lacks a usable key", () => {
    const script = fixture();
    delete script.personas[1].key;
    const rec = record(script);
    expect(resendBlockReason(script, rec)).toMatch(/B/);
  });

  it("blocks when a line references a removed persona", () => {
    const script = fixture();
    const rec = record(script);
    script.personas = script.personas.filter((p) => p.id !== "pb");
    expect(resendBlockReason(script, rec)).toMatch(/pb/);
  });
});

describe("reissueRecord", () => {
  it("resends the recompiled+resigned IR to the record's relays", async () => {
    const script = fixture();
    const rec = record(script);
    const sent: NostrEvent[] = [];

    const result = await reissueRecord(script, rec, allOk(sent));

    // identical recompile: same event ids, all sent to the original relays
    const compiled = compileScript(script);
    expect(sent.map((e) => e.id)).toEqual(compiled.events.map((e) => e.id));
    expect(result.record.preset).toBe("public-plain");
    expect(result.record.relays).toEqual(RELAYS);
    expect(result.record.rootId).toBe(compiled.events[0].id);
    expect(result.rootChanged).toBe(false);
    expect(Object.values(result.record.results)).toEqual(["ok", "ok"]);
    // a fresh record: distinct id, fresh issuedAt
    expect(result.record.id).not.toBe(rec.id);
  });

  it("aggregates per-relay failures into the new record", async () => {
    const script = fixture();
    const rec = record(script);
    const publish = async (relays: string[], event: NostrEvent) => {
      void relays;
      void event;
      return [
        { ok: true, from: "wss://nos.lol/", message: "" },
        { ok: false, from: "wss://nostr.mom/", message: "timeout" },
      ];
    };
    const result = await reissueRecord(script, rec, publish);
    const rootId = compileScript(script).events[0].id;
    expect(result.record.results[rootId]).toMatch(/nostr\.mom\/: timeout/);
    expect(result.outcome[rootId]["wss://nostr.mom/"]).toEqual({
      ok: false,
      message: "timeout",
    });
  });

  it("flags rootChanged and records the new root id when the script moved on", async () => {
    const script = fixture();
    const rec = record(script);
    const edited = { ...script, title: "別タイトル" };
    const result = await reissueRecord(edited, rec, allOk([]));
    expect(result.rootChanged).toBe(true);
    expect(result.record.rootId).toBe(compileScript(edited).events[0].id);
    expect(result.record.rootId).not.toBe(rec.rootId);
  });

  it("throws ReissueError instead of sending when blocked", async () => {
    const script = fixture();
    delete script.personas[1].key;
    const rec = record(script);
    const sent: NostrEvent[] = [];
    await expect(reissueRecord(script, rec, allOk(sent))).rejects.toThrow(
      ReissueError,
    );
    expect(sent).toHaveLength(0);
  });
});
