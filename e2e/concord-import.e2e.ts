/**
 * E2E for the Concord channel importer (M5-B2) against real public
 * relays — two channels:
 *
 *   A) kind-9-only: the importer synthesizes a root line, anchors
 *      baseTimeSec on the oldest rumor, maps q tags to replyTo.
 *   B) kind 11 root + kind 1111 + kind 9 + kind 7: the importer walks
 *      the canonical-id path (binding tags stripped), so a recompiled
 *      script reproduces the original IR event ids; non-thread kinds
 *      land in the skipped-kinds warning.
 *
 * (Publish OK replies may legitimately "Timeout" on these relays — the
 * ids: query is the arrival verdict.)
 *
 * Run: npx vitest run -c vitest.e2e.ts e2e/concord-import.e2e.ts
 * (not part of npm test)
 */
import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { compileScript } from "../src/lib/talkscript/compile";
import { signTalk } from "../src/lib/talkscript/sign";
import {
  TALK_SCRIPT_VERSION,
  type TalkScript,
} from "../src/lib/talkscript/types";
import { deriveChannelStream, mintChannel } from "../src/lib/concord/derive";
import {
  buildRumor,
  sealRumor,
  wrapSeal,
  type Rumor,
} from "../src/lib/concord/envelope";
import {
  importFromChannel,
  SYNTHETIC_ROOT_CONTENT,
} from "../src/lib/concord/import";
import type { FetchWraps } from "../src/lib/concord/read";

const RELAYS = ["wss://nos.lol", "wss://nostr.mom"];

type WsMsg = [string, ...unknown[]];

class Conn {
  ws!: WebSocket;
  msgs: WsMsg[] = [];
  private waiters: ((m: WsMsg) => boolean)[] = [];
  private url = "";

  /** Connect, retrying on immediate ws errors — public relays flap
   * (nostr.mom in particular refuses fresh connections for seconds at a
   * time but recovers). */
  static async open(url: string): Promise<Conn> {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await Conn.connectOnce(url);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw new Error(`ws connect failed after retries: ${String(last)}`, {
      cause: last,
    });
  }

  private static connectOnce(url: string): Promise<Conn> {
    const c = new Conn();
    c.url = url;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error("ws connect timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(t);
        c.ws = ws;
        resolve(c);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
      ws.onmessage = (ev) => c.onMsg(JSON.parse(String(ev.data)) as WsMsg);
    });
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

  async req(filter: Filter): Promise<NostrEvent[]> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      // reconnect silently if the socket dropped since the last call
      if (this.ws.readyState !== WebSocket.OPEN) {
        const fresh = await Conn.open(this.url);
        this.ws = fresh.ws;
        this.msgs = [];
      }
      try {
        return await this.reqOnce(filter);
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`req failed after retry: ${String(last)}`, {
      cause: last,
    });
  }

  private async reqOnce(filter: Filter): Promise<NostrEvent[]> {
    const sub = `e2e-${Math.random().toString(36).slice(2, 8)}`;
    this.send(["REQ", sub, filter]);
    const before = this.msgs.length;
    await this.wait((m) => m[0] === "EOSE" && m[1] === sub, 20000);
    const events = this.msgs
      .slice(before)
      .filter((m) => m[0] === "EVENT" && m[1] === sub)
      .map((m) => m[2] as NostrEvent);
    this.send(["CLOSE", sub]);
    return events;
  }

  async reqIds(ids: string[]): Promise<NostrEvent[]> {
    return this.req({ ids });
  }

  close() {
    this.ws.close();
  }
}

/** Shared live-transport FetchWraps (conn pool by relay url). */
function makeFetch(conns: Map<string, Conn>): FetchWraps {
  const connFor = async (url: string) => {
    let c = conns.get(url);
    if (!c || c.ws.readyState !== WebSocket.OPEN) {
      c = await Conn.open(url);
      conns.set(url, c);
    }
    return c;
  };
  return async (relays, filters) => {
    const out = new Map<string, NostrEvent>();
    await Promise.all(
      relays.map(async (url) => {
        const c = await connFor(url);
        for (const filter of filters) {
          for (const ev of await c.req(filter)) out.set(ev.id, ev);
        }
      }),
    );
    return [...out.values()];
  };
}

