import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TestApp } from "@/test/TestApp";
import { useTalkScript } from "./useTalkScript";
import { SCRIPT_STORAGE_KEY } from "@/lib/talkscript/persist";
import { createIssueRecord } from "@/lib/talkscript/issue";
import { createSampleScript } from "@/lib/talkscript/sample";

function corruptStorage() {
  localStorage.setItem(
    SCRIPT_STORAGE_KEY,
    JSON.stringify({ ...createSampleScript(), version: 99 }),
  );
}

describe("useTalkScript persistence", () => {
  beforeEach(() => localStorage.clear());

  it("restores a valid stored script on mount", () => {
    const stored = createSampleScript();
    localStorage.setItem(SCRIPT_STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useTalkScript(), {
      wrapper: TestApp,
    });
    expect(result.current.script.id).toBe(stored.id);
    expect(result.current.restoreError).toBeNull();
  });

  it("clears restoreError when a script is imported", () => {
    corruptStorage();
    const { result } = renderHook(() => useTalkScript(), {
      wrapper: TestApp,
    });
    expect(result.current.restoreError).toMatch(/version 99/);
    act(() => result.current.importScript(createSampleScript()));
    expect(result.current.restoreError).toBeNull();
  });

  it("clears restoreError on newScript", () => {
    corruptStorage();
    const { result } = renderHook(() => useTalkScript(), {
      wrapper: TestApp,
    });
    expect(result.current.restoreError).not.toBeNull();
    act(() => result.current.newScript());
    expect(result.current.restoreError).toBeNull();
  });
});

describe("useTalkScript issue records", () => {
  beforeEach(() => localStorage.clear());

  it("appends records to script.issues without touching sign state", () => {
    const { result } = renderHook(() => useTalkScript(), {
      wrapper: TestApp,
    });
    const rec = createIssueRecord({
      preset: "public-plain",
      relays: ["wss://nos.lol"],
      results: { ev1: "ok" },
    });
    act(() => result.current.addIssueRecord(rec));
    expect(result.current.script.issues).toEqual([rec]);
    expect(result.current.skippedCount).toBe(0);
    act(() => result.current.addIssueRecord(rec));
    expect(result.current.script.issues).toHaveLength(2);
  });

  it("replaces issues when a script is imported", () => {
    const { result } = renderHook(() => useTalkScript(), {
      wrapper: TestApp,
    });
    act(() =>
      result.current.addIssueRecord(
        createIssueRecord({
          preset: "public-plain",
          relays: [],
          results: {},
        }),
      ),
    );
    act(() => result.current.importScript(createSampleScript()));
    expect(result.current.script.issues).toBeUndefined();
  });
});
