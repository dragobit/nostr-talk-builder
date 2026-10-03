import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelayListEditor } from "@/components/talkscript/RelayListEditor";

interface CoordinateFieldsProps {
  /** DOM id prefix — must differ between dialogs mounted together. */
  idPrefix: string;
  channelId: string;
  onChannelId: (value: string) => void;
  channelKey: string;
  onChannelKey: (value: string) => void;
  epoch: string;
  onEpoch: (value: string) => void;
  relays: string[];
  onRelays: (relays: string[]) => void;
  disabled?: boolean;
}

/**
 * Concord channel coordinate inputs (channelId / channelKey / epoch +
 * relay list) shared by the channel-open dialog and the importer's
 * channel mode.
 */
export function CoordinateFields({
  idPrefix,
  channelId,
  onChannelId,
  channelKey,
  onChannelKey,
  epoch,
  onEpoch,
  relays,
  onRelays,
  disabled,
}: CoordinateFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-channel-id`}>チャンネル ID (hex)</Label>
        <Input
          id={`${idPrefix}-channel-id`}
          value={channelId}
          onChange={(e) => onChannelId(e.target.value)}
          placeholder="64文字のhex"
          className="font-mono text-xs"
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-channel-key`}>
          チャンネル鍵 (hex・この端末にのみ保持)
        </Label>
        <Input
          id={`${idPrefix}-channel-key`}
          type="password"
          value={channelKey}
          onChange={(e) => onChannelKey(e.target.value)}
          placeholder="64文字のhex"
          className="font-mono text-xs"
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-channel-epoch`}>エポック</Label>
        <Input
          id={`${idPrefix}-channel-epoch`}
          value={epoch}
          onChange={(e) => onEpoch(e.target.value)}
          placeholder="0"
          className="font-mono text-xs w-32"
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>購読リレー ({relays.length})</Label>
        <RelayListEditor relays={relays} onChange={onRelays} />
      </div>
    </>
  );
}
