import { describe, expect, it } from "vitest";
import { compileScript } from "./compile";
import { buildTalkTree } from "./tree";
import type { DraftEvent, TalkScript } from "./types";

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
      { id: "l3", personaId: "pa", content: "nested", offsetSec: 120, replyTo: "l2" },
      { id: "l4", personaId: "pb", content: "also root", offsetSec: 180 },
    ],
  };
}

describe("buildTalkTree", () => {
  it("nests comments under the event their parent-scope e tag points at", () => {
    const { events } = compileScript(fixture());
    const tree = buildTalkTree(events);

    expect(tree?.event).toBe(events[0]);
    // l2 (reply to root) and l4 (no replyTo) are direct children of the root
    expect(tree?.children.map((n) => n.event)).toEqual([events[1], events[3]]);
    expect(tree?.children[0].children.map((n) => n.event)).toEqual([events[2]]);
    expect(tree?.children[0].children[0].children).toEqual([]);
    expect(tree?.children[1].children).toEqual([]);
  });

  it("attaches events whose parent id is unresolvable under the root", () => {
    const { events } = compileScript(fixture());
    const orphan: DraftEvent = {
      ...events[1],
      id: "orphan-id",
      tags: [["e", "missing-parent-id"]],
    };
    const tree = buildTalkTree([events[0], events[1], orphan]);

    expect(tree?.children.map((n) => n.event.id)).toEqual([
      events[1].id,
      "orphan-id",
    ]);
    expect(tree?.children[1].children).toEqual([]);
  });

  it("treats comments with no e tag as root children", () => {
    const { events } = compileScript(fixture());
    const noParent: DraftEvent = { ...events[1], id: "no-e-tag", tags: [] };
    const tree = buildTalkTree([events[0], noParent]);
    expect(tree?.children.map((n) => n.event.id)).toEqual(["no-e-tag"]);
  });

  it("returns null for an empty event list", () => {
    expect(buildTalkTree([])).toBeNull();
  });
});
