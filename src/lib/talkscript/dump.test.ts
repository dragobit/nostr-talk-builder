import { describe, expect, it } from "vitest";
import { compileScript } from "./compile";
import { dumpEventsJsonl } from "./dump";
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
    ],
    lines: [
      { id: "l1", personaId: "pa", content: "root", offsetSec: 0 },
      { id: "l2", personaId: "pb", content: "reply", offsetSec: 60, replyTo: "l1" },
    ],
  };
}

describe("dumpEventsJsonl", () => {
  it("serializes one JSON object per line without sig on drafts", () => {
    const { events } = compileScript(fixture());
    const lines = dumpEventsJsonl(events).split("\n");

    expect(lines).toHaveLength(events.length);
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toEqual(events[i]);
      expect(parsed).not.toHaveProperty("sig");
    });
  });

  it("includes the full signed fields (id, sig) for signed events", () => {
    const script = fixture();
    const compiled = compileScript(script);
    const signed = signTalk(script, compiled).events;
    const lines = dumpEventsJsonl(signed).split("\n");

    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string; sig: string };
      expect(parsed.id).toHaveLength(64);
      expect(parsed.sig).toHaveLength(128);
    }
  });

  it("produces an empty string for no events", () => {
    expect(dumpEventsJsonl([])).toBe("");
  });
});
