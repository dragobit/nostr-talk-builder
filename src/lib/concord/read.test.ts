import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  type Filter,
  type NostrEvent,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { AuthRequiredError } from "applesauce-relay";
import { deriveChannelStream } from "./derive";
import {
  buildRumor,
  sealRumor,
  wrapSeal,
  KIND_WRAP,
  type Rumor,
} from "./envelope";
import {
  createRumorStore,
  createWrapOpener,
  fetchRumors,
  foldRumors,
  streamAuthSigner,
  withStreamAuth,
  type FetchWraps,
} from "./read";

const SK_A = hexToBytes("a".repeat(64));
const SK_B = hexToBytes("b".repeat(64));
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);

const CHANNEL_ID = "11".repeat(32);
const CHANNEL_KEY = "22".repeat(32);
const OTHER_CHANNEL_ID = "66".repeat(32);

const channel = {
  channelIdHex: CHANNEL_ID,
  channelKeyHex: CHANNEL_KEY,
  epoch: 0,
};

function stream() {
  return deriveChannelStream(channel);
}

function irEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "f".repeat(64),
    sig: "e".repeat(128),
    kind: 1111,
    pubkey: PK_A,
    created_at: 1_700_000_000,
    tags: [],
    content: "hello",
    ...overrides,
  };
}

/** Sign a real IR event, wrap it for this channel, return {wrap, rumor}. */
function wrapIr(
  ir: Omit<NostrEvent, "id" | "sig" | "pubkey">,
  sk: Uint8Array,
  chan = channel,
) {
  const s = deriveChannelStream(chan);
  const signed = finalizeEvent(ir, sk);
  const rumor = buildRumor(signed, chan.channelIdHex, BigInt(chan.epoch));
  const wrap = wrapSeal(sealRumor(rumor, s, sk), s);
  return { wrap, rumor };
}

/**
 * Override a wrap's created_at (and re-hash the id) so paging tests get
 * deterministic `until` cursors — wrapSeal randomizes the wire time
 * (NIP-17-style jitter) and paging keys on the wrap's created_at.
 * openWrap never verifies the wrap's own signature, so this stays valid.
 */
function wrapAt(wrap: NostrEvent, created_at: number): NostrEvent {
  const fixed = { ...wrap, created_at };
  return { ...fixed, id: getEventHash(fixed) };
}

/** Minimal fake rumor (no envelope) for fold tests. */
function rumor(overrides: Partial<Rumor> & Pick<Rumor, "id">): Rumor {
  return {
    kind: 9,
    pubkey: PK_A,
    created_at: 1_700_000_000,
    content: "x",
    tags: [],
    ...overrides,
  };
}

function fetchOf(pages: NostrEvent[][], calls?: Filter[][]): FetchWraps {
  const record = calls ?? [];
  let page = 0;
  return async (_relays, filters) => {
    record.push(filters);
    return pages[page++] ?? [];
  };
}

describe("createWrapOpener", () => {
  it("opens a valid wrap once and memoizes the result by wrap id", () => {
    const { wrap, rumor } = wrapIr(
      { kind: 9, content: "hi", tags: [], created_at: 100 },
      SK_A,
    );
    const opener = createWrapOpener(stream(), {
      channelIdHex: CHANNEL_ID,
      epoch: 0n,
    });
    const first = opener(wrap);
    expect(first.rumor).toEqual(rumor);
    expect(first.error).toBeUndefined();
    // memoized: a second call returns the identical result object
    expect(opener(wrap)).toBe(first);
  });

  it("reports an error instead of throwing on a broken wrap", () => {
    const s = stream();
    const broken = finalizeEvent(
      {
        kind: KIND_WRAP,
        content: "not-a-ciphertext",
        tags: [],
        created_at: 100,
      },
      s.sk,
    );
    const opener = createWrapOpener(s, {
      channelIdHex: CHANNEL_ID,
      epoch: 0n,
    });
    const result = opener(broken);
    expect(result.rumor).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.wrapId).toBe(broken.id);
  });

  it("rejects a rumor bound to a different channel (anti-splice)", () => {
    // envelope opens cleanly under our stream — only the binding check
    // (channel tag committed inside the rumor) rejects it
    const s = stream();
    const foreignRumor = buildRumor(irEvent(), OTHER_CHANNEL_ID, 0n);
    const wrap = wrapSeal(sealRumor(foreignRumor, s, SK_A), s);
    const opener = createWrapOpener(s, {
      channelIdHex: CHANNEL_ID,
      epoch: 0n,
    });
    const result = opener(wrap);
    expect(result.rumor).toBeUndefined();
    expect(result.error).toMatch(/channel-binding/);
  });
});

