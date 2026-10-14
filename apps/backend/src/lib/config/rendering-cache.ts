/**
 * Per-instance memoization of the CPU-heavy steps of config rendering.
 *
 * This is purely a CPU optimization; it does not change what any config query returns. The stored config overrides
 * are still read from the database on every request (so there is no staleness and no cross-instance invalidation to
 * worry about), but turning them into a rendered config — migrating each override, sanity-checking it against the yup
 * schema, merging the levels, applying defaults, normalizing and sanitizing — used to be the single largest CPU cost
 * of the backend, re-done on every request even though overrides rarely change and most traffic hits few projects.
 *
 * How it works:
 *
 * 1. Each stored override is interned by a hash of its level and JSON content. Equal content always yields the same
 *    canonical (migrated) object, held in a bounded LRU.
 * 2. Every later step is a pure function of canonical objects, so it is memoized by object identity in WeakMaps.
 *    Those entries live exactly as long as the canonical objects they were derived from, so the LRU in step 1 bounds
 *    the memory of the whole cache, and a changed override automatically produces fresh results downstream.
 *
 * All cached values are shared between concurrent requests (and between projects whose overrides are identical), so
 * they are deeply frozen. A caller that tries to mutate one gets a TypeError (all our modules are strict mode) instead
 * of silently leaking its change into other requests or tenants.
 */
import { migrateConfigOverride } from "@hexclave/shared/dist/config/schema";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { deepPlainFreeze } from "@hexclave/shared/dist/utils/objects";
import { createHash } from "node:crypto";

export type ConfigOverrideLevel = "project" | "branch" | "environment" | "organization";

/**
 * Upper bound on interned overrides per instance. Each project contributes roughly one entry per level, so this
 * comfortably covers the working set of an instance while bounding worst-case memory.
 */
const MAX_INTERNED_CONFIG_OVERRIDES = 4_000;

/**
 * Map that evicts the least-recently-used entry once it holds more than `maxSize` entries.
 *
 * Values may not be `undefined`, so that `get` returning `undefined` unambiguously means "not present".
 */
export class LruMap<K, V extends {} | null> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new HexclaveAssertionError("LruMap maxSize must be a positive integer", { maxSize });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Maps iterate in insertion order, so re-inserting moves the key to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done === true) {
        throw new HexclaveAssertionError("LruMap is over capacity but has no entries; this should never happen");
      }
      this.entries.delete(oldestKey.value);
    }
  }
}

type IdentityMemoNode<V> = {
  readonly children: WeakMap<object, IdentityMemoNode<V>>,
  value: Promise<V> | undefined,
};

/**
 * Memoizes async computations keyed by a tuple of object identities, deep-freezing every result.
 *
 * Entries are held weakly through their keys: once any key object is garbage-collected, the entry goes with it.
 * Concurrent callers with the same keys share one in-flight computation; a rejected computation is evicted so it is
 * retried on the next call rather than cached.
 */
export class FrozenIdentityMemo<V> {
  private readonly root: IdentityMemoNode<V> = { children: new WeakMap(), value: undefined };

  get(keys: readonly object[], compute: () => Promise<V>): Promise<V> {
    if (keys.length === 0) {
      throw new HexclaveAssertionError("FrozenIdentityMemo requires at least one key; otherwise its entry could never be garbage-collected");
    }
    let node = this.root;
    for (const key of keys) {
      let child = node.children.get(key);
      if (child === undefined) {
        child = { children: new WeakMap(), value: undefined };
        node.children.set(key, child);
      }
      node = child;
    }
    if (node.value !== undefined) return node.value;

    const leaf = node;
    const promise = Promise.resolve()
      .then(compute)
      .then((result) => deepPlainFreeze(result))
      .catch((error: unknown) => {
        if (leaf.value === promise) {
          leaf.value = undefined;
        }
        throw error;
      });
    leaf.value = promise;
    return promise;
  }
}

// `any` mirrors the return type of `migrateConfigOverride`, whose result shape depends on the level; the callers in
// ./index.tsx assign it to the level-specific override type, exactly as they did before this cache existed.
const internedConfigOverrides = new LruMap<string, any>(MAX_INTERNED_CONFIG_OVERRIDES);

/**
 * Migrates a config override as stored in the database and returns the canonical deep-frozen result for its content.
 *
 * Calls with equal `level` and JSON content return the identical object, which is what lets the downstream rendering
 * steps be memoized by identity (see {@link FrozenIdentityMemo}).
 */
export function getCanonicalMigratedConfigOverride(level: ConfigOverrideLevel, storedConfigOverride: unknown): any {
  const serialized = JSON.stringify(storedConfigOverride) as string | undefined;
  if (serialized === undefined) {
    throw new HexclaveAssertionError("Stored config override is not JSON-serializable", { level });
  }
  // Hashing keeps the LRU keys small even for large overrides; sha256 makes collisions (which would hand one
  // override's config to another) practically impossible.
  const key = `${level}:${createHash("sha256").update(serialized).digest("base64url")}`;
  const cached = internedConfigOverrides.get(key);
  if (cached !== undefined) return cached;

  // Migrate a private copy so the canonical object can never alias (and freeze) the caller's input.
  const migrated = deepPlainFreeze(migrateConfigOverride(level, JSON.parse(serialized)));
  internedConfigOverrides.set(key, migrated);
  return migrated;
}