/** Seal+wrap every rumor and publish the wraps to every relay; arrival
 * is asserted by an ids: query (OK responses can lie). */
async function publishWraps(wraps: NostrEvent[]) {
  for (const relay of RELAYS) {
    const conn = await Conn.open(relay);
    for (const wrap of wraps) {
      const res = await conn.publish(wrap);
      console.log(
        `  ${relay} ${wrap.id.slice(0, 12)}… -> ${res.ok ? "ok" : res.message}`,
      );
    }
    conn.close();
  }
  const wrapIds = wraps.map((w) => w.id);
  const arrived = new Set<string>();
  for (const relay of RELAYS) {
    const conn = await Conn.open(relay);
    const found = await conn.reqIds(wrapIds);
    conn.close();
    console.log(`  ${relay} ids: -> ${found.length}/${wraps.length} found`);
    for (const e of found) arrived.add(e.id);
  }
  expect(arrived.size).toBe(wrapIds.length);
}

function rumorsFor(
  irs: NostrEvent[],
  channelId: string,
  epoch: bigint,
  stream: ReturnType<typeof deriveChannelStream>,
  skByPubkey: Map<string, Uint8Array>,
): { rumors: Rumor[]; wraps: NostrEvent[] } {
  const rumors = irs.map((ir) => buildRumor(ir, channelId, epoch));
  const wraps = rumors.map((rumor) =>
    wrapSeal(sealRumor(rumor, stream, skByPubkey.get(rumor.pubkey)!), stream),
  );
  return { rumors, wraps };
}

