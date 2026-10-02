import { CheckCircle2, CircleDashed } from "lucide-react";

/** ドラフト/署名済み icon + kind label shown under each rendered event. */
export function SignState({ signed, kind }: { signed: boolean; kind?: number }) {
  return signed ? (
    <>
      <CheckCircle2 className="h-3 w-3" />
      <span>署名済 kind {kind ?? "—"}</span>
    </>
  ) : (
    <>
      <CircleDashed className="h-3 w-3" />
      <span>ドラフト kind {kind ?? "—"}</span>
    </>
  );
}
