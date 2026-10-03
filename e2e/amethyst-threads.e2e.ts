/**
 * C5c Amethyst verification harness (local-only, real relays):
 * publishes two kind 11 + kind 1111 threads — one with a depth-2
 * nested reply chain, one fully flat (every comment parent = root) —
 * to nos.lol + nostr.mom, confirms arrival by ids: query, and prints
 * the root event ids plus relay-hinted nevents to open in a client.
 *
 * (Publish OK replies may legitimately "Timeout" on these relays — the
 * ids: query is the arrival verdict, matching the M3a/M3c quirk notes.)
 *
 * Run: npx vitest run -c vitest.e2e.ts e2e/amethyst-threads.e2e.ts
 */
import { describe, expect, it } from "vitest";
import { generateSecretKey, nip19, type NostrEvent } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { compileScript } from "../src/lib/talkscript/compile";
import { signTalk } from "../src/lib/talkscript/sign";
import type { TalkScript } from "../src/lib/talkscript/types";

const RELAYS = ["wss://nos.lol", "wss://nostr.mom"];

type WsMsg = [string, ...unknown[]];

class Conn {
  ws!: WebSocket;
  msgs: WsMsg[] = [];
  private waiters: ((m: WsMsg) => boolean)[] = [];

  static async open(url: string): Promise<Conn> {
    const c = new Conn();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error("ws connect timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(t);
        c.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
      ws.onmessage = (ev) => c.onMsg(JSON.parse(String(ev.data)) as WsMsg);
    });
    return c;
  }

  private onMsg(m: WsMsg) {
    this.msgs.push(m);
    this.waiters = this.waiters.filter((w) => !w(m));
  }

  private wait(pred: (m: WsMsg) => boolean, ms = 12000): Promise<WsMsg> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("wait timeout")), ms);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  }

  send(m: unknown[]) {
    this.ws.send(JSON.stringify(m));
  }

  async publish(ev: NostrEvent): Promise<{ ok: boolean; message: string }> {
    this.send(["EVENT", ev]);
    const ok = await this.wait(
      (m) => m[0] === "OK" && m[1] === ev.id,
      12000,
    ).catch(() => null);
    if (!ok) return { ok: false, message: "Timeout" };
    return { ok: ok[2] === true, message: String(ok[3] ?? "") };
  }

  async reqIds(ids: string[]): Promise<NostrEvent[]> {
    const sub = `e2e-${Math.random().toString(36).slice(2, 8)}`;
    this.send(["REQ", sub, { ids }]);
    const before = this.msgs.length;
    await this.wait((m) => m[0] === "EOSE" && m[1] === sub);
    const events = this.msgs
      .slice(before)
      .filter((m) => m[0] === "EVENT" && m[1] === sub)
      .map((m) => m[2] as NostrEvent);
    this.send(["CLOSE", sub]);
    return events;
  }

  close() {
    this.ws.close();
  }
}

interface Published {
  label: string;
  rootId: string;
  nevent: string;
  eventIds: string[];
}

async function publishScript(
  label: string,
  script: TalkScript,
): Promise<Published> {
  const signed = signTalk(script, compileScript(script));
  expect(signed.skippedLineIds).toHaveLength(0);
  const ids = signed.events.map((e) => e.id);

  for (const relay of RELAYS) {
    const conn = await Conn.open(relay);
    for (const ev of signed.events) {
      const res = await conn.publish(ev);
      console.log(
        `  ${label} ${relay} kind ${ev.kind} ${ev.id.slice(0, 12)}… -> ${res.ok ? "ok" : res.message}`,
      );
    }
    conn.close();
  }

  const arrived: Record<string, Set<string>> = {};
  for (const relay of RELAYS) {
    const conn = await Conn.open(relay);
    const found = await conn.reqIds(ids);
    arrived[relay] = new Set(found.map((e) => e.id));
    console.log(`  ${label} ${relay} ids: -> ${found.length}/${ids.length}`);
    conn.close();
  }
  const reachable = ids.filter((id) =>
    Object.values(arrived).some((set) => set.has(id)),
  ).length;
  expect(reachable).toBe(ids.length);

  const rootId = signed.events[0].id;
  return {
    label,
    rootId,
    nevent: nip19.neventEncode({ id: rootId, relays: RELAYS }),
    eventIds: ids,
  };
}

describe("C5c Amethyst thread fixtures (public relays)", () => {
  it("publishes nested and flat kind 11/1111 threads", async () => {
    const now = Math.floor(Date.now() / 1000);
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const skC = generateSecretKey();
    const personas = [
      { id: "alice", name: "Alice", key: bytesToHex(skA) },
      { id: "bob", name: "Bob", key: bytesToHex(skB) },
      { id: "carol", name: "Carol", key: bytesToHex(skC) },
    ];

    // depth-2 chains: bob->root, carol->bob; carol->root, bob->carol
    const nested: TalkScript = {
      version: 1,
      id: "c5c-nested",
      title: "C5c nested thread (kind 11 + 1111)",
      baseTimeSec: now - 300,
      personas,
      lines: [
        {
          id: "l0",
          personaId: "alice",
          content:
            "C5c Amethyst verification — nested thread. This kind 11 root post carries subject+title tags. Replies below are kind 1111 NIP-22 comments with a depth-2 chain.",
          offsetSec: 0,
        },
        {
          id: "l1",
          personaId: "bob",
          content: "Bob: level-1 reply to the root.",
          offsetSec: 30,
          replyTo: "l0",
        },
        {
          id: "l2",
          personaId: "carol",
          content: "Carol: depth-2 reply to Bob.",
          offsetSec: 60,
          replyTo: "l1",
        },
        {
          id: "l3",
          personaId: "carol",
          content: "Carol: second level-1 branch under the root.",
          offsetSec: 90,
          replyTo: "l0",
        },
        {
          id: "l4",
          personaId: "bob",
          content: "Bob: depth-2 reply to Carol.",
          offsetSec: 120,
          replyTo: "l3",
        },
      ],
    };

    // every comment replies to the root (flat / Discord-shaped script)
    const flat: TalkScript = {
      version: 1,
      id: "c5c-flat",
      title: "C5c flat thread (kind 11 + 1111)",
      baseTimeSec: now - 300,
      personas,
      lines: [
        {
          id: "l0",
          personaId: "alice",
          content:
            "C5c Amethyst verification — flat thread. Every kind 1111 comment below has parent = this root (no nesting).",
          offsetSec: 0,
        },
        {
          id: "l1",
          personaId: "bob",
          content: "Bob: flat comment 1.",
          offsetSec: 30,
        },
        {
          id: "l2",
          personaId: "carol",
          content: "Carol: flat comment 2.",
          offsetSec: 60,
        },
        {
          id: "l3",
          personaId: "alice",
          content: "Alice: flat comment 3.",
          offsetSec: 90,
        },
        {
          id: "l4",
          personaId: "bob",
          content: "Bob: flat comment 4.",
          offsetSec: 120,
        },
      ],
    };

    const results = [
      await publishScript("nested", nested),
      await publishScript("flat", flat),
    ];
    console.log("=== RESULT ===");
    for (const r of results) {
      console.log(`${r.label} rootId=${r.rootId}`);
      console.log(`${r.label} nevent=${r.nevent}`);
    }
  });
});
