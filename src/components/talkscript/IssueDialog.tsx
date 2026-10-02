import { useState } from "react";
import type { NostrEvent } from "nostr-tools";
import { X } from "lucide-react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  aggregateResults,
  createIssueRecord,
  dedupeRelays,
  ISSUE_PRESETS,
  issueLinks,
  loadPublishRelays,
  normalizeRelayInput,
  publishToRelays,
  savePublishRelays,
  type IssuePreset,
  type IssuePresetId,
  type IssueRecord,
  type PublishOutcome,
} from "@/lib/talkscript/issue";
import type { CompiledTalk, DraftEvent } from "@/lib/talkscript/types";
import { eventStore, pool } from "@/services/nostr";

interface IssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compiled: CompiledTalk | null;
  /** Event ids signed in this session; unsigned drafts are skipped. */
  signedIds: Set<string>;
  onIssued: (record: IssueRecord) => void;
}

export function IssueDialog(props: IssueDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        {/* Body state resets every time the dialog opens (radix unmounts
            the content on close) */}
        <IssueDialogBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

function IssueDialogBody({ compiled, signedIds, onIssued }: IssueDialogProps) {
  const [preset, setPreset] = useState<IssuePresetId>("public-plain");
  const [relays, setRelays] = useState<string[]>(loadPublishRelays);
  const [relayInput, setRelayInput] = useState("");
  const [relayError, setRelayError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const [skipped, setSkipped] = useState<DraftEvent[]>([]);

  const targets = compiled?.events.filter((e) => signedIds.has(e.id)) ?? [];
  const unsigned = compiled?.events.filter((e) => !signedIds.has(e.id)) ?? [];

  // captured once per dialog open (body remounts on open); only events
  // that will actually be sent (targets) count toward the warning
  const [openedAtSec] = useState(() => Math.floor(Date.now() / 1000));
  const futureCount = targets.filter(
    (e) => e.created_at > openedAtSec + 15 * 60,
  ).length;

  const updateRelays = (next: string[]) => {
    setRelays(next);
    savePublishRelays(next);
  };

  const addRelay = () => {
    const normalized = normalizeRelayInput(relayInput);
    if (!normalized) {
      setRelayError("ws:// または wss:// の URL を入力してください");
      return;
    }
    setRelayError(null);
    setRelayInput("");
    // dedupe by canonical url — "wss://a" and "wss://a/" are the same relay
    const next = dedupeRelays([...relays, normalized]);
    if (next.length > relays.length) updateRelays(next);
  };

  const canExecute =
    !running &&
    ISSUE_PRESETS[preset].publishes &&
    relays.length > 0 &&
    targets.length > 0;

  const run = async () => {
    if (!canExecute) return;
    setRunning(true);
    setOutcome(null);
    try {
      // signed copies (with sig) live in the EventStore — drafts have none
      const events = targets
        .map((d) => eventStore.getEvent(d.id))
        .filter((e): e is NostrEvent => e !== undefined);
      const storeMisses = targets.filter(
        (d) => !events.some((e) => e.id === d.id),
      );
      const published = await publishToRelays(events, relays, (rs, ev) =>
        pool.publish(rs, ev),
      );
      setOutcome(published);
      setSkipped([...unsigned, ...storeMisses]);
      // rootId is recorded only when the kind 11 root was actually sent —
      // links to an unpublished root would 404 on the viewer side
      const rootId = compiled?.events[0]?.id;
      onIssued(
        createIssueRecord({
          preset,
          relays,
          rootId: targets.some((d) => d.id === rootId) ? rootId : undefined,
          results: aggregateResults(published),
        }),
      );
    } finally {
      setRunning(false);
    }
  };

  // viewer links for the published root — only shown when every relay
  // accepted it (matches the record's "ok" semantics)
  const rootId = compiled?.events[0]?.id;
  const links =
    outcome && rootId && aggregateResults(outcome)[rootId] === "ok"
      ? issueLinks({ preset, relays, rootId })
      : [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>発行</DialogTitle>
        <DialogDescription>
          署名済みイベントをリレーに送信し、発行レコードを台本に記録します。
        </DialogDescription>
      </DialogHeader>

      <RadioGroup
        value={preset}
        onValueChange={(v) => {
          if (v in ISSUE_PRESETS) setPreset(v as IssuePresetId);
        }}
      >
        {(Object.entries(ISSUE_PRESETS) as [string, IssuePreset][]).map(
          ([id, p]) => (
            <div key={id} className="flex items-start gap-2">
              <RadioGroupItem
                value={id}
                id={`issue-preset-${id}`}
                className="mt-1"
                disabled={p.disabledReason !== undefined}
              />
              <Label
                htmlFor={`issue-preset-${id}`}
                className={
                  p.disabledReason !== undefined
                    ? "font-normal opacity-60"
                    : "font-normal"
                }
              >
                <span className="block text-sm">{p.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {p.description}
                </span>
                {p.disabledReason !== undefined && (
                  <span className="block text-xs text-muted-foreground">
                    {p.disabledReason}
                  </span>
                )}
              </Label>
            </div>
          ),
        )}
      </RadioGroup>

      {ISSUE_PRESETS[preset].publishes && (
        <div className="space-y-2">
          <Label>発行先リレー ({relays.length})</Label>
          {relays.length === 0 ? (
            <p className="text-xs text-muted-foreground border border-dashed rounded p-2 text-center">
              リレーがありません。下から追加してください。
            </p>
          ) : (
            <ul className="space-y-1">
              {relays.map((relay) => (
                <li
                  key={relay}
                  className="flex items-center gap-2 rounded bg-muted px-2 py-1"
                >
                  <code className="flex-1 text-xs font-mono select-all">
                    {relay}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() =>
                      updateRelays(relays.filter((r) => r !== relay))
                    }
                    disabled={running}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              value={relayInput}
              onChange={(e) => setRelayInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRelay();
                }
              }}
              placeholder="wss://relay.example.com"
              className="flex-1"
              disabled={running}
            />
            <Button
              variant="outline"
              onClick={addRelay}
              disabled={!relayInput.trim() || running}
            >
              追加
            </Button>
          </div>
          {relayError && (
            <p className="text-xs text-destructive">{relayError}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {targets.length} 件を送信予定
            {unsigned.length > 0 &&
              ` · ${unsigned.length} 件は未署名のためスキップ`}
          </p>
        </div>
      )}

      {futureCount > 0 && ISSUE_PRESETS[preset].publishes && (
        <Alert variant="destructive">
          <AlertDescription>
            {futureCount}{" "}
            件のイベントの作成時刻が現在より15分以上未来です。リレーに拒否される可能性があります
            — 基準時刻を下げて再署名してください。
          </AlertDescription>
        </Alert>
      )}

      {outcome && (
        <div className="space-y-2">
          <Label>発行結果</Label>
          <ul className="space-y-2 text-xs font-mono">
            {targets.map((d) => (
              <li key={d.id}>
                <div>
                  kind {d.kind} · {d.id.slice(0, 12)}…
                </div>
                <ul className="ml-3 space-y-0.5">
                  {Object.entries(outcome[d.id] ?? {}).map(([relay, r]) => (
                    <li
                      key={relay}
                      className={
                        r.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                      }
                    >
                      {relay} — {r.ok ? "ok" : (r.message ?? "失敗")}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {skipped.map((d) => (
              <li key={d.id} className="text-muted-foreground">
                kind {d.kind} · {d.id.slice(0, 12)}… — 未署名スキップ
              </li>
            ))}
          </ul>
          {links.length > 0 && (
            <ul className="space-y-1">
              {links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            発行レコードを台本に追記しました。
          </p>
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">閉じる</Button>
        </DialogClose>
        <Button onClick={run} disabled={!canExecute}>
          {running ? "送信中…" : "発行する"}
        </Button>
      </DialogFooter>
    </>
  );
}