describe("fetchRumors", () => {
  it("pages backwards with an until cursor until a short page", async () => {
    const at = [1000, 900, 800, 700].map(
      (t, i) =>
        wrapAt(
          wrapIr(
            { kind: 9, content: `m${i}`, tags: [], created_at: t },
            i % 2 ? SK_A : SK_B,
          ).wrap,
          t,
        ),
    );
    const calls: Filter[][] = [];
    const fetch = fetchOf([at.slice(0, 2), at.slice(2, 3)], calls);
    const result = await fetchRumors(channel, ["wss://x"], fetch, {
      pageSize: 2,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0][0].until).toBeUndefined();
    expect(calls[0][0]).toMatchObject({
      kinds: [KIND_WRAP],
      authors: [stream().pk],
      limit: 2,
    });
    // page 1's oldest wrap (created_at 900) drives the next until
    expect(calls[1][0].until).toBe(899);
    expect(result.rumors.size).toBe(3);
    expect(result.mayHaveMore).toBe(false);
    expect(result.nextUntil).toBeUndefined();
    expect(result.pagesFetched).toBe(2);
  });

  it("reports mayHaveMore + nextUntil when the page cap is hit", async () => {
    const wraps = [500, 400].map((t) =>
      wrapAt(
        wrapIr({ kind: 9, content: "x", tags: [], created_at: t }, SK_A).wrap,
        t,
      ),
    );
    const result = await fetchRumors(
      channel,
      ["wss://x"],
      fetchOf([wraps]),
      { pageSize: 2, maxPages: 1 },
    );
    expect(result.mayHaveMore).toBe(true);
    expect(result.nextUntil).toBe(399);
  });

  it("flags a full page that ends inside a single created_at second", async () => {
    const wraps = [500, 500].map((t, i) =>
      wrapAt(
        wrapIr(
          { kind: 9, content: `dup-${i}`, tags: [], created_at: t },
          SK_A,
        ).wrap,
        t,
      ),
    );
    const result = await fetchRumors(
      channel,
      ["wss://x"],
      fetchOf([wraps, []]),
      { pageSize: 2 },
    );
    expect(result.saturatedSecond).toBe(500);
    // same-second drain is a documented limit: the second page uses
    // until=499 so wraps at t=500 beyond the cap are not fetched
  });

  it("flags the oldest second of every full page, even across seconds", async () => {
    // page spans two seconds (500, 400) but is full: wraps in second
    // 400 beyond the page cap are dropped by until=399 — the flag must
    // still fire or the gap is a silent miss
    const page1 = [500, 400].map((t, i) =>
      wrapAt(
        wrapIr(
          { kind: 9, content: `p1-${i}`, tags: [], created_at: t },
          SK_A,
        ).wrap,
        t,
      ),
    );
    const page2 = [wrapAt(
      wrapIr(
        { kind: 9, content: "p2", tags: [], created_at: 300 },
        SK_B,
      ).wrap,
      300,
    )];
    const calls: Filter[][] = [];
    const result = await fetchRumors(
      channel,
      ["wss://x"],
      fetchOf([page1, page2], calls),
      { pageSize: 2 },
    );
    expect(calls[1][0].until).toBe(399);
    expect(result.saturatedSecond).toBe(400);
    expect(result.mayHaveMore).toBe(false);
  });

  it("dedupes wraps across relays and pages", async () => {
    const { wrap, rumor } = wrapIr(
      { kind: 9, content: "hi", tags: [], created_at: 100 },
      SK_A,
    );
    const fetch = fetchOf([
      [wrap, wrap],
      [wrap],
    ]);
    const result = await fetchRumors(channel, ["wss://a", "wss://b"], fetch, {
      pageSize: 2,
    });
    expect(result.rumors.size).toBe(1);
    expect(result.rumors.get(rumor.id)).toEqual(rumor);
    expect(result.errors).toHaveLength(0);
  });

  it("collects per-wrap errors without aborting the fetch", async () => {
    const s = stream();
    const good = wrapIr(
      { kind: 9, content: "ok", tags: [], created_at: 100 },
      SK_B,
    );
    const broken = finalizeEvent(
      {
        kind: KIND_WRAP,
        content: "junk",
        tags: [],
        created_at: 90,
      },
      s.sk,
    );
    // wrap opens under our stream but the rumor is bound to another channel
    const foreignRumor = buildRumor(
      irEvent({ kind: 9, created_at: 80 }),
      OTHER_CHANNEL_ID,
      0n,
    );
    const foreignSeal = sealRumor(foreignRumor, s, SK_A);
    const spliced = wrapSeal(foreignSeal, s);

    const result = await fetchRumors(
      channel,
      ["wss://x"],
      fetchOf([[good.wrap, broken, spliced]]),
    );
    expect(result.rumors.size).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.wrapId).sort()).toEqual(
      [broken.id, spliced.id].sort(),
    );
    expect(
      result.errors.find((e) => e.wrapId === spliced.id)?.reason,
    ).toMatch(/binding/);
  });

  it("accumulates into a provided store across calls", async () => {
    const store = createRumorStore();
    const { wrap } = wrapIr(
      { kind: 9, content: "first", tags: [], created_at: 100 },
      SK_A,
    );
    await fetchRumors(channel, ["wss://x"], fetchOf([[wrap]]), { store });
    const second = wrapIr(
      { kind: 9, content: "second", tags: [], created_at: 90 },
      SK_B,
    );
    const result = await fetchRumors(channel, ["wss://x"], fetchOf([[second.wrap]]), {
      store,
    });
    expect(result.rumors).toBe(store);
    expect(store.size).toBe(2);
  });
});

