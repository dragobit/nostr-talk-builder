import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Persona, ScriptLine } from "@/lib/talkscript/types";

const ROOT_REPLY = "__root__";

interface Props {
  personas: Persona[];
  lines: ScriptLine[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<ScriptLine>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}

export function LinePanel({
  personas,
  lines,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
}: Props) {
  const personaName = (id: string) =>
    personas.find((p) => p.id === id)?.name ?? "?";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">台本</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {lines.map((line, index) => (
          <div key={line.id} className="space-y-1.5 rounded-md border p-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground w-14 shrink-0">
                {index === 0 ? "ルート" : `#${index}`}
              </span>
              <Select
                value={line.personaId}
                onValueChange={(v) => onUpdate(line.id, { personaId: v })}
              >
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {personas.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {index > 0 && (
                <Select
                  value={line.replyTo ?? ROOT_REPLY}
                  onValueChange={(v) =>
                    onUpdate(line.id, {
                      replyTo: v === ROOT_REPLY ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger className="h-7 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT_REPLY}>→ ルート</SelectItem>
                    {lines.slice(1, index).map((l, i) => (
                      <SelectItem key={l.id} value={l.id}>
                        → #{i + 1} {personaName(l.personaId)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                type="number"
                value={line.offsetSec}
                onChange={(e) =>
                  onUpdate(line.id, {
                    offsetSec: Number(e.target.value) || 0,
                  })
                }
                className="h-7 w-20 text-xs"
                title="基準時刻からの秒オフセット"
              />
              <div className="ml-auto flex items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onMove(line.id, -1)}
                  disabled={index <= 1}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onMove(line.id, 1)}
                  disabled={index === 0 || index === lines.length - 1}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onRemove(line.id)}
                  disabled={index === 0}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <Textarea
              value={line.content}
              onChange={(e) => onUpdate(line.id, { content: e.target.value })}
              rows={2}
              className="text-sm"
              placeholder="発言内容"
            />
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-full" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          発言を追加
        </Button>
      </CardContent>
    </Card>
  );
}
