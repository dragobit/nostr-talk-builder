import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lastValueFrom, timeout, toArray } from "rxjs";
import { FileInput, KeyRound, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { KIND_WRAP } from "@/lib/concord/envelope";
import {
  createRumorStore,
  createWrapOpener,
  fetchRumors,
  foldRumors,
  streamAuthSigner,
  withStreamAuth,
  type ChannelRow,
  type ChannelSession,
} from "@/lib/concord/read";
import type { FetchWraps } from "@/lib/concord/read";
import { scriptFromChannel } from "@/lib/concord/import";
import { ImportError } from "@/lib/talkscript/importer";
import type { TalkScript } from "@/lib/talkscript/types";
import { BUBBLE_COLORS, formatTime } from "@/components/talklog/utils";
import { pool } from "@/services/nostr";
import type { NostrEvent } from "nostr-tools";
import { shortNpub } from "./utils";

interface ChannelViewProps {
  /** Active channel session; null shows the empty state. */
  session: ChannelSession | null;
  /** Opens the coordinate dialog. */
  onOpenRequest: () => void;
  /** Closes the session (drops the subscription and the store). */
  onClose: () => void;
  /** Imports the collected rumors as a TalkScript (replaces the
   * current script). */
  onImportScript?: (script: TalkScript, warnings: string[]) => void;
}

/**
 * Concord channel reader (read-only): a standing subscription for live
 * wraps plus `fetchRumors` until-paging for history, folded into
 * chat-style rows. Rumors never enter the app's EventStore.
 */
export function ChannelView({
  session,
  onOpenRequest,
  onClose,
  onImportScript,
}: ChannelViewProps) {
  if (!session) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Concord チャンネル
            <Badge variant="secondary" className="text-xs font-normal">
              読み取り専用
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            チャンネル座標 (channelId / channelKey / epoch)
            を指定すると、そのチャンネルの wrap (kind 1059)
            を購読・開封して時系列表示します。
          </p>
          <Button variant="outline" size="sm" onClick={onOpenRequest}>
            <KeyRound className="h-3.5 w-3.5 mr-1" />
            チャンネルを開く
          </Button>
        </CardContent>
      </Card>
    );
  }
  // key forces a fresh reader (fresh store) when the coordinate changes
  const key = `${session.channel.channelIdHex}:${session.channel.epoch.toString()}`;
  return (
    <ChannelReader
      key={key}
      session={session}
      onClose={onClose}
      onImportScript={onImportScript}
    />
  );
}

