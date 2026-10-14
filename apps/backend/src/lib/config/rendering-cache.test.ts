import { migrateConfigOverride } from "@hexclave/shared/dist/config/schema";
import { describe, expect, it } from "vitest";
import { FrozenIdentityMemo, LruMap, getCanonicalMigratedConfigOverride } from "./rendering-cache";

describe("LruMap", () => {
  it("evicts the least-recently-used entry, counting reads as uses", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("overwrites existing keys without growing", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("a", 2);
    expect(map.get("a")).toBe(2);
    expect(map.size).toBe(1);
  });

  it("rejects invalid sizes", () => {
    expect(() => new LruMap<string, number>(0)).toThrow();
    expect(() => new LruMap<string, number>(1.5)).toThrow();
  });
});

describe("FrozenIdentityMemo", () => {
  it("computes once per key tuple and returns the identical frozen result", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const keyA = {};
    const keyB = {};
    let calls = 0;
    const compute = async () => ({ value: ++calls });

    const first = await memo.get([keyA, keyB], compute);
    const second = await memo.get([keyA, keyB], compute);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);

    // Key order and key identity both matter, not structural equality.
    expect(await memo.get([keyB, keyA], compute)).toEqual({ value: 2 });
    expect(await memo.get([{}, keyB], compute)).toEqual({ value: 3 });
    // A prefix of a key tuple is its own entry.
    expect(await memo.get([keyA], compute)).toEqual({ value: 4 });
  });

  it("deduplicates concurrent computations", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const key = {};
    let calls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => memo.get([key], async () => ({ value: ++calls }))));
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("does not cache rejections", async () => {
    const memo = new FrozenIdentityMemo<{ value: number }>();
    const key = {};
    await expect(memo.get([key], async () => {
      throw new Error("transient");
    })).rejects.toThrow("transient");
    expect(await memo.get([key], async () => ({ value: 1 }))).toEqual({ value: 1 });
  });

  it("does not cache results that fail to freeze", async () => {
    const memo = new FrozenIdentityMemo<object>();
    const key = {};
    await expect(memo.get([key], async () => ({ bad: new Map() }))).rejects.toThrow(/non-plain object/);
    expect(await memo.get([key], async () => ({ good: true }))).toEqual({ good: true });
  });

  it("requires at least one key", () => {
    const memo = new FrozenIdentityMemo<object>();
    expect(() => memo.get([], async () => ({}))).toThrow();
  });
});

describe("getCanonicalMigratedConfigOverride", () => {
  it("returns the identical frozen object for equal content", () => {
    const first = getCanonicalMigratedConfigOverride("branch", { "auth.allowSignUp": false });
    const second = getCanonicalMigratedConfigOverride("branch", { "auth.allowSignUp": false });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first["auth.allowSignUp"] = true;
    }).toThrow(TypeError);
  });

  it("returns different objects for different content or levels", () => {
    const base = getCanonicalMigratedConfigOverride("branch", { "auth.allowSignUp": false });
    expect(getCanonicalMigratedConfigOverride("branch", { "auth.allowSignUp": true })).not.toBe(base);
    expect(getCanonicalMigratedConfigOverride("environment", { "auth.allowSignUp": false })).not.toBe(base);
  });

  it("never freezes or aliases the caller's input", () => {
    const input = { "teams.allowClientTeamCreation": true, nested: { a: 1 } };
    const canonical = getCanonicalMigratedConfigOverride("environment", input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
    input.nested.a = 2;
    expect(getCanonicalMigratedConfigOverride("environment", { "teams.allowClientTeamCreation": true, nested: { a: 1 } })).toBe(canonical);
  });

  it("matches what migrateConfigOverride itself would produce", () => {
    const stored = { "auth.allowSignUp": false, "domains.allowLocalhost": true };
    expect(getCanonicalMigratedConfigOverride("environment", stored)).toEqual(migrateConfigOverride("environment", stored));
  });
});
