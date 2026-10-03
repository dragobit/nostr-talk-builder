/**
 * E2E against real public relays for the Concord envelope preset:
 * build rumor -> seal -> wrap for a small script, publish the wraps,
 * then REQ {ids:[...]} to confirm arrival and openWrap the fetched
 * events to prove the channel coordinate decrypts them back.
 *
 * (Publish OK replies may legitimately "Timeout" on these relays — the
 * ids: query is the arrival verdict, matching the M3a/M3c quirk notes.)
 *
 * Run: npx vitest run -c vitest.e2e.ts e2e/concord.e2e.ts   (not part of npm test)
 */
import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { compileScript } from "../src/lib/talkscript/compile";
import { signTalk } from "../src/lib/talkscript/sign";
import type { TalkScript } from "../src/lib/talkscript/types";
import { deriveChannelStream, mintChannel } from "../src/lib/concord/derive";
import {
  buildRumor,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "../src/lib/concord/envelope";

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

describe("Concord envelope E2E (public relays)", () => {
  it("publishes wraps, finds them by ids, and round-trips the rumors", async () => {
    const now = Math.floor(Date.now() / 1000);
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const script: TalkScript = {
      version: 1,
      id: "concord-e2e",
      title: "Concord E2E",
      baseTimeSec: now - 60,
      personas: [
        { id: "pa", name: "A", key: bytesToHex(skA) },
        { id: "pb", name: "B", key: bytesToHex(skB) },
      ],
      lines: [
        {
          id: "l0",
          personaId: "pa",
          content: "concord e2e root",
          offsetSec: 0,
        },
        {
          id: "l1",
          personaId: "pb",
          content: "concord e2e reply",
          offsetSec: 5,
          replyTo: "l0",
        },
      ],
    };

    // signed canonical IR -> rumor -> seal -> wrap
    const signed = signTalk(script, compileScript(script));
    expect(signed.events).toHaveLength(2);
    const channel = mintChannel();
    const stream = deriveChannelStream({
      channelIdHex: channel.channelId,
      channelKeyHex: channel.channelKey,
      epoch: channel.epoch,
    });
    const skByPubkey = new Map([
      [getPublicKey(skA), skA],
      [getPublicKey(skB), skB],
    ]);
    const rumors = signed.events.map((ir) =>
      buildRumor(ir, channel.channelId, channel.epoch),
    );
    const wraps = rumors.map((rumor) =>
      wrapSeal(sealRumor(rumor, stream, skByPubkey.get(rumor.pubkey)!), stream),
    );
    console.log(
      `channel id=${channel.channelId.slice(0, 16)}… stream=${stream.pk.slice(0, 16)}… wraps=${wraps.length}`,
    );

    // ---- publish every wrap to every relay, collecting raw OK answers
    const publishRes: Record<string, Record<string, string>> = {};
    for (const relay of RELAYS) {
      const conn = await Conn.open(relay);
      for (const wrap of wraps) {
        const res = await conn.publish(wrap);
        publishRes[wrap.id] = {
          ...(publishRes[wrap.id] ?? {}),
          [relay]: res.ok ? "ok" : res.message,
        };
        console.log(
          `  ${relay} kind ${wrap.kind} ${wrap.id.slice(0, 12)}… -> ${res.ok ? "ok" : res.message}`,
        );
      }
      conn.close();
    }

    // ---- arrival check: ids: query on each relay ("Timeout" OKs don't count)
    const wrapIds = wraps.map((w) => w.id);
    const arrived: Record<string, Set<string>> = {};
    for (const relay of RELAYS) {
      const conn = await Conn.open(relay);
      const found = await conn.reqIds(wrapIds);
      arrived[relay] = new Set(found.map((e) => e.id));
      console.log(`  ${relay} ids: -> ${found.length}/${wraps.length} found`);
      conn.close();
    }
    const reachableSomewhere = wrapIds.filter((id) =>
      Object.values(arrived).some((set) => set.has(id)),
    );
    expect(reachableSomewhere.length).toBe(wrapIds.length);

    // ---- full round-trip: fetch a wrap back and decrypt through openWrap
    const conn = await Conn.open(RELAYS[0]);
    const fetched = await conn.reqIds(wrapIds);
    conn.close();
    expect(fetched.length).toBeGreaterThan(0);
    for (const wrap of fetched) {
      const opened = openWrap(wrap, stream);
      checkChannelBinding(
        opened.rumor,
        channel.channelId,
        BigInt(channel.epoch),
      );
      const rumor = rumors.find((r) => r.id === opened.rumor.id);
      expect(rumor).toBeDefined();
      expect(opened.rumor.content).toBe(rumor!.content);
    }
    console.log(
      `SUMMARY wraps=${wraps.length} arrivedAnywhere=${reachableSomewhere.length} fetched+opened=${fetched.length}`,
    );
  });
});