function ChannelReader({
  session,
  onClose,
  onImportScript,
}: {
  session: ChannelSession;
  onClose: () => void;
  onImportScript?: (script: TalkScript, warnings: string[]) => void;
}) {
  // mutable channel state — rumors live in a dedicated store, never in
  // the app EventStore (rumors are unsigned)
  const [store] = useState(createRumorStore);
  const [errors] = useState(() => new Map<string, string>());
  const [seenWraps] = useState(() => new Set<string>());
  const [version, setVersion] = useState(0);
  const [fetching, setFetching] = useState(true);
  const [progress, setProgress] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [mayHaveMore, setMayHaveMore] = useState(false);
  const [saturatedSecond, setSaturatedSecond] = useState<
    number | undefined
  >();
  const nextUntilRef = useRef<number | undefined>(undefined);
  const fetchingRef = useRef(false);

  const opener = useMemo(
    () =>
      createWrapOpener(session.stream, {
        channelIdHex: session.channel.channelIdHex,
        epoch: BigInt(String(session.channel.epoch).trim()),
      }),
    [session],
  );

  // standing REQ: live wraps keep arriving after EOSE; per-wrap failures
  // land in the error list without touching the store
  useEffect(() => {
    // NIP-42: answer each relay's AUTH challenge with the stream key —
    // relays see only the opaque stream pubkey
    const signer = streamAuthSigner(session.stream);
    const authSubs = session.relays.map((url) => {
      const relay = pool.relay(url);
      return relay.challenge$.subscribe((challenge) => {
        if (challenge !== null)
          relay.authenticate(signer).catch(() => undefined);
      });
    });
    const sub = pool
      .subscription(session.relays, [
        { kinds: [KIND_WRAP], authors: [session.stream.pk] },
      ])
      .subscribe((wrap: NostrEvent) => {
        if (seenWraps.has(wrap.id)) return;
        seenWraps.add(wrap.id);
        const result = opener(wrap);
        if (result.rumor) store.set(result.rumor.id, result.rumor);
        else
          errors.set(wrap.id, result.error ?? "開封に失敗しました");
        setVersion((v) => v + 1);
      });
    return () => {
      sub.unsubscribe();
      for (const authSub of authSubs) authSub.unsubscribe();
    };
  }, [session, opener, seenWraps, store, errors]);

  // history: reverse-chronological until-paging via pool.request
  const loadHistory = useCallback(
    async (until?: number) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setFetching(true);
      setFetchError(null);
      try {
        const signer = streamAuthSigner(session.stream);
        const fetch: FetchWraps = withStreamAuth(
          (relays, filters) =>
            lastValueFrom(
              pool
                .request(relays, filters)
                .pipe(timeout(30_000), toArray()),
            ),
          // NIP-42 retry path (same signer as the live subscription)
          async (relays) => {
            await Promise.all(
              relays.map(async (url) => {
                try {
                  await pool.relay(url).authenticate(signer);
                } catch {
                  // REQ retry surfaces the relay's real answer
                }
              }),
            );
          },
        );
        const result = await fetchRumors(
          session.channel,
          session.relays,
          fetch,
          { until, store, onProgress: setProgress },
        );
        for (const e of result.errors) {
          if (!errors.has(e.wrapId)) {
            errors.set(e.wrapId, e.reason);
          }
        }
        setMayHaveMore(result.mayHaveMore);
        setSaturatedSecond(result.saturatedSecond);
        nextUntilRef.current = result.nextUntil;
        setVersion((v) => v + 1);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        fetchingRef.current = false;
        setFetching(false);
      }
    },
    [session, store, errors],
  );

  // defer out of the effect body so the first setState isn't synchronous
  useEffect(() => {
    const t = setTimeout(() => void loadHistory(), 0);
    return () => clearTimeout(t);
  }, [loadHistory]);

  // version bumps mark store mutations; the fold is recomputed per
  // render — flat O(n) over a few hundred rumors
  void version;
  const fold = foldRumors(store.values());
  const skippedTotal = [...fold.skipped.values()].reduce((a, b) => a + b, 0);
  const personaIndex = new Map<string, number>();
  for (const row of fold.rows) {
    if (!personaIndex.has(row.rumor.pubkey)) {
      personaIndex.set(row.rumor.pubkey, personaIndex.size);
    }
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          Concord チャンネル
          <Badge variant="secondary" className="text-xs font-normal">
            読み取り専用
          </Badge>
          <code className="text-[10px] font-mono text-muted-foreground">
            {session.channel.channelIdHex.slice(0, 12)}… · epoch{" "}
            {session.channel.epoch.toString()}
          </code>
          {onImportScript && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs px-2 ml-auto"
              disabled={store.size === 0}
              title="開封済みの rumor を台本として取り込みます（現在の台本は置き換えられます）"
              onClick={() => {
                setImportError(null);
                try {
                  const { script, warnings } = scriptFromChannel(
                    store.values(),
                    session.channel,
                    session.stream.pk,
                  );
                  onImportScript(script, warnings);
                } catch (e) {
                  setImportError(
                    e instanceof ImportError
                      ? e.message
                      : e instanceof Error
                        ? e.message
                        : "台本への取り込みに失敗しました",
                  );
                }
              }}
            >
              <FileInput className="h-3 w-3 mr-1" />
              台本に取り込む
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", !onImportScript && "ml-auto")}
            onClick={onClose}
            title="チャンネルを閉じる"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          rumor {store.size} 件 · {session.relays.length} リレー
          {fetching && ` · ${progress} 件の wrap を開封中…`}
        </div>

        {fetchError && (
          <Alert variant="destructive">
            <AlertDescription>
              履歴の取得に失敗しました — {fetchError}
            </AlertDescription>
          </Alert>
        )}
        {importError && (
          <Alert variant="destructive">
            <AlertDescription>{importError}</AlertDescription>
          </Alert>
        )}
        {saturatedSecond !== undefined && (
          <Alert>
            <AlertDescription>
              同一秒 ({formatTime(saturatedSecond)})
              に大量の wrap があるため一部未読の可能性があります
            </AlertDescription>
          </Alert>
        )}
        {errors.size > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              開封できなかった wrap が {errors.size} 件あります
              <ul className="list-disc pl-4 mt-1 space-y-0.5 font-mono text-[10px]">
                {[...errors.entries()].slice(0, 10).map(([id, reason]) => (
                  <li key={id}>
                    {id.slice(0, 12)}… — {reason}
                  </li>
                ))}
                {errors.size > 10 && <li>…他 {errors.size - 10} 件</li>}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {skippedTotal > 0 && (
          <p className="text-xs text-muted-foreground">
            未対応 kind {skippedTotal} 件（
            {[...fold.skipped.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([kind, count]) => `kind ${kind}×${count}`)
              .join(", ")}
            ）
          </p>
        )}

        <ScrollArea className="h-[26rem] pr-3">
          {fold.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {fetching
                ? "履歴を取得しています…"
                : "kind 9 / 1111 の rumor はまだありません。新着は自動で表示されます。"}
            </p>
          ) : (
            <div className="space-y-3">
              {fold.rows.map((row) => (
                <ChannelRowView
                  key={row.rumor.id}
                  row={row}
                  colorIndex={personaIndex.get(row.rumor.pubkey) ?? 0}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {mayHaveMore && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadHistory(nextUntilRef.current)}
            disabled={fetching}
          >
            さらに過去を読み込む
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelRowView({
  row,
  colorIndex,
}: {
  row: ChannelRow;
  colorIndex: number;
}) {
  const { rumor, quote, depth } = row;
  const color = BUBBLE_COLORS[colorIndex % BUBBLE_COLORS.length];
  return (
    <div
      className="flex flex-col"
      style={{ paddingLeft: Math.min(depth, 10) * 16 }}
    >
      <span className="text-xs text-muted-foreground mb-0.5">
        {shortNpub(rumor.pubkey)} · {formatTime(rumor.created_at)}
      </span>
      {quote && (
        <div className="text-[10px] text-muted-foreground border-l-2 border-border pl-2 mb-0.5 font-mono">
          {quote.resolved
            ? `↳ ${shortNpub(quote.resolved.pubkey)}: ${quote.resolved.content.slice(0, 80)}`
            : `↳ ${quote.id.slice(0, 12)}…`}
        </div>
      )}
      <div
        className={cn(
          "rounded-2xl rounded-tl-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap break-words",
          color,
        )}
      >
        <p className="text-sm">{rumor.content || "…"}</p>
        <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            kind {rumor.kind}
          </Badge>
          <span className="font-mono ml-1">{rumor.id.slice(0, 8)}…</span>
        </div>
      </div>
    </div>
  );
}
