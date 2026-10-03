import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dedupeRelays, normalizeRelayInput } from "@/lib/talkscript/issue";

interface Props {
  /** Canonical relay list (normalizeURL form). */
  relays: string[];
  /** Called with the canonicalized list after each add/remove. */
  onChange: (relays: string[]) => void;
  disabled?: boolean;
}

/**
 * Shared relay list editor (extracted from IssueDialog): removable rows
 * plus a wss:// add input. Additions are normalized and deduped
 * canonically so "wss://a" and "wss://a/" never coexist.
 */
export function RelayListEditor({ relays, onChange, disabled }: Props) {
  const [relayInput, setRelayInput] = useState("");
  const [relayError, setRelayError] = useState<string | null>(null);

  const addRelay = () => {
    const normalized = normalizeRelayInput(relayInput);
    if (!normalized) {
      setRelayError("ws:// または wss:// の URL を入力してください");
      return;
    }
    setRelayError(null);
    setRelayInput("");
    const next = dedupeRelays([...relays, normalized]);
    if (next.length > relays.length) onChange(next);
  };

  return (
    <div className="space-y-2">
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
                onClick={() => onChange(relays.filter((r) => r !== relay))}
                disabled={disabled}
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
          disabled={disabled}
        />
        <Button
          variant="outline"
          onClick={addRelay}
          disabled={!relayInput.trim() || disabled}
        >
          追加
        </Button>
      </div>
      {relayError && <p className="text-xs text-destructive">{relayError}</p>}
    </div>
  );
}
