import { useEffect, useMemo, useState } from "react";
import { compileScript } from "@/lib/talkscript/compile";
import { loadStoredScript, saveStoredScript } from "@/lib/talkscript/persist";
import { signTalk } from "@/lib/talkscript/sign";
import { createSampleScript, newId } from "@/lib/talkscript/sample";
import { generateSecretKeyNsec } from "@/lib/talkscript/keys";
import type { CompiledTalk, Persona, ScriptLine, TalkScript } from "@/lib/talkscript/types";
import { eventStore } from "@/services/nostr";

export interface TalkScriptState {
  script: TalkScript;
  compiled: CompiledTalk | null;
  compileError: string | null;
  /** ids of events signed in this session (a reverted edit re-matches). */
  signedIds: Set<string>;
  skippedCount: number;
  signAll: () => void;
  update: (fn: (s: TalkScript) => TalkScript) => void;
  addPersona: () => void;
  updatePersona: (id: string, patch: Partial<Persona>) => void;
  removePersona: (id: string) => void;
  addLine: () => void;
  updateLine: (id: string, patch: Partial<ScriptLine>) => void;
  removeLine: (id: string) => void;
  moveLine: (id: string, dir: -1 | 1) => void;
  newScript: () => void;
  importScript: (script: TalkScript) => void;
  /** Set when a persisted script failed validation and was discarded. */
  restoreError: string | null;
}

/**
 * Script + compiled IR state for the builder page.
 * The script (persona keys included — throwaway generated keys by design)
 * persists to a single localStorage slot; signing state stays in memory.
 */
export function useTalkScript(): TalkScriptState {
  const [initial] = useState(() => {
    const stored = loadStoredScript();
    return {
      script: stored.status === "ok" ? stored.script : createSampleScript(),
      restoreError: stored.status === "invalid" ? stored.error : null,
    };
  });
  const restoreError = initial.restoreError;
  const [script, setScript] = useState<TalkScript>(initial.script);
  const [signedIds, setSignedIds] = useState<Set<string>>(new Set());
  const [skippedCount, setSkippedCount] = useState(0);

  const { compiled, compileError } = useMemo(() => {
    try {
      return { compiled: compileScript(script), compileError: null };
    } catch (error) {
      return {
        compiled: null,
        compileError:
          error instanceof Error ? error.message : "compile failed",
      };
    }
  }, [script]);

  const signAll = () => {
    if (!compiled) return;
    const result = signTalk(script, compiled);
    for (const event of result.events) eventStore.add(event);
    setSignedIds(new Set(result.events.map((e) => e.id)));
    setSkippedCount(result.skippedLineIds.length);
  };

  // Debounced auto-persist; the write also covers newScript/importScript.
  useEffect(() => {
    const timer = setTimeout(() => saveStoredScript(script), 300);
    return () => clearTimeout(timer);
  }, [script]);

  const update = (fn: (s: TalkScript) => TalkScript) => {
    setSkippedCount(0);
    setScript((s) => fn(s));
  };

  const addPersona = () =>
    update((s) => ({
      ...s,
      personas: [
        ...s.personas,
        {
          id: newId(),
          name: `ペルソナ${s.personas.length + 1}`,
          key: generateSecretKeyNsec(),
        },
      ],
    }));

  const updatePersona = (id: string, patch: Partial<Persona>) =>
    update((s) => ({
      ...s,
      personas: s.personas.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  const removePersona = (id: string) =>
    update((s) => {
      const removed = new Set(
        s.lines.filter((l) => l.personaId === id).map((l) => l.id),
      );
      return {
        ...s,
        personas: s.personas.filter((p) => p.id !== id),
        lines: s.lines
          .filter((l) => !removed.has(l.id))
          .map((l) =>
            l.replyTo && removed.has(l.replyTo)
              ? { ...l, replyTo: undefined }
              : l,
          ),
      };
    });

  const addLine = () =>
    update((s) => {
      const last = s.lines[s.lines.length - 1];
      const fallbackPersona = last?.personaId ?? s.personas[0]?.id ?? "";
      const line: ScriptLine = {
        id: newId(),
        personaId: fallbackPersona,
        content: "",
        offsetSec: (last?.offsetSec ?? -60) + 60,
        replyTo: last?.id,
      };
      return { ...s, lines: [...s.lines, line] };
    });

  const updateLine = (id: string, patch: Partial<ScriptLine>) =>
    update((s) => ({
      ...s,
      lines: s.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));

  const removeLine = (id: string) =>
    update((s) => ({
      ...s,
      lines: s.lines
        .filter((l) => l.id !== id)
        .map((l) => (l.replyTo === id ? { ...l, replyTo: undefined } : l)),
    }));

  const moveLine = (id: string, dir: -1 | 1) =>
    update((s) => {
      const i = s.lines.findIndex((l) => l.id === id);
      const j = i + dir;
      // lines[0] is the root post and stays first
      if (i < 1 || j < 1 || j >= s.lines.length) return s;
      const lines = [...s.lines];
      [lines[i], lines[j]] = [lines[j], lines[i]];
      return { ...s, lines };
    });

  const newScript = () => {
    setScript(createSampleScript());
    setSignedIds(new Set());
    setSkippedCount(0);
  };

  const importScript = (next: TalkScript) => {
    setScript(next);
    setSignedIds(new Set());
    setSkippedCount(0);
  };

  return {
    script,
    compiled,
    compileError,
    signedIds,
    skippedCount,
    signAll,
    update,
    addPersona,
    updatePersona,
    removePersona,
    addLine,
    updateLine,
    removeLine,
    moveLine,
    newScript,
    importScript,
    restoreError,
  };
}
