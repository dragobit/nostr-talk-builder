import { describe, expect, it } from "vitest";
import { RelayPool } from "applesauce-relay";
import { lastValueFrom, timeout, toArray } from "rxjs";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { compileScript } from "../src/lib/talkscript/compile";
import {
  importFromIdentifier,
  type FetchEvents,
} from "../src/lib/talkscript/importer";
import { createIssueRecord, type PublishFn } from "../src/lib/talkscript/issue";
import {
  reissueRecord,
  resendBlockReason,
} from "../src/lib/talkscript/reissue";
import { signTalk } from "../src/lib/talkscript/sign";
import {
  TALK_SCRIPT_VERSION,
  type TalkScript,
} from "../src/lib/talkscript/types";

// Open-write test relays (same defaults the app ships with)
const RELAYS = ["wss://nos.lol/", "wss://nostr.mom/"];

const pool = new RelayPool();

const fetch: FetchEvents = (relays, filters) =>
  lastValueFrom(
    pool
      .request(relays, filters)
      // publish responses can report "Timeout" while the relay still stored
      // the event, and requests end on EOSE-or-timeout internally — this
      // outer timeout is only a backstop for a fully stalled connection
      .pipe(timeout(90_000), toArray()),
  );

const publish: PublishFn = (relays, event) => pool.publish(relays, event);

function nsecKey(): { nsec: string; pubkey: string } {
  const secret = generateSecretKey();
  return { nsec: nip19.nsecEncode(secret), pubkey: getPublicKey(secret) };
}

function log(label: string, value: unknown) {
  console.log(`[e2e] ${label}:`, JSON.stringify(value));
}

async function reachableIds(ids: string[]): Promise<Set<string>> {
  const found = await fetch(RELAYS, [{ ids }]);
  return new Set(found.map((e) => e.id));
}

describe("M4b e2e: import + resend against live relays", () => {
  it("publishes, imports by nevent, round-trips, and resends", async () => {
    // --- 1. build & sign a throwaway script -------------------------
    const alice = nsecKey();
    const bob = nsecKey();
    const baseTimeSec = Math.floor(Date.now() / 1000) - 300;
    const script: TalkScript = {
      version: TALK_SCRIPT_VERSION,
      id: crypto.randomUUID(),
      title: `m4b e2e ${baseTimeSec}`,
      baseTimeSec,
      personas: [
        { id: "pa", name: "alice", key: alice.nsec, pubkey: alice.pubkey },
        { id: "pb", name: "bob", key: bob.nsec, pubkey: bob.pubkey },
      ],
      lines: [
        { id: "l1", personaId: "pa", content: "e2e root", offsetSec: 0 },
        {
          id: "l2",
          personaId: "pb",
          content: "e2e reply",
          offsetSec: 60,
        },
        {
          id: "l3",
          personaId: "pa",
          content: "e2e nested reply",
          offsetSec: 120,
          replyTo: "l2",
        },
      ],
    };
    const compiled = compileScript(script);
    const { events, skippedLineIds } = signTalk(script, compiled);
    expect(skippedLineIds).toEqual([]);
    const ids = events.map((e) => e.id);
    const root = events[0];
    log("event ids", ids);

    // --- 2. publish to real relays ---------------------------------
    for (const event of events) {
      const responses = await publish(RELAYS, event);
      log(`publish ${event.kind} ${event.id.slice(0, 8)}`, responses);
    }

    // publish responses may report "Timeout" even when the relay stored
    // the event — reachability is judged by an ids query, not responses
    const reached = await reachableIds(ids);
    log("reachable after publish", [...reached]);
    for (const id of ids) expect(reached.has(id)).toBe(true);

    // --- 3. import the thread back via its nevent -------------------
    const nevent = nip19.neventEncode({ id: root.id, relays: RELAYS });
    log("nevent", nevent);
    const { script: imported, warnings } = await importFromIdentifier(
      nevent,
      fetch,
    );
    log("warnings", warnings);
    expect(imported.lines.map((l) => l.content)).toEqual([
      "e2e root",
      "e2e reply",
      "e2e nested reply",
    ]);
    expect(imported.title).toBe(script.title);
    expect(imported.baseTimeSec).toBe(script.baseTimeSec);
    expect(imported.personas.map((p) => p.pubkey)).toEqual([
      alice.pubkey,
      bob.pubkey,
    ]);

    // byte-identical round trip: same drafts, same ids
    const recompiled = compileScript(imported);
    expect(recompiled.events.map((e) => e.id)).toEqual(ids);
    const nestedLine = imported.lines[2];
    expect(nestedLine.replyTo).toBe(imported.lines[1].id);

    // --- 4. resend: keys re-entered (ownership), full republish -----
    const keyByPubkey = new Map([
      [alice.pubkey, alice.nsec],
      [bob.pubkey, bob.nsec],
    ]);
    for (const persona of imported.personas)
      persona.key = keyByPubkey.get(persona.pubkey!)!;

    const original = createIssueRecord({
      preset: "public-plain",
      relays: RELAYS,
      rootId: root.id,
      results: {},
    });
    expect(resendBlockReason(imported, original)).toBeNull();

    const result = await reissueRecord(imported, original, publish);
    log("resend results", result.record.results);
    expect(result.rootChanged).toBe(false);
    expect(result.record.rootId).toBe(root.id);
    expect(Object.keys(result.record.results).sort()).toEqual([...ids].sort());

    // --- 5. verify the resent events are stored on the relays -------
    const resent = await reachableIds(ids);
    log("reachable after resend", [...resent]);
    for (const id of ids) expect(resent.has(id)).toBe(true);
  });
});
