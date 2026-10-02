import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { NostrEvent } from "nostr-tools";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dumpEventsJsonl } from "@/lib/talkscript/dump";
import type { CompiledTalk, DraftEvent } from "@/lib/talkscript/types";
import { eventStore } from "@/services/nostr";
import { toast } from "@/hooks/useToast";

interface Props {
  compiled: CompiledTalk | null;
}

/**
 * Raw dump of the compiled IR: each event's full JSON, showing the signed
 * copy from the app's EventStore (with `sig`) when it has been signed.
 * The copy button emits JSONL (one event object per line).
 */
export function TextDumpView({ compiled }: Props) {
  const [copied, setCopied] = useState(false);
  const events: (DraftEvent | NostrEvent)[] = (compiled?.events ?? []).map(
    (draft) => eventStore.getEvent(draft.id) ?? draft,
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(dumpEventsJsonl(events));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast({
        title: "JSONL をコピーしました",
        description: `${events.length} イベント`,
      });
    } catch {
      toast({ variant: "destructive", title: "コピーに失敗しました" });
    }
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          イベントダンプ
          <Badge variant="secondary" className="text-xs font-normal">
            {events.length} イベント
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            onClick={handleCopy}
            disabled={events.length === 0}
            title="全イベントを JSONL (1行1イベント) でコピー"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 mr-1" />
            ) : (
              <Copy className="h-3.5 w-3.5 mr-1" />
            )}
            JSONL をコピー
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[28rem] pr-3">
          <div className="space-y-3">
            {events.map((event) => {
              const signed = "sig" in event;
              return (
                <div
                  key={event.id}
                  className="overflow-hidden rounded-md border"
                >
                  <div className="flex items-center gap-2 border-b bg-muted/50 px-2 py-1 text-xs">
                    {signed ? (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0">
                        署名済み
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        ドラフト
                      </Badge>
                    )}
                    <span className="font-mono">kind {event.kind}</span>
                    <span className="font-mono text-muted-foreground">
                      {event.id.slice(0, 12)}…
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(event, null, 2)}
                  </pre>
                </div>
              );
            })}
            {events.length === 0 && (
              <p className="text-sm text-muted-foreground">
                コンパイル結果がありません
              </p>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
