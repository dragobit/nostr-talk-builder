/**
 * E2E for the Concord channel reader (M5-A) against real public relays:
 * mint a channel, seal+wrap a conversation containing kind 9 AND kind
 * 1111 rumors (plus a kind 11 root and a kind 7 reaction for the skip
 * aggregate), publish the wraps, then run fetchRumors/foldRumors on the
 * same coordinate and assert every line decrypts and every row appears.
 *
 * (Publish OK replies may legitimately "Timeout" on these relays — the
 * ids: query is the arrival verdict, same quirk as concord.e2e.ts.)
 *
 * Run: npx vitest run -c vitest.e2e.ts e2e/concord-read.e2e.ts
 * (not part of npm test)
 */
import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { deriveChannelStream, mintChannel } from "../src/lib/concord/derive";
import {
  buildRumor,
  sealRumor,
  wrapSeal,
  type Rumor,
} from "../src/lib/concord/envelope";
import {
  fetchRumors,
  foldRumors,
  type FetchWraps,
} from "../src/lib/concord/read";

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

  /** Publish and return the OK; a missing OK is reported, not thrown. */
  async publish(ev: NostrEvent): Promise<{ ok: boolean; message: string }> {
    this.send(["EVENT", ev]);
    const ok = await this.wait(
      (m) => m[0] === "OK" && m[1] === ev.id,
      12000,
    ).catch(() => null);
    if (!ok) return { ok: false, message: "Timeout" };
    return { ok: ok[2] === true, message: String(ok[3] ?? "") };
  }

  /** One-shot REQ: collect events until EOSE, honoring the whole filter
   * (until/limit included — this is what drives fetchRumors paging). */
  async req(filter: Filter): Promise<NostrEvent[]> {
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

describe("Concord channel reader E2E (public relays)", () => {
  it("fetchRumors decrypts every wrap and folds kind 9 + 1111 rows", async () => {
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

    // canonical IR events — kind 9 is not part of the app's IR so all
    // rumor fixtures are authored directly
    const root = finalizeEvent(
      { kind: 11, content: "concord-read e2e root", tags: [], created_at: now - 60 },
      skA,
    );
    const reply = finalizeEvent(
      {
        kind: 1111,
        content: "concord-read e2e reply",
        tags: [
          ["e", root.id],
          ["E", root.id],
        ],
        created_at: now - 55,
      },
      skB,
    );
    const nested = finalizeEvent(
      {
        kind: 1111,
        content: "concord-read e2e nested reply",
        tags: [
          ["e", reply.id],
          ["E", root.id],
        ],
        created_at: now - 50,
      },
      skA,
    );
    const chat = finalizeEvent(
      {
        kind: 9,
        content: "concord-read e2e kind 9 quoting the root",
        tags: [["q", root.id]],
        created_at: now - 45,
      },
      skB,
    );
    const chat2 = finalizeEvent(
      {
        kind: 9,
        content: "concord-read e2e kind 9 plain",
        tags: [],
        created_at: now - 40,
      },
      skA,
    );
    const react = finalizeEvent(
      {
        kind: 7,
        content: "+",
        tags: [["e", root.id]],
        created_at: now - 35,
      },
      skB,
    );
    const irs = [root, reply, nested, chat, chat2, react];

    const skByPubkey = new Map([
      [getPublicKey(skA), skA],
      [getPublicKey(skB), skB],
    ]);
    const rumors: Rumor[] = irs.map((ir) =>
      buildRumor(ir, channel.channelId, channel.epoch),
    );
    const wraps = rumors.map((rumor) =>
      wrapSeal(sealRumor(rumor, stream, skByPubkey.get(rumor.pubkey)!), stream),
    );
    console.log(
      `channel id=${channel.channelId.slice(0, 16)}… stream=${stream.pk.slice(0, 16)}… wraps=${wraps.length}`,
    );

    // ---- publish every wrap to every relay
    for (const relay of RELAYS) {
      const conn = await Conn.open(relay);
      for (const wrap of wraps) {
        const res = await conn.publish(wrap);
        console.log(
          `  ${relay} kind ${wrap.kind} ${wrap.id.slice(0, 12)}… -> ${res.ok ? "ok" : res.message}`,
        );
      }
      conn.close();
    }

    // ---- arrival check: ids: query on each relay
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

    // ---- the reader: fetchRumors over a real REQ transport, then fold
    const conns = new Map<string, Conn>();
    const connFor = async (url: string) => {
      let c = conns.get(url);
      if (!c || c.ws.readyState !== WebSocket.OPEN) {
        c = await Conn.open(url);
        conns.set(url, c);
      }
      return c;
    };
    const fetchWraps: FetchWraps = async (relays, filters) => {
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
    let progress = 0;
    const result = await fetchRumors(coordinate, RELAYS, fetchWraps, {
      onProgress: (n) => {
        progress = n;
      },
    });
    for (const c of conns.values()) c.close();
    console.log(
      `fetchRumors: pages=${result.pagesFetched} wraps→rumors=${result.rumors.size} errors=${result.errors.length} mayHaveMore=${result.mayHaveMore} progress=${progress}`,
    );
    for (const e of result.errors) {
      console.log(`  wrap error ${e.wrapId.slice(0, 12)}… — ${e.reason}`);
    }

    // every line decrypts: all authored rumors recovered verbatim
    expect(result.errors).toHaveLength(0);
    expect(result.rumors.size).toBe(rumors.length);
    for (const rumor of rumors) {
      expect(result.rumors.get(rumor.id)?.content).toBe(rumor.content);
    }

    // fold: kind 9 + 1111 become rows, everything else aggregates
    const fold = foldRumors(result.rumors.values());
    const rowsByContent = new Map(
      fold.rows.map((r) => [r.rumor.content, r]),
    );
    expect(fold.rows).toHaveLength(4);
    for (const content of [
      "concord-read e2e reply",
      "concord-read e2e nested reply",
      "concord-read e2e kind 9 quoting the root",
      "concord-read e2e kind 9 plain",
    ]) {
      expect(rowsByContent.has(content)).toBe(true);
    }
    // kind 11 root + kind 7 reaction land in the skipped aggregate
    expect(fold.skipped.get(11)).toBe(1);
    expect(fold.skipped.get(7)).toBe(1);

    // references resolve through the canonical (pre-binding) ids: the q/e
    // tags point at IR event ids, not rumor ids
    const chatRow = rowsByContent.get("concord-read e2e kind 9 quoting the root")!;
    expect(chatRow.quote?.id).toBe(root.id);
    expect(chatRow.quote?.resolved?.content).toBe(root.content);
    const nestedRow = rowsByContent.get("concord-read e2e nested reply")!;
    expect(nestedRow.quote?.resolved?.content).toBe(reply.content);
    expect(nestedRow.depth).toBe(1);
    expect(rowsByContent.get("concord-read e2e reply")!.depth).toBe(0);
    // created_at asc ordering: oldest row first
    expect(fold.rows[0].rumor.content).toBe("concord-read e2e reply");
    console.log(
      `fold: rows=${fold.rows.length} skipped=${[...fold.skipped.entries()].map(([k, c]) => `${k}x${c}`).join(",")} quotes-resolved=${fold.rows.filter((r) => r.quote?.resolved).length}`,
    );
  });
});
