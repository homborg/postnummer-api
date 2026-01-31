/**
 * Effect Cache Service
 *
 * This module provides D1 cache operations as an Effect service.
 *
 * Effect Service Patterns Used:
 *
 * 1. Effect.tryPromise - Wrapping async operations
 *    D1 database operations are Promise-based. Effect.tryPromise converts them
 *    to Effect, catching any thrown errors and converting them to typed failures.
 *
 *    ```typescript
 *    Effect.tryPromise({
 *      try: () => db.prepare("...").all(),
 *      catch: (error) => new CacheError({ message: "...", cause: error })
 *    })
 *    ```
 *
 * 2. Effect.gen with yield* - Generator syntax for async flows
 *    Effect.gen provides a clean way to sequence Effects:
 *
 *    ```typescript
 *    Effect.gen(function* () {
 *      const bindings = yield* CloudflareBindings;  // Access service
 *      const result = yield* someEffect;            // Run effect
 *      return result;
 *    })
 *    ```
 *
 * 3. Option for cache misses
 *    Cache misses are expected, not errors. We return Option<T> to signal
 *    "not found is normal" while reserving Effect.fail for actual errors.
 *
 * 4. Service access pattern
 *    The cache functions access D1 via the CloudflareBindings service,
 *    making them depend on CloudflareBindings in their Effect signature.
 */

import { Effect, Option, pipe } from "effect";
import { CloudflareBindings } from "./bindings";
import { CacheError } from "./errors";
import { pointInGeometry } from "../geo";
import type {
  CachedPostalCode as CachedPostalCodeType,
  CacheableGeometry,
} from "./schemas";

// =============================================================================
// Constants
// =============================================================================

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// =============================================================================
// Types
// =============================================================================

/**
 * Result returned from cache lookup.
 * Mirrors PostalCodeResult but with source always "cache".
 */
export interface CacheResult {
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
  readonly source: "cache";
}

/**
 * Geometry type for caching - use CacheableGeometry from schemas.
 * Coordinates are unknown at the schema level but cast at runtime for geo operations.
 */
type CacheGeometry = CacheableGeometry;

/**
 * Input for saving to cache - the postal code result to store.
 */
export interface CacheInput {
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
}

// =============================================================================
// findInCache - Look up cached postal code by coordinates
// =============================================================================

/**
 * Find a cached postal code for the given coordinates.
 *
 * Uses a two-step approach:
 * 1. Query by bounding box (fast spatial filter using D1 indexes)
 * 2. Check point-in-polygon for each candidate (accurate containment test)
 *
 * Returns Option.none() on cache miss - this is expected and normal.
 * Only fails with CacheError on actual database errors.
 *
 * @param lat - Latitude to look up
 * @param lng - Longitude to look up
 * @returns Effect that succeeds with Option<CacheResult> or fails with CacheError
 *
 * @example
 * ```typescript
 * const result = yield* findInCache(55.6761, 12.5683);
 * if (Option.isSome(result)) {
 *   console.log(result.value.postalCode); // "1050"
 * }
 * ```
 */
export const findInCache = (
  lat: number,
  lng: number
): Effect.Effect<Option.Option<CacheResult>, CacheError, CloudflareBindings> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "cache.lat": lat, "cache.lng": lng });
    const { db } = yield* CloudflareBindings;
    const now = Math.floor(Date.now() / 1000);

    // Step 1: Query by bounding box (spatial filter)
    const candidates = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `SELECT * FROM postal_cache 
             WHERE min_lat <= ? AND max_lat >= ? 
               AND min_lng <= ? AND max_lng >= ?
               AND expires_at > ?`
          )
          .bind(lat, lat, lng, lng, now)
          .all<CachedPostalCodeType>(),
      catch: (error) =>
        new CacheError({
          message: `Failed to query cache: ${String(error)}`,
          operation: "read",
          cause: error,
        }),
    });

    // No candidates found - cache miss (expected, not an error)
    if (!candidates.results?.length) {
      return Option.none();
    }

    // Step 2: Check point-in-polygon for each candidate
    for (const cached of candidates.results) {
      const geometry = yield* Effect.try({
        try: () =>
          JSON.parse(cached.geometry) as {
            type: string;
            coordinates: number[][][] | number[][][][];
          },
        catch: (error) =>
          new CacheError({
            message: `Failed to parse cached geometry JSON: ${String(error)}`,
            operation: "read",
            cause: error,
          }),
      });
      if (pointInGeometry(lat, lng, geometry)) {
        return Option.some({
          postalCode: cached.postal_code,
          city: cached.city,
          country: cached.country_code,
          source: "cache" as const,
        });
      }
    }

    // No candidate contained the point - cache miss
    return Option.none();
  }).pipe(Effect.withSpan("cache.findInCache"));

