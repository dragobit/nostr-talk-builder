import { useState } from "react";
import { lastValueFrom, timeout, toArray } from "rxjs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CoordinateFields } from "@/components/channel/CoordinateFields";
import type { ChannelPrefill } from "@/components/channel/utils";
import {
  deriveChannelStream,
  type ChannelStream,
} from "@/lib/concord/derive";
import { importFromChannel } from "@/lib/concord/import";
import {
  streamAuthSigner,
  withStreamAuth,
  type FetchWraps,
} from "@/lib/concord/read";
import {
  ImportError,
  importFromIdentifier,
  type ImportResult,
} from "@/lib/talkscript/importer";
import { dedupeRelays, loadPublishRelays } from "@/lib/talkscript/issue";
import type { TalkScript } from "@/lib/talkscript/types";
import { pool } from "@/services/nostr";

interface ImportEventsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog opens on the channel tab with this coordinate
   * (channelKey is always re-entered — it is never persisted). */
  channelPrefill?: ChannelPrefill;
  onImport: (script: TalkScript, warnings: string[]) => void;
}

export function ImportEventsDialog(props: ImportEventsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        {/* Body state resets every time the dialog opens (radix unmounts
            the content on close) */}
        <ImportEventsDialogBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ImportEventsDialogBody({
  channelPrefill,
  onImport,
}: ImportEventsDialogProps) {
  const [mode, setMode] = useState<"identifier" | "channel">(
    channelPrefill ? "channel" : "identifier",
  );
  const [input, setInput] = useState("");
  const [channelId, setChannelId] = useState(channelPrefill?.channelId ?? "");
  const [channelKey, setChannelKey] = useState("");
  const [epoch, setEpoch] = useState(channelPrefill?.epoch ?? "0");
  const [relays, setRelays] = useState<string[]>(() =>
    dedupeRelays(
      channelPrefill?.relays?.length
        ? channelPrefill.relays
        : loadPublishRelays(),
    ),
  );
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  /** pool.request + timeout, the same call shape fetchRumors expects;
   * NIP-42 retry answers AUTH challenges with the channel stream key. */
  const channelFetch = (stream: ChannelStream): FetchWraps =>
    withStreamAuth(
      (r, filters) =>
        lastValueFrom(
          pool.request(r, filters).pipe(timeout(30_000), toArray()),
        ),
      async (r) => {
        const signer = streamAuthSigner(stream);
        await Promise.all(
          r.map(async (url) => {
            try {
              await pool.relay(url).authenticate(signer);
            } catch {
              // REQ retry surfaces the relay's real answer
            }
          }),
        );
      },
    );

  const runFetch = async () => {
    setFetching(true);
    setError(null);
    setResult(null);
    try {
      const imported = await importFromIdentifier(input, (r, filters) =>
        lastValueFrom(
          pool
            .request(r, filters)
            // backstop: group requests end on EOSE-or-timeout internally,
            // but a stalled request should not hang the dialog forever
            .pipe(timeout(30_000), toArray()),
        ),
      );
      setResult(imported);
    } catch (e) {
      setError(
        e instanceof ImportError
          ? e.message
          : e instanceof Error
            ? e.message
            : "イベントの取得に失敗しました",
      );
    } finally {
      setFetching(false);
    }
  };

  const runChannelFetch = async () => {
    setFetching(true);
    setError(null);
    setResult(null);
    try {
      if (relays.length === 0) {
        setError("リレーを1つ以上指定してください");
        return;
      }
      const channel = {
        channelIdHex: channelId.trim(),
        channelKeyHex: channelKey.trim(),
        epoch: BigInt(epoch.trim() || "0"),
      };
      const stream = deriveChannelStream(channel);
      const imported = await importFromChannel(
        channel,
        relays,
        channelFetch(stream),
      );
      setResult(imported);
    } catch (e) {
      setError(
        e instanceof ImportError
          ? e.message
          : e instanceof Error
            ? e.message
            : "チャンネルの取得に失敗しました",
      );
    } finally {
      setFetching(false);
    }
  };

  const confirm = () => {
    if (!result) return;
    onImport(result.script, result.warnings);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Nostr イベント取り込み</DialogTitle>
        <DialogDescription>
          Nostr 上の会話データを台本として復元します。現在の台本は置き換えられます。
          取り込み後にペルソナへ nsec を設定すれば同一イベント id
          で再コンパイル（往復）でき、設定しなければフォーク（派生台本）として編集できます。
        </DialogDescription>
      </DialogHeader>

      <Tabs
        value={mode}
        onValueChange={(v) => {
          setMode(v as "identifier" | "channel");
          setError(null);
          setResult(null);
        }}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="identifier">イベント識別子</TabsTrigger>
          <TabsTrigger value="channel">Concord チャンネル</TabsTrigger>
        </TabsList>
        <TabsContent value="identifier" className="space-y-2 pt-2">
          <Label htmlFor="import-identifier">イベント識別子</Label>
          <div className="flex gap-2">
            <Input
              id="import-identifier"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="nevent1… / note1… / naddr1…"
              className="flex-1 font-mono text-xs"
              disabled={fetching}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runFetch();
                }
              }}
            />
            <Button
              variant="outline"
              onClick={runFetch}
              disabled={!input.trim() || fetching}
            >
              {fetching ? "取得中…" : "取得する"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            kind 11 スレッド (kind 1111 コメント付き) と kind 1 スレッド
            (NIP-10) を取り込めます。nevent / naddr
            のリレーヒントを使って取得します。ヒントが無い場合は発行用リレーリストを使います。
          </p>
        </TabsContent>
        <TabsContent value="channel" className="space-y-3 pt-2">
          <CoordinateFields
            idPrefix="import-channel"
            channelId={channelId}
            onChannelId={setChannelId}
            channelKey={channelKey}
            onChannelKey={setChannelKey}
            epoch={epoch}
            onEpoch={setEpoch}
            relays={relays}
            onRelays={setRelays}
            disabled={fetching}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={runChannelFetch}
              disabled={!channelId.trim() || !channelKey.trim() || fetching}
            >
              {fetching ? "取得中…" : "取得する"}
            </Button>
            <p className="text-xs text-muted-foreground">
              kind 1111 + kind 11 ルートを含むチャンネルは通常スレッドとして、kind 9
              のみのチャンネルは合成ルート付きで取り込みます。
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <div className="space-y-2">
          <Label>取得結果</Label>
          <div className="rounded-md border px-3 py-2 text-xs space-y-1">
            <div>
              タイトル: {result.script.title || "（なし）"} ·{" "}
              {result.script.lines.length} 行 · {result.script.personas.length}{" "}
              ペルソナ
            </div>
            <div className="text-muted-foreground">
              基準時刻:{" "}
              {new Date(result.script.baseTimeSec * 1000).toLocaleString(
                "ja-JP",
              )}
            </div>
            <div className="text-muted-foreground">
              取得元: {result.relays.join(", ")}
            </div>
          </div>
          {result.warnings.length > 0 && (
            <Alert>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-0.5">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">閉じる</Button>
        </DialogClose>
        <Button onClick={confirm} disabled={!result || fetching}>
          この内容で置き換える
        </Button>
      </DialogFooter>
    </>
  );
}