describe("withStreamAuth", () => {
  const okWrap = wrapAt(
    wrapIr({ kind: 9, content: "ok", tags: [], created_at: 100 }, SK_A)
      .wrap,
    100,
  );

  it("authenticates once then retries on auth-required errors", async () => {
    let calls = 0;
    const fetch: FetchWraps = async () => {
      calls += 1;
      if (calls === 1) throw new Error("auth-required: nope");
      return [okWrap];
    };
    const authCalls: string[][] = [];
    const wrapped = withStreamAuth(fetch, async (relays) => {
      authCalls.push(relays);
    });
    const out = await wrapped(["wss://x"], [{ kinds: [KIND_WRAP] }]);
    expect(out).toEqual([okWrap]);
    expect(calls).toBe(2);
    expect(authCalls).toEqual([["wss://x"]]);
  });

  it("treats a real AuthRequiredError as auth-required", async () => {
    let calls = 0;
    const fetch: FetchWraps = async () => {
      calls += 1;
      if (calls === 1) throw new AuthRequiredError("auth-required: x");
      return [okWrap];
    };
    let authed = false;
    const wrapped = withStreamAuth(fetch, async () => {
      authed = true;
    });
    await wrapped(["wss://x"], [{ kinds: [KIND_WRAP] }]);
    expect(authed).toBe(true);
    expect(calls).toBe(2);
  });

  it("rethrows non-auth errors without authenticating", async () => {
    const boom = new Error("connection refused");
    const fetch: FetchWraps = async () => {
      throw boom;
    };
    let authed = false;
    const wrapped = withStreamAuth(fetch, async () => {
      authed = true;
    });
    await expect(wrapped(["wss://x"], [])).rejects.toBe(boom);
    expect(authed).toBe(false);
  });

  it("surfaces an auth-required answer on the retry as-is", async () => {
    const fail = new AuthRequiredError("auth-required: still");
    const fetch: FetchWraps = async () => {
      throw fail;
    };
    let authCalls = 0;
    const wrapped = withStreamAuth(fetch, async () => {
      authCalls += 1;
    });
    await expect(wrapped(["wss://x"], [])).rejects.toBe(fail);
    expect(authCalls).toBe(1);
  });
});

