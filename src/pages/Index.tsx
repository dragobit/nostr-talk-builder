import { useRef, useState } from "react";
import { useSeoMeta } from "@unhead/react";
import {
  Antenna,
  Download,
  PenLine,
  RefreshCw,
  Send,
  Upload,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonaPanel } from "@/components/talkscript/PersonaPanel";
import { LinePanel } from "@/components/talkscript/LinePanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatLogView } from "@/components/talklog/ChatLogView";
import { ThreadTreeView } from "@/components/talklog/ThreadTreeView";
import { TextDumpView } from "@/components/talklog/TextDumpView";
import { IssueHistoryView } from "@/components/talklog/IssueHistoryView";
import { ImportEventsDialog } from "@/components/talkscript/ImportEventsDialog";
import { IssueDialog } from "@/components/talkscript/IssueDialog";
import { useTalkScript } from "@/hooks/useTalkScript";
import { toast } from "@/hooks/useToast";
import {
  deserializeTalkScript,
  serializeTalkScript,
  suggestedExportFilename,
} from "@/lib/talkscript/persist";

const Index = () => {
  useSeoMeta({
    title: "Nostr Talk Builder",
    description:
      "会話コンパイラ — 台本を編集して本物の署名済み Nostr イベント (kind 11 + 1111) を生成する",
  });

  const t = useTalkScript();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const signable = t.script.personas.some((p) => p.key?.trim());
  const signedCount = t.compiled
    ? t.compiled.events.filter((e) => t.signedIds.has(e.id)).length
    : 0;

  const handleExport = () => {
    const blob = new Blob([serializeTalkScript(t.script)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedExportFilename(t.script);
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      t.importScript(deserializeTalkScript(await file.text()));
      toast({ title: "台本をインポートしました", description: file.name });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "台本のインポートに失敗しました",
        description:
          error instanceof Error
            ? error.message
            : "台本 JSON を読み取れませんでした",
      });
    }
  };

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
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            title="署名用の秘密鍵 (nsec) を含む JSON をダウンロード"
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            エクスポート
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            title="台本 JSON ファイルを読み込む"
          >
            <Upload className="h-3.5 w-3.5 mr-1" />
            インポート
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            title="nevent / note / naddr から Nostr イベントを取り込む"
          >
            <Antenna className="h-3.5 w-3.5 mr-1" />
            Nostr 取り込み
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button variant="outline" size="sm" onClick={t.newScript}>
            新規台本
          </Button>
          <Button
            size="sm"
            onClick={t.signAll}
            disabled={!signable || !t.compiled}
          >
            一括署名
          </Button>
          <Button
            size="sm"
            onClick={() => setIssueOpen(true)}
            disabled={signedCount === 0}
            title={
              signedCount === 0
                ? "先に一括署名してください"
                : "署名済みイベントをリレーに発行"
            }
          >
            <Send className="h-3.5 w-3.5 mr-1" />
            発行
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
          {t.restoreError && (
            <Alert variant="destructive">
              <AlertDescription>
                保存されていた台本を復元できませんでした: {t.restoreError}
              </AlertDescription>
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
          <Tabs defaultValue="chat">
            <TabsList>
              <TabsTrigger value="chat">チャット</TabsTrigger>
              <TabsTrigger value="tree">ツリー</TabsTrigger>
              <TabsTrigger value="dump">ダンプ</TabsTrigger>
              <TabsTrigger value="history">履歴</TabsTrigger>
            </TabsList>
            <TabsContent value="chat">
              <ChatLogView
                script={t.script}
                compiled={t.compiled}
                signedIds={t.signedIds}
              />
            </TabsContent>
            <TabsContent value="tree">
              <ThreadTreeView
                script={t.script}
                compiled={t.compiled}
                signedIds={t.signedIds}
              />
            </TabsContent>
            <TabsContent value="dump">
              <TextDumpView compiled={t.compiled} />
            </TabsContent>
            <TabsContent value="history">
              <IssueHistoryView
                script={t.script}
                onResent={(result) => {
                  t.addIssueRecord(result.record);
                  const sent = Object.values(result.record.results);
                  const ok = sent.filter((r) => r === "ok").length;
                  toast({
                    title: "再送信しました",
                    description:
                      `${ok}/${sent.length} 件 ok` +
                      (result.rootChanged
                        ? " — ルート id が元レコードと異なります（台本が変更されています）"
                        : ""),
                  });
                }}
              />
            </TabsContent>
          </Tabs>
          <p className="text-xs text-muted-foreground px-1">
            {signedCount}/{t.compiled?.events.length ?? 0} 件署名済み
            {t.skippedCount > 0 &&
              ` · ${t.skippedCount} 件は鍵なしペルソナのためスキップ`}
            。署名済みイベントはアプリ内 EventStore に保持。
          </p>
        </div>
      </main>

      <ImportEventsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={(script, warnings) => {
          t.importScript(script);
          setImportOpen(false);
          toast({
            title: "Nostr イベントから台本を復元しました",
            description:
              `${script.lines.length} 行 · ${script.personas.length} ペルソナ` +
              (warnings.length > 0 ? ` · 警告 ${warnings.length} 件` : ""),
          });
        }}
      />
      <IssueDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        script={t.script}
        compiled={t.compiled}
        signedIds={t.signedIds}
        onIssued={(record) => {
          t.addIssueRecord(record);
          toast({ title: "発行レコードを台本に記録しました" });
        }}
      />
    </div>
  );
};

export default Index;
