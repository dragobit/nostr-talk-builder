import { Dices, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { generateSecretKeyNsec, personaPubkey } from "@/lib/talkscript/keys";
import type { Persona } from "@/lib/talkscript/types";

interface Props {
  personas: Persona[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Persona>) => void;
  onRemove: (id: string) => void;
}

function shortHex(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export function PersonaPanel({ personas, onAdd, onUpdate, onRemove }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">ペルソナ</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {personas.map((persona) => {
          const pubkey = personaPubkey(persona);
          return (
            <div key={persona.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  value={persona.name}
                  onChange={(e) => onUpdate(persona.id, { name: e.target.value })}
                  className="h-8 w-32"
                  placeholder="名前"
                />
                <span
                  className="text-xs text-muted-foreground font-mono"
                  title={pubkey ?? "no key"}
                >
                  {pubkey ? shortHex(pubkey) : "key?"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 ml-auto"
                  title="新しい鍵を生成"
                  onClick={() =>
                    onUpdate(persona.id, {
                      key: generateSecretKeyNsec(),
                      pubkey: undefined,
                    })
                  }
                >
                  <Dices className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onRemove(persona.id)}
                  disabled={personas.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Input
                value={persona.key ?? ""}
                onChange={(e) =>
                  onUpdate(persona.id, {
                    key: e.target.value || undefined,
                    pubkey: undefined,
                  })
                }
                className="h-7 font-mono text-xs"
                placeholder="nsec1... (空=鍵を持たない署名者)"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          );
        })}
        <Button variant="outline" size="sm" className="w-full" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          ペルソナ追加
        </Button>
      </CardContent>
    </Card>
  );
}