describe("C5b e2e: Concord channel import against live relays", () => {
  it("kind-9-only channel → synthetic root, q→replyTo, real timestamps", async () => {
    const now = Math.floor(Date.now() / 1000);
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const channel = mintChannel();
    const coordinate = {
      channelIdHex: channel.channelId,
      channelKeyHex: channel.channelKey,
      epoch: channel.epoch,
    };
    const stream = deriveChannelStream(coordinate);
    const tag = `c5b-a-${now}`;

    const parent = finalizeEvent(
      { kind: 9, content: `chat parent ${tag}`, tags: [], created_at: now - 300 },
      skA,
    );
    const child = finalizeEvent(
      {
        kind: 9,
        content: `chat quoting ${tag}`,
        tags: [["q", parent.id]],
        created_at: now - 200,
      },
      skB,
    );
    const dangling = finalizeEvent(
      {
        kind: 9,
        content: `chat dangling q ${tag}`,
        tags: [["q", "f".repeat(64)]],
        created_at: now - 100,
      },
      skA,
    );
    const { rumors, wraps } = rumorsFor(
      [parent, child, dangling],
      channel.channelId,
      channel.epoch,
      stream,
      new Map([
        [getPublicKey(skA), skA],
        [getPublicKey(skB), skB],
      ]),
    );
    console.log(`channel A id=${channel.channelId.slice(0, 16)}… wraps=${wraps.length}`);
    await publishWraps(wraps);

    const conns = new Map<string, Conn>();
    const { script, warnings } = await importFromChannel(
      coordinate,
      RELAYS,
      makeFetch(conns),
    );
    for (const c of conns.values()) c.close();
    console.log(`channel A warnings: ${JSON.stringify(warnings)}`);

    expect(script.title).toBe(`Concord ch:${channel.channelId.slice(0, 8)}`);
    expect(script.baseTimeSec).toBe(now - 300);
    expect(script.lines.map((l) => l.content)).toEqual([
      SYNTHETIC_ROOT_CONTENT,
      `chat parent ${tag}`,
      `chat quoting ${tag}`,
      `chat dangling q ${tag}`,
    ]);
    expect(script.lines[0].offsetSec).toBe(0);
    expect(script.lines[2].offsetSec).toBe(100);
    expect(script.lines[3].offsetSec).toBe(200);
    // synthetic root persona = stream key (pubkey only — always a fork)
    expect(script.personas[0].pubkey).toBe(stream.pk);
    expect(script.personas[0].key).toBeUndefined();
    expect(script.lines[2].replyTo).toBe(script.lines[1].id);
    expect(script.lines[3].replyTo).toBeUndefined(); // dangling q: silent
    expect(warnings.some((w) => w.includes("ルートは合成"))).toBe(true);
    expect(warnings.some((w) => w.includes("ch:"))).toBe(true);
    expect(() => compileScript(script)).not.toThrow();
    console.log(`channel A: ${script.lines.length} lines imported, rumors=${rumors.length}`);
  });

  it("kind 11 + 1111 channel → buildScript path, canonical ids round-trip", async () => {
    const now = Math.floor(Date.now() / 1000);
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const channel = mintChannel();
    const coordinate = {
      channelIdHex: channel.channelId,
      channelKeyHex: channel.channelKey,
      epoch: channel.epoch,
    };
    const stream = deriveChannelStream(coordinate);
    const tag = `c5b-b-${now}`;

    // author the thread through the real pipeline — TalkScript →
    // compileScript → signTalk — so the canonical-id round trip the
    // importer recovers is exactly the app's own publish output (hand-
    // authored tag layouts hash differently; the native-ref variant is
    // covered by the unit tests)
    const src: TalkScript = {
      version: TALK_SCRIPT_VERSION,
      id: "c5b-e2e",
      title: `concord thread ${tag}`,
      baseTimeSec: now - 300,
      personas: [
        {
          id: "pa",
          name: "alice",
          key: nip19.nsecEncode(skA),
          pubkey: getPublicKey(skA),
        },
        {
          id: "pb",
          name: "bob",
          key: nip19.nsecEncode(skB),
          pubkey: getPublicKey(skB),
        },
      ],
      lines: [
        {
          id: "l1",
          personaId: "pa",
          content: `concord thread root ${tag}`,
          offsetSec: 0,
        },
        {
          id: "l2",
          personaId: "pb",
          content: `concord reply ${tag}`,
          offsetSec: 100,
          replyTo: "l1",
        },
        {
          id: "l3",
          personaId: "pa",
          content: `concord nested ${tag}`,
          offsetSec: 150,
          replyTo: "l2",
        },
      ],
    };
    const { events: signedIrs } = signTalk(src, compileScript(src));
    const [root, reply, nested] = signedIrs;
    const chat = finalizeEvent(
      { kind: 9, content: `side chat ${tag}`, tags: [], created_at: now - 100 },
      skB,
    );
    const react = finalizeEvent(
      { kind: 7, content: "+", tags: [["e", root.id]], created_at: now - 50 },
      skA,
    );
    const irs = [...signedIrs, chat, react];
    const { wraps } = rumorsFor(
      irs,
      channel.channelId,
      channel.epoch,
      stream,
      new Map([
        [getPublicKey(skA), skA],
        [getPublicKey(skB), skB],
      ]),
    );
    console.log(`channel B id=${channel.channelId.slice(0, 16)}… wraps=${wraps.length}`);
    await publishWraps(wraps);

    const conns = new Map<string, Conn>();
    const { script, warnings } = await importFromChannel(
      coordinate,
      RELAYS,
      makeFetch(conns),
    );
    for (const c of conns.values()) c.close();
    console.log(`channel B warnings: ${JSON.stringify(warnings)}`);

    expect(script.title).toBe(`concord thread ${tag}`);
    expect(script.baseTimeSec).toBe(now - 300);
    expect(script.lines.map((l) => l.content)).toEqual([
      `concord thread root ${tag}`,
      `concord reply ${tag}`,
      `concord nested ${tag}`,
    ]);
    expect(script.lines[2].replyTo).toBe(script.lines[1].id);

    // canonical recovery: stripping binding tags reproduces the original
    // IR event ids on recompile — the byte-identical round trip
    const canonicalIds = [root, reply, nested].map((e) => e.id);
    expect(compileScript(script).events.map((e) => e.id)).toEqual(canonicalIds);

    // provenance + reissue + skipped-kinds warnings
    expect(warnings.some((w) => w.includes("再発行可能"))).toBe(true);
    expect(warnings.some((w) => w.includes("kind 9×1"))).toBe(true);
    expect(warnings.some((w) => w.includes("kind 7×1"))).toBe(true);
    console.log(`channel B: ${script.lines.length} lines, canonical round-trip ok`);
  });
});
