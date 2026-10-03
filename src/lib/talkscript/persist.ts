import { z } from "zod";
import { TALK_SCRIPT_VERSION, type TalkScript } from "./types";

/** Single-slot localStorage key holding the current TalkScript (M2). */
export const SCRIPT_STORAGE_KEY = "nostr-talk-builder:script:v1";

export class TalkScriptParseError extends Error {}

const personaSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  key: z.string().optional(),
  pubkey: z.string().optional(),
});

const scriptLineSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  content: z.string(),
  offsetSec: z.number(),
  replyTo: z.string().optional(),
});

const issueRecordSchema = z.object({
  id: z.string().min(1),
  issuedAt: z.number(),
  preset: z.string().min(1),
  bindings: z.array(z.string()),
  envelope: z.enum(["plain", "concord"]),
  relays: z.array(z.string()),
  rootId: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  results: z.record(z.string(), z.string()),
});

// Unknown keys are stripped on parse: v1 files stay loadable when the
// schema grows additive fields (version bumps still hard-reject below).
const talkScriptSchema = z.object({
  version: z.number(),
  id: z.string().min(1),
  title: z.string(),
  baseTimeSec: z.number(),
  personas: z.array(personaSchema),
  lines: z.array(scriptLineSchema),
  issues: z.array(issueRecordSchema).optional(),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "unknown validation error";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Serialize a script to the on-disk JSON form (pretty-printed). */
export function serializeTalkScript(script: TalkScript): string {
  return JSON.stringify(script, null, 2);
}

/** Validate unknown data into a TalkScript; throws TalkScriptParseError. */
export function validateTalkScript(data: unknown): TalkScript {
  if (typeof data === "object" && data !== null && "version" in data) {
    const { version } = data as { version: unknown };
    if (version !== TALK_SCRIPT_VERSION)
      throw new TalkScriptParseError(
        `unsupported script version ${String(version)} (expected ${TALK_SCRIPT_VERSION})`,
      );
  }
  const result = talkScriptSchema.safeParse(data);
  if (!result.success)
    throw new TalkScriptParseError(
      `malformed talk script: ${firstIssue(result.error)}`,
    );
  return result.data;
}

/** Parse a JSON string into a TalkScript; throws TalkScriptParseError. */
export function deserializeTalkScript(json: string): TalkScript {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new TalkScriptParseError("invalid JSON", { cause: error });
  }
  return validateTalkScript(data);
}

export type StoredScript =
  | { status: "empty" }
  | { status: "ok"; script: TalkScript }
  | { status: "invalid"; error: string };

/** Read and validate the persisted script; never throws. */
export function loadStoredScript(): StoredScript {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SCRIPT_STORAGE_KEY);
  } catch {
    return { status: "empty" };
  }
  if (raw === null) return { status: "empty" };
  try {
    return { status: "ok", script: deserializeTalkScript(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Failed to restore talk script from localStorage:", message);
    return { status: "invalid", error: message };
  }
}

/** Persist the script (persona keys included by design — see M2). */
export function saveStoredScript(script: TalkScript): void {
  try {
    localStorage.setItem(SCRIPT_STORAGE_KEY, serializeTalkScript(script));
  } catch (error) {
    console.warn("Failed to persist talk script:", error);
  }
}

/** Download filename suggested from the script title. */
export function suggestedExportFilename(script: TalkScript): string {
  const base = script.title.replace(/[\\/:*?"<>|-]+/g, "").trim();
  return `${base || "talk-script"}.json`;
}