describe("streamAuthSigner", () => {
  it("signs the AUTH template with the stream key", async () => {
    const s = stream();
    const signer = streamAuthSigner(s);
    const signed = await signer.signEvent({
      kind: 22242,
      content: "",
      tags: [
        ["relay", "wss://x"],
        ["challenge", "abc"],
      ],
      created_at: 100,
    });
    expect(signed.pubkey).toBe(s.pk);
    expect(signed.kind).toBe(22242);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe("foldRumors", () => {
  it("renders kind 9 and 1111 rows, ordered by created_at then id", () => {
    const store = createRumorStore();
    const a = rumor({ id: "b".repeat(64), kind: 1111, created_at: 10 });
    const b = rumor({ id: "a".repeat(64), kind: 1111, created_at: 10 });
    const c = rumor({ id: "c".repeat(64), kind: 9, created_at: 5 });
    store.set(a.id, a);
    store.set(b.id, b);
    store.set(c.id, c);
    const fold = foldRumors(store.values());
    expect(fold.rows.map((r) => r.rumor.id)).toEqual([c.id, b.id, a.id]);
    expect(fold.skipped.size).toBe(0);
  });

  it("counts non-row kinds into the skipped aggregate", () => {
    const fold = foldRumors([
      rumor({ id: "1".repeat(64), kind: 11 }),
      rumor({ id: "2".repeat(64), kind: 7 }),
      rumor({ id: "3".repeat(64), kind: 7 }),
      rumor({ id: "4".repeat(64), kind: 3302 }),
      rumor({ id: "5".repeat(64), kind: 9 }),
    ]);
    expect(fold.rows).toHaveLength(1);
    expect(fold.skipped.get(11)).toBe(1);
    expect(fold.skipped.get(7)).toBe(2);
    expect(fold.skipped.get(3302)).toBe(1);
  });

  it("resolves a kind 9 q tag to an in-store quote, else short id", () => {
    const parent = rumor({
      id: "p".repeat(64),
      kind: 9,
      content: "parent msg",
      pubkey: PK_B,
    });
    const child = rumor({
      id: "q".repeat(64),
      kind: 9,
      created_at: 10,
      tags: [["q", parent.id, "wss://r", PK_B]],
    });
    const orphan = rumor({
      id: "r".repeat(64),
      kind: 9,
      created_at: 20,
      tags: [["q", "d".repeat(64)]],
    });
    const fold = foldRumors([child, orphan, parent]);
    const childRow = fold.rows.find((r) => r.rumor.id === child.id)!;
    expect(childRow.quote?.resolved?.content).toBe("parent msg");
    expect(childRow.quote?.resolved?.pubkey).toBe(PK_B);
    const orphanRow = fold.rows.find((r) => r.rumor.id === orphan.id)!;
    expect(orphanRow.quote?.id).toBe("d".repeat(64));
    expect(orphanRow.quote?.resolved).toBeUndefined();
  });

  it("builds kind 1111 depth from the e-tag chain (E = root)", () => {
    const root = rumor({ id: "e".repeat(64), kind: 11 });
    const c1 = rumor({
      id: "1".repeat(64),
      kind: 1111,
      created_at: 10,
      tags: [
        ["e", root.id],
        ["E", root.id],
      ],
    });
    const c2 = rumor({
      id: "2".repeat(64),
      kind: 1111,
      created_at: 20,
      tags: [
        ["e", c1.id],
        ["E", root.id],
      ],
    });
    const orphan = rumor({
      id: "3".repeat(64),
      kind: 1111,
      created_at: 30,
      tags: [["e", "f".repeat(64)]],
    });
    const fold = foldRumors([c2, orphan, c1, root]);
    const row = (id: string) => fold.rows.find((r) => r.rumor.id === id)!;
    expect(row(c1.id).depth).toBe(0);
    expect(row(c1.id).quote?.resolved?.kind).toBe(11);
    expect(row(c2.id).depth).toBe(1);
    expect(row(c2.id).quote?.resolved?.content).toBe(c1.content);
    expect(row(orphan.id).depth).toBe(0);
    expect(row(orphan.id).quote?.resolved).toBeUndefined();
    // the kind 11 root is not a row but lands in the skipped aggregate
    expect(fold.skipped.get(11)).toBe(1);
  });

  it("resolves e/E/q references to pre-binding (canonical) event ids", () => {
    // M4c wraps the canonical IR: rumors carry e tags pointing at the
    // IR event id, which differs from the rumor id — the canonical
    // alias makes the reference resolve anyway.
    const rootIr = finalizeEvent(
      { kind: 11, content: "root", tags: [], created_at: 100 },
      SK_A,
    );
    const replyIr = finalizeEvent(
      {
        kind: 1111,
        content: "reply",
        tags: [
          ["e", rootIr.id],
          ["E", rootIr.id],
        ],
        created_at: 110,
      },
      SK_B,
    );
    const rumors = [rootIr, replyIr].map((ir) =>
      buildRumor(ir, CHANNEL_ID, 0n),
    );
    expect(rumors[0].id).not.toBe(rootIr.id);
    const fold = foldRumors(rumors);
    const replyRow = fold.rows.find((r) => r.rumor.id === rumors[1].id)!;
    expect(replyRow.quote?.id).toBe(rootIr.id);
    expect(replyRow.quote?.resolved?.content).toBe("root");
  });

  it("does not loop on e-tag cycles", () => {
    const a = rumor({
      id: "a".repeat(64),
      kind: 1111,
      created_at: 10,
      tags: [["e", "b".repeat(64)]],
    });
    const b = rumor({
      id: "b".repeat(64),
      kind: 1111,
      created_at: 20,
      tags: [["e", "a".repeat(64)]],
    });
    const fold = foldRumors([a, b]);
    expect(fold.rows).toHaveLength(2);
    expect(fold.rows.every((r) => r.depth >= 0)).toBe(true);
  });
});
