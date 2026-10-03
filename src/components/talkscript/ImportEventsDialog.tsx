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
import {
  ImportError,
  importFromIdentifier,
  type ImportResult,
} from "@/lib/talkscript/importer";
import type { TalkScript } from "@/lib/talkscript/types";
import { pool } from "@/services/nostr";

interface ImportEventsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

function ImportEventsDialogBody({ onImport }: ImportEventsDialogProps) {
  const [input, setInput] = useState("");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const runFetch = async () => {
    setFetching(true);
    setError(null);
    setResult(null);
    try {
      const imported = await importFromIdentifier(input, (relays, filters) =>
        lastValueFrom(
          pool
            .request(relays, filters)
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

  const confirm = () => {
    if (!result) return;
    onImport(result.script, result.warnings);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Nostr イベント取り込み</DialogTitle>
        <DialogDescription>
          nevent / note / naddr から kind 11 ルートとその配下の kind 1111
          コメントをリレーから取得し、台本として復元します。現在の台本は置き換えられます。
          取り込み後にペルソナへ nsec を設定すれば同一イベント id
          で再コンパイル（往復）でき、設定しなければフォーク（派生台本）として編集できます。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
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
          nevent / naddr
          のリレーヒントを使って取得します。ヒントが無い場合は発行用リレーリストを使います。
        </p>
      </div>

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
