import type { TalkScript } from "@/lib/talkscript/types";

export const BUBBLE_COLORS = [
  "bg-emerald-100 dark:bg-emerald-950",
  "bg-sky-100 dark:bg-sky-950",
  "bg-amber-100 dark:bg-amber-950",
  "bg-rose-100 dark:bg-rose-950",
  "bg-violet-100 dark:bg-violet-950",
  "bg-lime-100 dark:bg-lime-950",
];

/** Bubble color keyed by the persona's position in the script. */
export function personaColor(script: TalkScript, personaId: string): string {
  const index = script.personas.findIndex((p) => p.id === personaId);
  return BUBBLE_COLORS[(index < 0 ? 0 : index) % BUBBLE_COLORS.length];
}

export function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
