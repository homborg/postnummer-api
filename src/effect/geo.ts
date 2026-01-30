/**
 * Effect Geo Module
 *
 * This module wraps the pure geo functions with Effect for use in the Effect pipeline.
 *
 * When to use Effect vs pure functions:
 *
 * 1. PURE FUNCTIONS (no Effect wrapper):
 *    - Boolean predicates like `pointInGeometry` - just return true/false
 *    - Simple transformations with no failure cases
 *    - Performance-critical inner loops
 *
 * 2. EFFECT WRAPPERS:
 *    - Functions that can "fail" in a domain sense (e.g., "not found")
 *    - Functions that need to compose with other Effects in a pipeline
 *    - Functions where you want typed errors in the Effect channel
 *
 * 3. OPTION vs EFFECT.FAIL:
 *    - Use Option<A> when "not found" is expected and normal (e.g., cache miss)
 *    - Use Effect.fail with tagged error when "not found" should propagate up
 *    - This module provides both patterns for flexibility
 *
 * Pattern: Wrapping pure functions
 * ```typescript
 * // Pure function returns A | null
 * const pureFunction = (input: Input): Result | null => { ... }
 *
 * // Effect wrapper - Option pattern (not found is normal)
 * const effectFunction = (input: Input): Effect<Option<Result>, never, never> =>
 *   Effect.succeed(Option.fromNullable(pureFunction(input)))
 *
 * // Effect wrapper - Error pattern (not found is exceptional)
 * const effectFunction = (input: Input): Effect<Result, NotFoundError, never> =>
 *   pipe(
 *     Effect.succeed(pureFunction(input)),
 *     Effect.flatMap(result =>
 *       result !== null
 *         ? Effect.succeed(result)
 *         : Effect.fail(new NotFoundError({ ... }))
 *     )
 *   )
 * ```
 */

import { Effect, Option, pipe } from "effect";
import {
  findPostalCode as findPostalCodePure,
  findPolygonByPostalCode as findPolygonByPostalCodePure,
  pointInGeometry as pointInGeometryPure,
  type FeatureCollection,
  type Feature,
  type PostalCode,
} from "../geo";
import { PostalCodeNotFoundError } from "./errors";

// =============================================================================
// Re-export types from geo.ts for convenience
// =============================================================================

export type { FeatureCollection, Feature, PostalCode };

// =============================================================================
// Re-export pure function (no Effect wrapper needed)
// =============================================================================

/**
 * Check if a point is inside a geometry.
 *
 * This remains a pure function because:
 * - It's a simple boolean predicate with no failure case
 * - It may be called in tight loops for spatial queries
 * - There's no domain error to model (false is a valid answer, not a failure)
 *
 * When to use:
 * - Filtering cached entries by spatial containment
 * - Validating if coordinates fall within a known boundary
 */
export const pointInGeometry = pointInGeometryPure;

// =============================================================================
// findPostalCode - Option pattern (not found is normal)
// =============================================================================

/**
 * Find a postal code for given coordinates in a GeoJSON FeatureCollection.
 * Returns Option.some(PostalCode) if found, Option.none() if not.
 *
 * This uses the Option pattern because:
 * - "Not found" in local data is expected (coordinates might be outside Denmark)
 * - The caller will typically try other sources (cache, Nominatim) on None
 * - Option composes well with Effect.flatMap for fallback chains
 *
 * @param lat - Latitude (-90 to 90)
 * @param lng - Longitude (-180 to 180)
 * @param geojson - Danish postal code GeoJSON data
 * @returns Effect that always succeeds with Option<PostalCode>
 *
 * @example
 * ```typescript
 * const result = yield* findPostalCode(55.6761, 12.5683, danishPostalCodes);
 * if (Option.isSome(result)) {
 *   console.log(result.value.postnummer); // "1050"
 * }
 * ```
 */
export const findPostalCode = (
  lat: number,
  lng: number,
  geojson: FeatureCollection
): Effect.Effect<Option.Option<PostalCode>, never, never> =>
  Effect.succeed(Option.fromNullable(findPostalCodePure(lat, lng, geojson)));

// =============================================================================
// findPostalCodeOrFail - Error pattern (not found is exceptional)
// =============================================================================

/**
 * Find a postal code for given coordinates, failing if not found.
 *
 * This uses the Error pattern because:
 * - Used when we expect to find a result (e.g., after trying all sources)
 * - The error carries context (lat/lng) for debugging
 * - Integrates with Effect.catchTag for error handling
 *
 * @param lat - Latitude
 * @param lng - Longitude
 * @param geojson - Danish postal code GeoJSON data
 * @returns Effect that succeeds with PostalCode or fails with PostalCodeNotFoundError
 *
 * @example
 * ```typescript
 * const result = yield* pipe(
 *   findPostalCodeOrFail(lat, lng, danishData),
 *   Effect.catchTag("PostalCodeNotFoundError", () => tryCache(lat, lng))
 * );
 * ```
 */
export const findPostalCodeOrFail = (
  lat: number,
  lng: number,
  geojson: FeatureCollection
): Effect.Effect<PostalCode, PostalCodeNotFoundError, never> =>
  pipe(
    findPostalCode(lat, lng, geojson),
    Effect.flatMap((option) =>
      Option.isSome(option)
        ? Effect.succeed(option.value)
        : Effect.fail(
            new PostalCodeNotFoundError({
              message: `No postal code found for coordinates (${lat}, ${lng})`,
              lat,
              lng,
            })
          )
    )
  );

// =============================================================================
// findPolygonByPostalCode - Option pattern
// =============================================================================

/**
 * Find a polygon geometry for a given postal code.
 * Returns Option.some(geometry) if found, Option.none() if not.
 *
 * Uses the Option pattern because:
 * - Only Danish postal codes have embedded polygons
 * - "Not found" means we need to try the cache or return 404
 * - Option allows the caller to decide how to handle missing polygons
 *
 * @param postalCode - The postal code to look up (e.g., "1050")
 * @param geojson - Danish postal code GeoJSON data
 * @returns Effect that always succeeds with Option<Geometry>
 *
 * @example
 * ```typescript
 * const polygon = yield* findPolygonByPostalCode("1050", danishPostalCodes);
 * if (Option.isSome(polygon)) {
 *   return Response.json(polygon.value);
 * } else {
 *   // Try cache or return 404
 * }
 * ```
 */
export const findPolygonByPostalCode = (
  postalCode: string,
  geojson: FeatureCollection
): Effect.Effect<Option.Option<Feature["geometry"]>, never, never> =>
  Effect.succeed(
    Option.fromNullable(findPolygonByPostalCodePure(postalCode, geojson))
  );
