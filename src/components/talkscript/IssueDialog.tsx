import { useMemo, useState } from "react";
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
  recordableParams,
  savePublishRelays,
  type IssuePreset,
  type IssuePresetId,
  type IssueRecord,
  type PublishOutcome,
} from "@/lib/talkscript/issue";
import { personaCanSign } from "@/lib/talkscript/keys";
import {
  compileWire,
  publishWire,
  signWireEvents,
} from "@/lib/talkscript/wire";
import type { CompiledTalk, TalkScript } from "@/lib/talkscript/types";
import { eventStore, pool } from "@/services/nostr";

interface IssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  script: TalkScript;
  compiled: CompiledTalk | null;
  /** Event ids signed in this session; unsigned drafts are skipped. */
  signedIds: Set<string>;
  onIssued: (record: IssueRecord) => void;
}

/** One row in the post-run result list. */
interface ResultRow {
  id: string;
  kind: number;
  /** Annotation after the event id, e.g. join request + persona name. */
  note?: string;
  /** Set when the event was not sent — the reason is recorded as-is. */
  skippedReason?: string;
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

function IssueDialogBody({
  script,
  compiled,
  signedIds,
  onIssued,
}: IssueDialogProps) {
  const [preset, setPreset] = useState<IssuePresetId>("public-plain");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [relays, setRelays] = useState<string[]>(loadPublishRelays);
  const [relayInput, setRelayInput] = useState("");
  const [relayError, setRelayError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const [rows, setRows] = useState<ResultRow[]>([]);
  // root id of the last run — for wire presets this is the wire-compiled
  // root, not the canonical IR root
  const [issuedRootId, setIssuedRootId] = useState<string | undefined>();

  const presetDef: IssuePreset = ISSUE_PRESETS[preset];
  const isWire = presetDef.wire !== undefined;

  const targets = compiled?.events.filter((e) => signedIds.has(e.id)) ?? [];
  const unsigned = compiled?.events.filter((e) => !signedIds.has(e.id)) ?? [];

  const paramsFilled = (presetDef.params ?? []).every((param) =>
    paramValues[param.key]?.trim(),
  );

  const signablePersonas = useMemo(
    () => new Set(script.personas.filter(personaCanSign).map((p) => p.id)),
    [script.personas],
  );

  // wire presets re-compile the publish set from the script; previewed
  // deterministically so the dialog can show send counts before running
  const wirePreview = useMemo(() => {
    if (!presetDef.wire || !compiled || !paramsFilled) return null;
    try {
      return compileWire(script, presetDef.wire, paramValues, relays[0]);
    } catch {
      return null;
    }
  }, [presetDef.wire, compiled, paramsFilled, script, paramValues, relays]);

  const wireSignable = useMemo(
    () =>
      wirePreview?.events.filter((w) => signablePersonas.has(w.personaId)) ??
      [],
    [wirePreview, signablePersonas],
  );

  const personaName = (personaId: string) =>
    script.personas.find((p) => p.id === personaId)?.name ?? personaId;

  // captured once per dialog open (body remounts on open); only events
  // that will actually be sent count toward the warning
  const [openedAtSec] = useState(() => Math.floor(Date.now() / 1000));
  const futureCount = (
    isWire ? wireSignable.map((w) => w.draft) : targets
  ).filter((e) => e.created_at > openedAtSec + 15 * 60).length;

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
    presetDef.publishes &&
    relays.length > 0 &&
    (isWire ? compiled !== null && paramsFilled : targets.length > 0);

  const run = async () => {
    if (!canExecute || !presetDef) return;
    setRunning(true);
    setOutcome(null);
    setRows([]);
    try {
      if (presetDef.wire) {
        // wire presets re-compile a dedicated event set from the script
        // and sign it with the persona keys here — the signed canonical
        // IR is not what gets published
        const wire = compileWire(
          script,
          presetDef.wire,
          paramValues,
          relays[0],
        );
        const { signed, failures } = signWireEvents(script, wire.events);
        const published = await publishWire(wire, signed, relays, (rs, ev) =>
          pool.publish(rs, ev),
        );
        setOutcome(published);
        setRows(
          wire.events.map((w) => ({
            id: w.draft.id,
            kind: w.draft.kind,
            note: wire.joinIds.has(w.draft.id)
              ? `参加要求 (${personaName(w.personaId)})`
              : undefined,
            skippedReason: failures[w.draft.id],
          })),
        );
        // for h-bind the wire root is a new kind 11 id; nip29-chat has none
        const wireRoot =
          presetDef.wire === "h-bind"
            ? wire.events.find((w) => w.draft.kind === 11)
            : undefined;
        const rootId =
          wireRoot && !failures[wireRoot.draft.id]
            ? wireRoot.draft.id
            : undefined;
        setIssuedRootId(rootId);
        onIssued(
          createIssueRecord({
            preset,
            relays,
            bindings: presetDef.bindings,
            params: recordableParams(presetDef, paramValues),
            rootId,
            results: { ...failures, ...aggregateResults(published) },
          }),
        );
        return;
      }

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
      setRows([
        ...targets.map((d) => ({ id: d.id, kind: d.kind })),
        ...[...unsigned, ...storeMisses].map((d) => ({
          id: d.id,
          kind: d.kind,
          skippedReason: "未署名スキップ",
        })),
      ]);
      // rootId is recorded only when the kind 11 root was actually sent —
      // links to an unpublished root would 404 on the viewer side
      const rootId = compiled?.events[0]?.id;
      const issuedRoot =
        rootId && targets.some((d) => d.id === rootId) ? rootId : undefined;
      setIssuedRootId(issuedRoot);
      onIssued(
        createIssueRecord({
          preset,
          relays,
          rootId: issuedRoot,
          results: aggregateResults(published),
        }),
      );
    } finally {
      setRunning(false);
    }
  };

  // viewer links for the published root — issueLinks itself gates on the
  // root's result being "ok" (accepted by every relay)
  const links =
    outcome && issuedRootId
      ? issueLinks({
          preset,
          relays,
          rootId: issuedRootId,
          results: aggregateResults(outcome),
        })
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

      {presetDef.params?.map((param) => (
        <div key={param.key} className="space-y-1">
          <Label htmlFor={`issue-param-${param.key}`}>{param.label}</Label>
          <Input
            id={`issue-param-${param.key}`}
            type={param.secret ? "password" : "text"}
            placeholder={param.placeholder}
            value={paramValues[param.key] ?? ""}
            onChange={(e) =>
              setParamValues((values) => ({
                ...values,
                [param.key]: e.target.value,
              }))
            }
            disabled={running}
          />
        </div>
      ))}

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
            {isWire
              ? wirePreview
                ? `${wireSignable.length} 件を送信予定${
                    wirePreview.joinIds.size > 0
                      ? `（うち kind 9021 参加要求 ${wireSignable.filter((w) => wirePreview.joinIds.has(w.draft.id)).length} 件）`
                      : ""
                  }${
                    wirePreview.events.length > wireSignable.length
                      ? ` · ${wirePreview.events.length - wireSignable.length} 件は鍵なしペルソナのため失敗行として記録`
                      : ""
                  }`
                : "パラメータを入力すると発行用イベントをコンパイルします"
              : `${targets.length} 件を送信予定${unsigned.length > 0 ? ` · ${unsigned.length} 件は未署名のためスキップ` : ""}`}
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
            {rows.map((row) =>
              row.skippedReason ? (
                <li key={row.id} className="text-muted-foreground">
                  kind {row.kind} · {row.id.slice(0, 12)}…
                  {row.note && ` — ${row.note}`} — {row.skippedReason}
                </li>
              ) : (
                <li key={row.id}>
                  <div>
                    kind {row.kind} · {row.id.slice(0, 12)}…
                    {row.note && ` — ${row.note}`}
                  </div>
                  <ul className="ml-3 space-y-0.5">
                    {Object.entries(outcome[row.id] ?? {}).map(([relay, r]) => (
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
              ),
            )}
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
