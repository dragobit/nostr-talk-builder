import { beforeEach, describe, expect, it } from "vitest";
import { compileScript } from "./compile";
import {
  deserializeTalkScript,
  loadStoredScript,
  saveStoredScript,
  SCRIPT_STORAGE_KEY,
  serializeTalkScript,
  suggestedExportFilename,
  TalkScriptParseError,
} from "./persist";
import { TALK_SCRIPT_VERSION, type TalkScript } from "./types";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function fixture(): TalkScript {
  return {
    version: TALK_SCRIPT_VERSION,
    id: "script-1",
    title: "テスト会話",
    baseTimeSec: 1_700_000_000,
    personas: [
      { id: "pa", name: "A", key: KEY_A },
      {
        id: "pb",
        name: "B",
        key: `nsec1${KEY_B}`,
        pubkey: "c".repeat(64),
      },
    ],
    lines: [
      { id: "l1", personaId: "pa", content: "first", offsetSec: 0 },
      { id: "l2", personaId: "pb", content: "second", offsetSec: 60, replyTo: "l1" },
      { id: "l3", personaId: "pa", content: "third", offsetSec: 120 },
    ],
  };
}

describe("serializeTalkScript / deserializeTalkScript", () => {
  it("round-trips personas, lines, and held keys", () => {
    const script = fixture();
    const restored = deserializeTalkScript(serializeTalkScript(script));
    expect(restored).toEqual(script);
    expect(restored.personas[1].key).toBe(`nsec1${KEY_B}`);
  });

  it("rejects a script whose version differs from TALK_SCRIPT_VERSION", () => {
    for (const version of [0, TALK_SCRIPT_VERSION + 1, "2"]) {
      const json = JSON.stringify({ ...fixture(), version });
      expect(() => deserializeTalkScript(json)).toThrow(TalkScriptParseError);
      expect(() => deserializeTalkScript(json)).toThrow(/version/);
    }
  });

  it("rejects malformed JSON and malformed shapes", () => {
    expect(() => deserializeTalkScript("{not json")).toThrow(
      TalkScriptParseError,
    );
    expect(() => deserializeTalkScript("42")).toThrow(TalkScriptParseError);
    expect(() =>
      deserializeTalkScript(JSON.stringify({ version: TALK_SCRIPT_VERSION })),
    ).toThrow(TalkScriptParseError);
    expect(() =>
      deserializeTalkScript(
        JSON.stringify({ ...fixture(), personas: "alice" }),
      ),
    ).toThrow(TalkScriptParseError);
    expect(() =>
      deserializeTalkScript(
        JSON.stringify({ ...fixture(), lines: [{ id: "l1" }] }),
      ),
    ).toThrow(TalkScriptParseError);
  });

  it("restores a script that compiles identically (determinism preserved)", () => {
    const script = fixture();
    const restored = deserializeTalkScript(serializeTalkScript(script));
    expect(compileScript(restored)).toEqual(compileScript(script));
  });
});

describe("loadStoredScript / saveStoredScript", () => {
  beforeEach(() => {
    localStorage.removeItem(SCRIPT_STORAGE_KEY);
  });

  it("reports empty when nothing is stored", () => {
    expect(loadStoredScript().status).toBe("empty");
  });

  it("round-trips through localStorage", () => {
    const script = fixture();
    saveStoredScript(script);
    expect(loadStoredScript()).toEqual({ status: "ok", script });
  });

  it("reports invalid when stored data fails validation", () => {
    localStorage.setItem(
      SCRIPT_STORAGE_KEY,
      JSON.stringify({ ...fixture(), version: 99 }),
    );
    const stored = loadStoredScript();
    expect(stored.status).toBe("invalid");
    if (stored.status === "invalid") expect(stored.error).toMatch(/version/);
  });
});

describe("suggestedExportFilename", () => {
  it("derives a .json filename from the title and strips hostile chars", () => {
    expect(suggestedExportFilename(fixture())).toBe("テスト会話.json");
    expect(
      suggestedExportFilename({ ...fixture(), title: 'a/b\\c:d*e?"f<g>h|i' }),
    ).toBe("abcdefghi.json");
    expect(suggestedExportFilename({ ...fixture(), title: "  " })).toBe(
      "talk-script.json",
    );
  });
});
