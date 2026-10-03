import { useState } from "react";
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
import { deriveChannelStream } from "@/lib/concord/derive";
import { CoordinateFields } from "./CoordinateFields";
import type { ChannelSession } from "@/lib/concord/read";
import { dedupeRelays, loadPublishRelays } from "@/lib/talkscript/issue";
import type { ChannelPrefill } from "./utils";

interface ChannelOpenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** channelId/epoch/relays carried over (e.g. from a concord record);
   * channelKey is always re-entered — it is never persisted. */
  prefill?: ChannelPrefill;
  onOpen: (session: ChannelSession) => void;
}

export function ChannelOpenDialog(props: ChannelOpenDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        {/* Body state resets every time the dialog opens (radix unmounts
            the content on close), so prefill lands in fresh fields */}
        <ChannelOpenDialogBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ChannelOpenDialogBody({
  prefill,
  onOpen,
}: ChannelOpenDialogProps) {
  const [channelId, setChannelId] = useState(prefill?.channelId ?? "");
  const [channelKey, setChannelKey] = useState("");
  const [epoch, setEpoch] = useState(prefill?.epoch ?? "0");
  const [relays, setRelays] = useState<string[]>(() =>
    dedupeRelays(
      prefill?.relays?.length ? prefill.relays : loadPublishRelays(),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    try {
      const epochInput = epoch.trim() || "0";
      const channel = {
        channelIdHex: channelId.trim(),
        channelKeyHex: channelKey.trim(),
        epoch: BigInt(epochInput),
      };
      const stream = deriveChannelStream(channel);
      if (relays.length === 0) {
        setError("リレーを1つ以上指定してください");
        return;
      }
      onOpen({ channel, stream, relays });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Concord チャンネルを開く</DialogTitle>
        <DialogDescription>
          チャンネル座標 (channelId / channelKey / epoch)
          を入力すると、対応するストリームの wrap (kind 1059)
          を購読・開封して表示します。読み取り専用です（投稿・署名はしません）。
        </DialogDescription>
      </DialogHeader>

      <CoordinateFields
        idPrefix="channel-open"
        channelId={channelId}
        onChannelId={setChannelId}
        channelKey={channelKey}
        onChannelKey={setChannelKey}
        epoch={epoch}
        onEpoch={setEpoch}
        relays={relays}
        onRelays={setRelays}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">閉じる</Button>
        </DialogClose>
        <Button
          onClick={open}
          disabled={!channelId.trim() || !channelKey.trim()}
        >
          開く
        </Button>
      </DialogFooter>
    </>
  );
}
