/**
 * E2E against a local NIP-29 relay (ghcr.io/verse-pbc/groups_relay).
 * Covers: group create (9007, admin key) -> wire compile+sign ->
 * 9021 joins -> kind 9 messages -> h-bound kind 11/1111 -> REQ by #h.
 * Run: npx vitest run -c vitest.e2e.ts   (not part of npm test)
 */
import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
  type NostrEvent,
} from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { compileWire, signWireEvents } from "../src/lib/talkscript/wire";
import type { TalkScript } from "../src/lib/talkscript/types";

const joinAccepted = (r: { ok: boolean; message: string }) =>
  r.ok || r.message.startsWith("duplicate:");

const RELAY = "ws://localhost:2929";
// the groups_relay image ships this test admin key in config/settings.yml
const ADMIN_SK_HEX =
  "6b911fd37cdf5c81d4c0adb1ab7fa822ed253ab0ad9aa18d77257c88b29b718e";
const ADMIN_SK = hexToBytes(ADMIN_SK_HEX);

const SK_A = generateSecretKey();
const SK_B = generateSecretKey();

type WsMsg = [string, ...unknown[]];

class Conn {
  ws!: WebSocket;
  msgs: WsMsg[] = [];
  private waiters: ((m: WsMsg) => boolean)[] = [];

  static async open(url: string): Promise<Conn> {
    const c = new Conn();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
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

  private wait(pred: (m: WsMsg) => boolean, ms = 8000): Promise<WsMsg> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`wait timeout: ${pred}`)),
        ms,
      );
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

  /** Answer the relay's NIP-42 challenge (if any) with `sk`. */
  async authed(sk: Uint8Array) {
    const ch = await this.wait((m) => m[0] === "AUTH", 1500).catch(() => null);
    if (!ch) return;
    const ev = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", RELAY],
          ["challenge", String(ch[1])],
        ],
        content: "",
      } satisfies EventTemplate,
      sk,
    );
    this.send(["AUTH", ev]);
    const ok = await this.wait((m) => m[0] === "OK" && m[1] === ev.id);
    if (ok[2] !== true) throw new Error(`AUTH rejected: ${String(ok[3])}`);
  }

  async publish(ev: NostrEvent): Promise<{ ok: boolean; message: string }> {
    this.send(["EVENT", ev]);
    const ok = await this.wait((m) => m[0] === "OK" && m[1] === ev.id);
    return { ok: ok[2] === true, message: String(ok[3] ?? "") };
  }

  async req(filters: Record<string, unknown>): Promise<NostrEvent[]> {
    const sub = `e2e-${Math.random().toString(36).slice(2, 8)}`;
    this.send(["REQ", sub, filters]);
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

function adminEvent(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, ADMIN_SK);
}

async function publishAs(
  sk: Uint8Array,
  events: NostrEvent[],
  logPrefix: string,
) {
  const conn = await Conn.open(RELAY);
  await conn.authed(sk);
  const out: Record<string, { ok: boolean; message: string }> = {};
  for (const ev of events) {
    out[ev.id] = await conn.publish(ev);
    console.log(
      `  ${logPrefix} kind ${ev.kind} ${ev.id.slice(0, 12)}… ->`,
      JSON.stringify(out[ev.id]),
    );
  }
  conn.close();
  return out;
}

