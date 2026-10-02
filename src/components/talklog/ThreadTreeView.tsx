import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { buildTalkTree, type TalkTreeNode } from "@/lib/talkscript/tree";
import type { CompiledTalk, TalkScript } from "@/lib/talkscript/types";
import { SignState } from "./shared";
import { formatTime, personaColor } from "./utils";

interface Props {
  script: TalkScript;
  compiled: CompiledTalk | null;
  signedIds: Set<string>;
}

/**
 * Renders the compiled IR as a thread tree: the kind 11 root at top, each
 * kind 1111 nested under the event its parent-scope `e` tag points at
 * (unresolvable parents hang directly under the root).
 */
export function ThreadTreeView({ script, compiled, signedIds }: Props) {
  const tree = compiled ? buildTalkTree(compiled.events) : null;
  const personaIdByEventId = new Map<string, string>();
  for (const line of script.lines) {
    const event = compiled?.byLineId[line.id];
    if (event) personaIdByEventId.set(event.id, line.personaId);
  }

  const renderNode = (node: TalkTreeNode, isRoot = false) => {
    const { event } = node;
    const personaId = personaIdByEventId.get(event.id);
    const persona = script.personas.find((p) => p.id === personaId);
    const signed = signedIds.has(event.id);
    return (
      <div key={event.id}>
        <div
          className={cn(
            "rounded-md px-3 py-2 max-w-[95%] whitespace-pre-wrap break-words",
            personaId ? personaColor(script, personaId) : "bg-muted",
            !signed && "border border-dashed border-muted-foreground/40",
          )}
        >
          <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
            <span className="font-medium">{persona?.name ?? "?"}</span>
            <span>· {formatTime(event.created_at)}</span>
            {isRoot && (
              <span className="font-medium">「{script.title}」</span>
            )}
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              kind {event.kind}
            </Badge>
          </div>
          <p className="text-sm mt-0.5">{event.content || "…"}</p>
          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
            <SignState signed={signed} kind={event.kind} />
            <span className="font-mono ml-1">{event.id.slice(0, 8)}…</span>
          </div>
        </div>
        {node.children.length > 0 && (
          <div className="ml-3 mt-2 space-y-2 border-l-2 border-border pl-3">
            {node.children.map((child) => renderNode(child))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          スレッドツリー
          <Badge variant="secondary" className="text-xs font-normal">
            NIP-22 e タグ
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {tree ? (
          renderNode(tree, true)
        ) : (
          <p className="text-sm text-muted-foreground">
            コンパイル結果がありません
          </p>
        )}
      </CardContent>
    </Card>
  );
}