// =============================================================================
// saveToCache - Store a postal code result with geometry
// =============================================================================

/**
 * Save a postal code result to the cache with its polygon geometry.
 *
 * Computes a bounding box from the geometry for fast spatial queries,
 * then stores the full geometry for accurate point-in-polygon tests.
 *
 * Uses INSERT OR REPLACE to update existing entries for the same postal code.
 *
 * @param result - The postal code result to cache
 * @param geometry - The polygon geometry for spatial queries
 * @returns Effect that succeeds with void or fails with CacheError
 *
 * @example
 * ```typescript
 * yield* saveToCache(
 *   { postalCode: "1050", city: "Copenhagen", country: "DK" },
 *   { type: "Polygon", coordinates: [[[12.5, 55.6], ...]] }
 * );
 * ```
 */
export const saveToCache = (
  result: CacheInput,
  geometry: CacheGeometry
): Effect.Effect<void, CacheError, CloudflareBindings> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "cache.postalCode": result.postalCode,
      "cache.country": result.country,
    });
    const { db } = yield* CloudflareBindings;
    const coords = geometry.coordinates as number[][][] | number[][][][];
    const bbox = computeBoundingBox(coords, geometry.type === "MultiPolygon");
    const expiresAt = Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS;

    yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO postal_cache 
             (country_code, postal_code, city, min_lat, max_lat, min_lng, max_lng, geometry, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            result.country,
            result.postalCode,
            result.city,
            bbox.minLat,
            bbox.maxLat,
            bbox.minLng,
            bbox.maxLng,
            JSON.stringify(geometry),
            expiresAt
          )
          .run(),
      catch: (error) =>
        new CacheError({
          message: `Failed to save to cache: ${String(error)}`,
          operation: "write",
          cause: error,
        }),
    });
  }).pipe(Effect.withSpan("cache.saveToCache"));

// =============================================================================
// cleanupExpired - Remove expired cache entries
// =============================================================================

/**
 * Remove expired entries from the cache.
 *
 * Called periodically (e.g., via /cleanup endpoint) to prevent unbounded growth.
 * Returns the number of entries deleted.
 *
 * @returns Effect that succeeds with number of deleted rows or fails with CacheError
 *
 * @example
 * ```typescript
 * const deleted = yield* cleanupExpired;
 * console.log(`Cleaned up ${deleted} expired entries`);
 * ```
 */
export const cleanupExpired: Effect.Effect<
  number,
  CacheError,
  CloudflareBindings
> = Effect.gen(function* () {
  const { db } = yield* CloudflareBindings;
  const now = Math.floor(Date.now() / 1000);

  const result = yield* Effect.tryPromise({
    try: () =>
      db.prepare("DELETE FROM postal_cache WHERE expires_at <= ?").bind(now).run(),
    catch: (error) =>
      new CacheError({
        message: `Failed to cleanup expired entries: ${String(error)}`,
        operation: "cleanup",
        cause: error,
      }),
  });

  return result.meta.changes ?? 0;
});

// =============================================================================
// findGeometryByPostalCode - Get cached geometry for a postal code
// =============================================================================

