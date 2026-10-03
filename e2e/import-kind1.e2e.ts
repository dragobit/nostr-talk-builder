/**
 * E2E for the kind 1 / NIP-10 importer (M5-B1) against real public
 * relays: publish a kind-1 thread exercising every NIP-10 interpretation
 * path (marked root/reply, deprecated positional, mention, missing
 * parent, earlier-than-root created_at, over-depth chain), then import
 * by the root's note AND by a mid-thread leaf's note and assert the
 * rebuilt script and its warnings.
 *
 * The limit-truncation warning (>200 descendants) is covered by the unit
 * tests — spamming 200+ events to public relays just to hit it is not
 * reasonable e2e.
 *
 * (Publish OK replies may legitimately "Timeout" on these relays — the
 * ids: query is the arrival verdict.)
 *
 * Run: npx vitest run -c vitest.e2e.ts e2e/import-kind1.e2e.ts
 * (not part of npm test)
 */
import { describe, expect, it } from "vitest";
import { RelayPool } from "applesauce-relay";
import { lastValueFrom, timeout, toArray } from "rxjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type NostrEvent,
} from "nostr-tools";
import {
  importFromIdentifier,
  type FetchEvents,
} from "../src/lib/talkscript/importer";

const RELAYS = ["wss://nos.lol/", "wss://nostr.mom/"];

const pool = new RelayPool();

const fetch: FetchEvents = (relays, filters) =>
  lastValueFrom(
    pool
      .request(relays, filters)
      .pipe(timeout(90_000), toArray()),
  );

const publish = (event: NostrEvent) => pool.publish(RELAYS, event);

function log(label: string, value: unknown) {
  console.log(`[e2e] ${label}:`, JSON.stringify(value));
}

async function reachableIds(ids: string[]): Promise<Set<string>> {
  const found = await fetch(RELAYS, [{ ids }]);
  return new Set(found.map((e) => e.id));
}

const note = (
  content: string,
  sk: Uint8Array,
  created_at: number,
  tags: string[][] = [],
): NostrEvent =>
  finalizeEvent({ kind: 1, content, tags, created_at }, sk);

describe("C5b e2e: kind 1 / NIP-10 thread import against live relays", () => {
  it("publishes a marked/positional/mid-thread kind-1 thread and imports it", async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const pkA = getPublicKey(skA);
    const pkB = getPublicKey(skB);
    const T0 = Math.floor(Date.now() / 1000) - 600;
    const tag = `c5b-${T0}`;

    // --- author the thread ------------------------------------------
    const root = note(`k1 e2e root ${tag}`, skA, T0);
    const direct = note(`k1 e2e direct ${tag}`, skB, T0 + 10, [
      ["e", root.id, "", "root"],
    ]);
    const nested = note(`k1 e2e nested ${tag}`, skA, T0 + 20, [
      ["e", root.id, "", "root"],
      ["e", direct.id, "", "reply"],
    ]);
    // deprecated positional: [root, mention, parent]
    const positional = note(`k1 e2e positional ${tag}`, skB, T0 + 30, [
      ["e", root.id],
      ["e", "f".repeat(64)],
      ["e", nested.id],
    ]);
    // an e-mention of the root — matches the #e query but is NOT a member
    const mentioner = note(`k1 e2e mention ${tag}`, skB, T0 + 40, [
      ["e", root.id, "", "mention"],
    ]);
    // reply whose parent was never published → falls back to root + warn
    const orphan = note(`k1 e2e orphan ${tag}`, skA, T0 + 50, [
      ["e", root.id, "", "root"],
      ["e", "e".repeat(64), "", "reply"],
    ]);
    // created_at before the root → offset clamps to 0 + warn
    const early = note(`k1 e2e early ${tag}`, skB, T0 - 300, [
      ["e", root.id, "", "root"],
    ]);
    // over-depth chain: 6 deep (cap is 4) → flatten + warn
    const chain = [root, direct];
    for (let i = 0; i < 6; i++) {
      chain.push(
        note(`k1 e2e deep${i} ${tag}`, i % 2 ? skA : skB, T0 + 100 + i, [
          ["e", root.id, "", "root"],
          ["e", chain[chain.length - 1].id, "", "reply"],
        ]),
      );
    }
    const thread = [root, direct, nested, positional, orphan, early, ...chain.slice(2), mentioner];
    const memberContents = thread
      .filter((e) => e.id !== mentioner.id)
      .map((e) => e.content);
    log("thread ids", thread.map((e) => e.id.slice(0, 8)));

    // --- publish -----------------------------------------------------
    for (const event of thread) {
      const responses = await publish(event);
      log(`publish ${event.content.slice(0, 24)}`, responses);
    }
    const reached = await reachableIds(thread.map((e) => e.id));
    log("reachable", reached.size);
    for (const e of thread) expect(reached.has(e.id)).toBe(true);

    // --- import by the root's note -----------------------------------
    const { script, warnings } = await importFromIdentifier(
      nip19.noteEncode(root.id),
      fetch,
    );
    log("warnings (root import)", warnings);

    const contents = script.lines.map((l) => l.content);
    expect([...contents].sort()).toEqual([...memberContents].sort());
    expect(contents[0]).toBe(root.content);
    expect(script.title).toBe(root.content);
    expect(script.baseTimeSec).toBe(T0);

    const byContent = new Map(script.lines.map((l) => [l.content, l]));
    const lineOf = (e: NostrEvent) => byContent.get(e.content)!;
    expect(lineOf(direct).replyTo).toBeUndefined(); // direct child of root
    expect(lineOf(nested).replyTo).toBe(lineOf(direct).id);
    expect(lineOf(positional).replyTo).toBe(lineOf(nested).id);
    expect(lineOf(orphan).replyTo).toBeUndefined(); // parent never arrived
    expect(lineOf(early).offsetSec).toBe(0); // clamped
    expect(script.personas.map((p) => p.pubkey)).toEqual([pkA, pkB]);

    // every reachable warning path
    expect(warnings.some((w) => w.includes("フォーク"))).toBe(true);
    expect(warnings.some((w) => w.includes("収集セットに無い"))).toBe(true);
    expect(warnings.some((w) => w.includes("ルートより前"))).toBe(true);
    expect(warnings.some((w) => w.includes("深さ上限"))).toBe(true);

    // the imported script compiles into a valid IR set
    const { compileScript } = await import("../src/lib/talkscript/compile");
    const compiled = compileScript(script);
    expect(compiled.events).toHaveLength(script.lines.length);

    // --- import the same thread from a mid-thread leaf ---------------
    const { script: fromLeaf } = await importFromIdentifier(
      nip19.neventEncode({ id: nested.id, kind: 1, relays: RELAYS }),
      fetch,
    );
    expect(fromLeaf.lines.map((l) => l.content).sort()).toEqual(
      [...memberContents].sort(),
    );
    expect(fromLeaf.baseTimeSec).toBe(T0);
    log("leaf import ok", fromLeaf.lines.length);
  });
});
