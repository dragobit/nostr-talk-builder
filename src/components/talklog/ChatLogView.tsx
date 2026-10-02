import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CompiledTalk, TalkScript } from "@/lib/talkscript/types";
import { SignState } from "./shared";
import { formatTime, personaColor } from "./utils";

interface Props {
  script: TalkScript;
  compiled: CompiledTalk | null;
  signedIds: Set<string>;
}

/** Renders the compiled conversation as a chat log, decorated with persona names. */
export function ChatLogView({ script, compiled, signedIds }: Props) {
  const personaOf = (id: string) => script.personas.find((p) => p.id === id);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          ChatLog
          <Badge variant="secondary" className="text-xs font-normal">
            kind 11 + 1111
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {script.lines.map((line, index) => {
          const persona = personaOf(line.personaId);
          const event = compiled?.byLineId[line.id];
          const signed = event ? signedIds.has(event.id) : false;
          const color = personaColor(script, line.personaId);
          return (
            <div key={line.id} className="flex flex-col">
              <span className="text-xs text-muted-foreground mb-0.5">
                {persona?.name ?? "?"} ·{" "}
                {event ? formatTime(event.created_at) : `+${line.offsetSec}s`}
                {index === 0 && (
                  <span className="ml-1 font-medium">「{script.title}」</span>
                )}
              </span>
              <div
                className={cn(
                  "rounded-2xl rounded-tl-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap break-words",
                  color,
                  !signed && "border border-dashed border-muted-foreground/40",
                )}
              >
                <p className="text-sm">{line.content || "…"}</p>
                <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                  <SignState signed={signed} kind={event?.kind} />
                  {event && (
                    <span className="font-mono ml-1">
                      {event.id.slice(0, 8)}…
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
