/**
 * Effect Nominatim HTTP Client
 *
 * This module provides an Effect-wrapped client for the Nominatim reverse
 * geocoding API (OpenStreetMap's geocoding service).
 *
 * Effect HTTP Client Patterns Used:
 *
 * 1. Effect.tryPromise - Wrapping fetch calls
 *    The native `fetch` API is Promise-based. Effect.tryPromise converts it
 *    to Effect, catching network errors and converting them to typed failures.
 *
 *    ```typescript
 *    Effect.tryPromise({
 *      try: () => fetch(url, options),
 *      catch: (error) => new NominatimError({ message: "...", cause: error })
 *    })
 *    ```
 *
 * 2. Schema.decodeUnknown - Validating API responses
 *    External APIs return unknown data. Schema.decodeUnknown safely parses
 *    and validates the response, catching malformed data before it causes issues.
 *
 *    ```typescript
 *    const decode = Schema.decodeUnknown(MySchema);
 *    const result = yield* Effect.tryPromise({
 *      try: () => decode(jsonData),
 *      catch: (error) => new NominatimError({ message: "Invalid response" })
 *    });
 *    ```
 *
 * 3. No external dependencies (R = never)
 *    Unlike the cache service, the Nominatim client has no dependencies.
 *    It uses the global `fetch` API directly. This means:
 *    - Effect<Result, NominatimError, never>
 *    - No Layer needed - can be used directly in any Effect pipeline
 *
 * Why use Effect for HTTP?
 * - Typed errors: Know exactly what can fail (NominatimError)
 * - Schema validation: Catch malformed responses early
 * - Composability: Easy to chain with cache lookups, retries, etc.
 * - Testability: Can swap the implementation for testing
 */

import { Effect, Schema, pipe } from "effect";
import { NominatimError, PostalCodeNotFoundError } from "./errors";
import {
  NominatimResponse as NominatimResponseSchema,
  type NominatimResponse,
} from "./schemas";

// =============================================================================
// Constants
// =============================================================================

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT =
  "PostalCodeAPI/1.0 (https://github.com/homborg/postnummer-api)";

// =============================================================================
// Types
// =============================================================================

/**
 * Result returned from Nominatim reverse geocoding.
 * Contains the postal code info and optionally the polygon geometry.
 */
export interface NominatimResult {
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
  readonly countryCode: string;
  readonly source: "nominatim";
}

/**
 * Geometry type matching Nominatim's GeoJSON response.
 * Used for caching the polygon data.
 * Note: LineString/Point are accepted from Nominatim but not useful for polygon display.
 */
export interface NominatimGeometry {
  readonly type: "Polygon" | "MultiPolygon" | "LineString" | "Point";
  readonly coordinates: unknown;
}

/**
 * Full response from reverseGeocode including optional geometry.
 */
export interface ReverseGeocodeResult {
  readonly result: NominatimResult;
  readonly geometry?: NominatimGeometry | undefined;
}

// =============================================================================
// reverseGeocode - Main function
// =============================================================================

/**
 * Perform reverse geocoding to find a postal code for given coordinates.
 *
 * Makes a request to Nominatim's reverse endpoint with:
 * - format=jsonv2 for structured response
 * - addressdetails=1 for postal code and city info
 * - polygon_geojson=1 for polygon data (for caching)
 *
 * This function has no service dependencies (R = never), so it can be used
 * directly without providing any Layer.
 *
 * Error handling:
 * - Network errors → NominatimError
 * - HTTP errors (4xx, 5xx) → NominatimError with statusCode
 * - Invalid JSON → NominatimError
 * - Schema validation failure → NominatimError
 * - No postcode in response → PostalCodeNotFoundError
 *
 * @param lat - Latitude to reverse geocode
 * @param lng - Longitude to reverse geocode
 * @returns Effect that succeeds with ReverseGeocodeResult or fails with NominatimError/PostalCodeNotFoundError
 *
 * @example
 * ```typescript
 * const result = yield* reverseGeocode(55.6761, 12.5683);
 * console.log(result.result.postalCode); // "1050"
 * console.log(result.result.city);       // "København"
 * ```
 */
export const reverseGeocode = (
  lat: number,
  lng: number
): Effect.Effect<
  ReverseGeocodeResult,
  NominatimError | PostalCodeNotFoundError,
  never
> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "nominatim.lat": lat, "nominatim.lng": lng });
    // Build the request URL with query parameters
    const url = new URL("/reverse", NOMINATIM_BASE);
    url.searchParams.set("lat", lat.toString());
    url.searchParams.set("lon", lng.toString());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("polygon_geojson", "1");

    // Step 1: Make the HTTP request
    // Effect.tryPromise wraps the Promise-based fetch and converts errors
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url.toString(), {
          headers: {
            "User-Agent": USER_AGENT,
          },
        }),
      catch: (error) =>
        new NominatimError({
          message: `Failed to fetch from Nominatim: ${String(error)}`,
          cause: error,
        }),
    });

    // Step 2: Check HTTP status
    // Non-OK responses should fail with the status code for debugging
    if (!response.ok) {
      return yield* Effect.fail(
        new NominatimError({
          message: `Nominatim returned status ${response.status}: ${response.statusText}`,
          statusCode: response.status,
        })
      );
    }

    // Step 3: Parse JSON response
    // JSON parsing can fail for malformed responses
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (error) =>
        new NominatimError({
          message: `Failed to parse Nominatim JSON response: ${String(error)}`,
          cause: error,
        }),
    });

    // Step 4: Validate response against schema
    // Schema.decodeUnknown returns an Effect that fails if validation fails
    const data = yield* pipe(
      Schema.decodeUnknown(NominatimResponseSchema)(json),
      Effect.mapError(
        (parseError) =>
          new NominatimError({
            message: `Invalid Nominatim response format: ${String(parseError)}`,
            cause: parseError,
          })
      )
    );

    // Step 5: Check for postcode in response
    // Nominatim may return a valid response but without postal code data
    // (e.g., for coordinates in the ocean or unmapped areas)
    if (!data.address.postcode) {
      return yield* Effect.fail(
        new PostalCodeNotFoundError({
          message: "No postal code found for the given coordinates",
          lat,
          lng,
        })
      );
    }

    // Step 6: Extract city name from various possible fields
    // Nominatim uses different fields depending on the location's administrative structure
    const city =
      data.address.city ??
      data.address.town ??
      data.address.village ??
      data.address.municipality ??
      "";

    // Step 7: Build and return the result
    const result: NominatimResult = {
      postalCode: data.address.postcode,
      city,
      country: data.address.country ?? "",
      countryCode: data.address.country_code ?? "",
      source: "nominatim",
    };

    // Include geometry if available (for caching)
    const geometry: NominatimGeometry | undefined = data.geojson
      ? {
          type: data.geojson.type,
          coordinates: data.geojson.coordinates,
        }
      : undefined;

    return { result, geometry };
  }).pipe(Effect.withSpan("nominatim.reverseGeocode"));