/**
 * Find cached geometry for a given postal code.
 *
 * Used by the /polygon endpoint to return GeoJSON for non-Danish postal codes.
 * Returns Option.none() if not in cache.
 *
 * @param postalCode - The postal code to look up
 * @param countryCode - The country code (e.g., "DE", "SE")
 * @returns Effect that succeeds with Option<CacheGeometry> or fails with CacheError
 */
export const findGeometryByPostalCode = (
  postalCode: string,
  countryCode: string
): Effect.Effect<Option.Option<CacheGeometry>, CacheError, CloudflareBindings> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "cache.postalCode": postalCode,
      "cache.countryCode": countryCode,
    });
    const { db } = yield* CloudflareBindings;
    const now = Math.floor(Date.now() / 1000);

    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `SELECT geometry FROM postal_cache 
             WHERE postal_code = ? AND country_code = ? AND expires_at > ?
             LIMIT 1`
          )
          .bind(postalCode, countryCode, now)
          .first<{ geometry: string }>(),
      catch: (error) =>
        new CacheError({
          message: `Failed to query geometry from cache: ${String(error)}`,
          operation: "read",
          cause: error,
        }),
    });

    if (!result) {
      return Option.none();
    }

    const geometry = yield* Effect.try({
      try: () => JSON.parse(result.geometry) as CacheGeometry,
      catch: (error) =>
        new CacheError({
          message: `Failed to parse cached geometry JSON: ${String(error)}`,
          operation: "read",
          cause: error,
        }),
    });

    return Option.some(geometry);
  }).pipe(Effect.withSpan("cache.findGeometryByPostalCode"));

// =============================================================================
// findGeometryByPostalCodeOnly - Query by postal code without country code
// =============================================================================

/**
 * Find cached geometry for a postal code (any country).
 *
 * Unlike findGeometryByPostalCode, this queries only by postal_code.
 * Used by /polygon endpoint where country is unknown.
 *
 * @param postalCode - The postal code to look up
 * @returns Effect that succeeds with Option<CacheGeometry> or fails with CacheError
 */
export const findGeometryByPostalCodeOnly = (
  postalCode: string
): Effect.Effect<Option.Option<CacheGeometry>, CacheError, CloudflareBindings> =>
  Effect.gen(function* () {
    const { db } = yield* CloudflareBindings;
    const now = Math.floor(Date.now() / 1000);

    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `SELECT geometry FROM postal_cache 
             WHERE postal_code = ? AND expires_at > ?
             LIMIT 1`
          )
          .bind(postalCode, now)
          .first<{ geometry: string }>(),
      catch: (error) =>
        new CacheError({
          message: `Failed to query geometry from cache: ${String(error)}`,
          operation: "read",
          cause: error,
        }),
    });

    if (!result) {
      return Option.none();
    }

    const geometry = yield* Effect.try({
      try: () => JSON.parse(result.geometry) as CacheGeometry,
      catch: (error) =>
        new CacheError({
          message: `Failed to parse cached geometry JSON: ${String(error)}`,
          operation: "read",
          cause: error,
        }),
    });

    return Option.some(geometry);
  });

// =============================================================================
// Helper: Compute bounding box from geometry coordinates
// =============================================================================

/**
 * Compute a bounding box from polygon coordinates.
 *
 * This is a pure function (no Effect wrapper needed) that extracts
 * min/max lat/lng from GeoJSON polygon coordinates.
 *
 * Note: With noUncheckedIndexedAccess, we must check that array elements
 * exist before using them.
 */
function computeBoundingBox(
  coordinates: number[][][] | number[][][][],
  isMulti: boolean
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const processRing = (ring: number[][]) => {
    for (const coord of ring) {
      const lng = coord[0];
      const lat = coord[1];
      // noUncheckedIndexedAccess requires explicit undefined check
      if (lng === undefined || lat === undefined) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
    }
  };

  if (isMulti) {
    for (const polygon of coordinates as number[][][][]) {
      const ring = polygon[0];
      if (ring) processRing(ring);
    }
  } else {
    const ring = (coordinates as number[][][])[0];
    if (ring) processRing(ring);
  }

  return { minLat, maxLat, minLng, maxLng };
}
