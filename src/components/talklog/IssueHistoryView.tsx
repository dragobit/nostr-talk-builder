import { useState } from "react";
import { ExternalLink, MailOpen, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getIssuePreset,
  issueLinks,
  type IssueRecord,
} from "@/lib/talkscript/issue";
import {
  reissueRecord,
  resendBlockReason,
  type ReissueResult,
} from "@/lib/talkscript/reissue";
import type { TalkScript } from "@/lib/talkscript/types";
import type { ChannelPrefill } from "@/components/channel/utils";
import { eventStore, pool } from "@/services/nostr";
import { formatTime } from "./utils";

interface Props {
  script: TalkScript;
  /** Called with the new record after a resend completes. */
  onResent: (result: ReissueResult) => void;
  /** Opens the Concord channel reader for a concord record's coordinate
   * (channelId/epoch from record.params; channelKey is re-entered). */
  onOpenChannel?: (prefill: ChannelPrefill) => void;
}

/**
 * Issuance history: one card per IssueRecord, newest first. Each shows
 * when it ran, the preset, relay count, ok/failure counts, and — for
 * records with a rootId — the preset's client links. Eligible records
 * (plain, unbound, fully-signable) offer a resend action.
 */
export function IssueHistoryView({ script, onResent, onOpenChannel }: Props) {
  const records = [...(script.issues ?? [])].reverse();
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendError, setResendError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const resend = async (record: IssueRecord) => {
    setResendingId(record.id);
    setResendError(null);
    try {
      const result = await reissueRecord(script, record, (relays, event) =>
        pool.publish(relays, event),
      );
      for (const event of result.events) eventStore.add(event);
      onResent(result);
    } catch (error) {
      setResendError({
        id: record.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResendingId(null);
    }
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          発行履歴
          <Badge variant="secondary" className="text-xs font-normal">
            {records.length} 件
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[28rem] pr-3">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              発行レコードがありません。一括署名後に「発行」から送信できます。
            </p>
          ) : (
            <ul className="space-y-3">
              {records.map((record) => {
                const counts = Object.values(record.results).reduce(
                  (acc, result) => {
                    if (result === "ok") acc.ok += 1;
                    else acc.failed += 1;
                    return acc;
                  },
                  { ok: 0, failed: 0 },
                );
                const links = issueLinks(record);
                const blockReason = resendBlockReason(script, record);
                const busy = resendingId === record.id;
                const isConcord =
                  getIssuePreset(record.preset)?.envelope === "concord";
                return (
                  <li
                    key={record.id}
                    className="rounded-md border px-3 py-2 text-xs space-y-1"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">
                        {formatTime(record.issuedAt)}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1 py-0 font-normal"
                      >
                        {getIssuePreset(record.preset)?.label ?? record.preset}
                      </Badge>
                      <span className="text-muted-foreground">
                        {record.relays.length} リレー
                      </span>
                      <span className="ml-auto">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {counts.ok} ok
                        </span>
                        {counts.failed > 0 && (
                          <span className="text-destructive">
                            {` · ${counts.failed} 失敗`}
                          </span>
                        )}
                      </span>
                    </div>
                    {links.length > 0 && (
                      <ul className="space-y-0.5">
                        {links.map((link) => (
                          <li key={link.url}>
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {link.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-2 pt-0.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs px-2"
                        disabled={blockReason !== null || resendingId !== null}
                        onClick={() => void resend(record)}
                        title={
                          blockReason ??
                          "台本を再コンパイル・再署名して同じリレーに送信します"
                        }
                      >
                        <Send className="h-3 w-3 mr-1" />
                        {busy ? "再送信中…" : "再送信"}
                      </Button>
                      {isConcord && onOpenChannel && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2"
                          onClick={() =>
                            onOpenChannel({
                              channelId: record.params?.channelId,
                              epoch: record.params?.epoch ?? "0",
                              relays: record.relays,
                            })
                          }
                          title="このチャンネル座標で読み側を開きます（チャンネル鍵は再入力）"
                        >
                          <MailOpen className="h-3 w-3 mr-1" />
                          開く
                        </Button>
                      )}
                      {blockReason && (
                        <span className="text-muted-foreground">
                          {blockReason}
                        </span>
                      )}
                    </div>
                    {resendError?.id === record.id && (
                      <p className="text-destructive">
                        再送信に失敗しました: {resendError.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
