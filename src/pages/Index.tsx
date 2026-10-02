import { useSeoMeta } from "@unhead/react";
import { PenLine, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonaPanel } from "@/components/talkscript/PersonaPanel";
import { LinePanel } from "@/components/talkscript/LinePanel";
import { ChatLogView } from "@/components/talklog/ChatLogView";
import { useTalkScript } from "@/hooks/useTalkScript";

const Index = () => {
  useSeoMeta({
    title: "Nostr Talk Builder",
    description:
      "会話コンパイラ — 台本を編集して本物の署名済み Nostr イベント (kind 11 + 1111) を生成する",
  });

  const t = useTalkScript();
  const signable = t.script.personas.some((p) => p.key?.trim());
  const signedCount = t.compiled
    ? t.compiled.events.filter((e) => t.signedIds.has(e.id)).length
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-4 py-3 flex items-center gap-3 flex-wrap">
        <PenLine className="h-5 w-5" />
        <h1 className="font-semibold">Nostr Talk Builder</h1>
        <Input
          value={t.script.title}
          onChange={(e) => t.update((s) => ({ ...s, title: e.target.value }))}
          className="h-8 w-56"
          placeholder="会話タイトル (subject)"
        />
        <span className="text-xs text-muted-foreground font-mono">
          base {new Date(t.script.baseTimeSec * 1000).toLocaleString("ja-JP")}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            t.update((s) => ({
              ...s,
              baseTimeSec: Math.floor(Date.now() / 1000),
            }))
          }
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          今に合わせる
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={t.newScript}>
            新規台本
          </Button>
          <Button size="sm" onClick={t.signAll} disabled={!signable || !t.compiled}>
            一括署名
          </Button>
        </div>
      </header>

      <main className="p-4 grid gap-4 lg:grid-cols-2 max-w-6xl mx-auto">
        <div className="space-y-4">
          {t.compileError && (
            <Alert variant="destructive">
              <AlertDescription>{t.compileError}</AlertDescription>
            </Alert>
          )}
          <PersonaPanel
            personas={t.script.personas}
            onAdd={t.addPersona}
            onUpdate={t.updatePersona}
            onRemove={t.removePersona}
          />
          <LinePanel
            personas={t.script.personas}
            lines={t.script.lines}
            onAdd={t.addLine}
            onUpdate={t.updateLine}
            onRemove={t.removeLine}
            onMove={t.moveLine}
          />
        </div>
        <div className="space-y-4">
          <ChatLogView
            script={t.script}
            compiled={t.compiled}
            signedIds={t.signedIds}
          />
          <p className="text-xs text-muted-foreground px-1">
            {signedCount}/{t.compiled?.events.length ?? 0} 件署名済み
            {t.skippedCount > 0 &&
              ` · ${t.skippedCount} 件は鍵なしペルソナのためスキップ`}
            。署名済みイベントはアプリ内 EventStore に保持。
          </p>
        </div>
      </main>
    </div>
  );
};

export default Index;
