import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getIssuePreset,
  issueLinks,
  type IssueRecord,
} from "@/lib/talkscript/issue";
import { formatTime } from "./utils";

interface Props {
  issues?: IssueRecord[];
}

/**
 * Issuance history: one card per IssueRecord, newest first. Each shows
 * when it ran, the preset, relay count, ok/failure counts, and — for
 * records with a rootId — the preset's client links.
 */
export function IssueHistoryView({ issues }: Props) {
  const records = [...(issues ?? [])].reverse();

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