describe("NIP-29 wire E2E (local groups_relay)", () => {
  it("runs joins, kind 9 messages, h-bind events against a real relay", async () => {
    const now = Math.floor(Date.now() / 1000);
    const groupId = `e2e${now.toString(16)}`;
    const script: TalkScript = {
      version: 1,
      id: "e2e-script",
      title: "E2E 会話",
      baseTimeSec: now - 30,
      personas: [
        { id: "pa", name: "A", key: bytesToHex(SK_A) },
        { id: "pb", name: "B", key: bytesToHex(SK_B) },
      ],
      lines: [
        { id: "l0", personaId: "pa", content: "e2e root", offsetSec: 0 },
        {
          id: "l1",
          personaId: "pb",
          content: "e2e reply",
          offsetSec: 5,
          replyTo: "l0",
        },
        {
          id: "l2",
          personaId: "pa",
          content: "e2e third",
          offsetSec: 10,
          replyTo: "l1",
        },
      ],
    };

    // ---- 1. create an open public group (admin key, kind 9007)
    const admin = await Conn.open(RELAY);
    await admin.authed(ADMIN_SK);
    const create = adminEvent({
      kind: 9007,
      created_at: now,
      tags: [["h", groupId], ["open"], ["public"], ["name", "e2e group"]],
      content: "",
    });
    const createRes = await admin.publish(create);
    console.log("create group:", groupId, JSON.stringify(createRes));
    expect(createRes.ok).toBe(true);

    // ---- 2. nip29-chat wire: compile, sign, publish joins then messages
    const wire = compileWire(script, "nip29-chat", { groupId }, RELAY);
    const { signed, failures } = signWireEvents(script, wire.events);
    expect(failures).toEqual({});
    const joins = signed.filter((e) => wire.joinIds.has(e.id));
    const msgs = signed.filter((e) => !wire.joinIds.has(e.id));
    expect(joins).toHaveLength(2);
    expect(msgs).toHaveLength(3);

    console.log("joins (9021):");
    const joinResA = await publishAs(
      SK_A,
      joins.filter((e) => e.pubkey === getPublicKey(SK_A)),
      "pa",
    );
    const joinResB = await publishAs(
      SK_B,
      joins.filter((e) => e.pubkey === getPublicKey(SK_B)),
      "pb",
    );
    const joinRes = { ...joinResA, ...joinResB };
    for (const j of joins) expect(joinAccepted(joinRes[j.id])).toBe(true);

    console.log("messages (kind 9):");
    const msgResA = await publishAs(
      SK_A,
      msgs.filter((e) => e.pubkey === getPublicKey(SK_A)),
      "pa",
    );
    const msgResB = await publishAs(
      SK_B,
      msgs.filter((e) => e.pubkey === getPublicKey(SK_B)),
      "pb",
    );
    for (const r of Object.values({ ...msgResA, ...msgResB }))
      expect(r.ok).toBe(true);

    // ---- 3. re-issue: identical wire -> joins answer duplicate -> accepted
    console.log("re-issue joins (duplicate expected):");
    const reJoin = await publishAs(
      SK_A,
      joins.filter((e) => e.pubkey === getPublicKey(SK_A)),
      "pa-dup",
    );
    for (const r of Object.values(reJoin)) {
      expect(r.message.startsWith("duplicate:") || r.ok).toBe(true);
    }

    // ---- 4. REQ {kinds:[9], "#h":[gid]} as a member -> all 3 messages
    const member = await Conn.open(RELAY);
    await member.authed(SK_A);
    const chatEvents = await member.req({ kinds: [9], "#h": [groupId] });
    console.log(`REQ kind9 #h -> ${chatEvents.length} events`);
    for (const m of msgs)
      expect(chatEvents.some((e) => e.id === m.id)).toBe(true);
    member.close();

    // ---- 5. h-bind wire: kind 11 + 1111 with h, then REQ them back
    const hbind = compileWire(script, "h-bind", { groupId });
    const { signed: hbSigned } = signWireEvents(script, hbind.events);
    const hbA = hbSigned.filter((e) => e.pubkey === getPublicKey(SK_A));
    const hbB = hbSigned.filter((e) => e.pubkey === getPublicKey(SK_B));
    console.log("h-bind (kind 11/1111):");
    const hbResA = await publishAs(SK_A, hbA, "pa-hb");
    const hbResB = await publishAs(SK_B, hbB, "pb-hb");
    for (const r of Object.values({ ...hbResA, ...hbResB }))
      expect(r.ok).toBe(true);

    const hbConn = await Conn.open(RELAY);
    await hbConn.authed(SK_A);
    const hbEvents = await hbConn.req({
      kinds: [11, 1111],
      "#h": [groupId],
    });
    console.log(`REQ kind11/1111 #h -> ${hbEvents.length} events`);
    for (const m of hbSigned)
      expect(hbEvents.some((e) => e.id === m.id)).toBe(true);
    hbConn.close();
    admin.close();

    console.log(
      `SUMMARY group=${groupId} joins=${joins.length} msgs=${msgs.length} hbind=${hbSigned.length}`,
    );
  });
});
