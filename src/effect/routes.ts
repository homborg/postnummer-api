/**
 * Effect HTTP Router
 *
 * This module defines all HTTP routes using @effect/platform's HttpRouter.
 *
 * Key patterns used:
 *
 * 1. HttpRouter.empty + pipe + HttpRouter.get/post/...
 *    Build routers by starting with an empty router and adding routes:
 *
 *    ```typescript
 *    const router = HttpRouter.empty.pipe(
 *      HttpRouter.get("/", handler),
 *      HttpRouter.get("/api", anotherHandler),
 *    )
 *    ```
 *
 * 2. HttpServerResponse for creating responses
 *    - HttpServerResponse.html(string) for HTML content
 *    - HttpServerResponse.json(data) for JSON (returns Effect)
 *    - HttpServerResponse.empty({ status: 404 }) for empty responses
 *
 * 3. HttpRouter.schemaParams for query parameter validation
 *    Validates URL search params against a Schema and provides typed access.
 *
 * 4. HttpRouter.schemaPathParams for path parameter validation
 *    Validates path params (e.g., /:postalCode) against a Schema.
 *
 * 5. Route handlers return Effect<Respondable, E, R>
 *    Respondable is anything that can be converted to a response.
 *    HttpServerResponse itself is Respondable, or you can return data
 *    that will be automatically serialized.
 */

import { Effect, Option, pipe, Schema } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as HttpBody from "@effect/platform/HttpBody";
import type { ParseError } from "effect/ParseResult";

import { CloudflareBindings } from "./bindings";
import {
  InvalidCoordinatesError,
  PostalCodeNotFoundError,
  CacheError,
  NominatimError,
} from "./errors";
import { Coordinates, Latitude, Longitude } from "./schemas";
import { findPostalCode, findPolygonByPostalCode } from "./geo";
import { findInCache, saveToCache, cleanupExpired } from "./cache";
import { reverseGeocode, buildMapUrl } from "./nominatim";
import geojson from "../postnumre";
import indexHtml from "../index.html";
import mapHtml from "../map.html";

// =============================================================================
// Query Parameter Schemas
// =============================================================================

/**
 * Schema for /lookup query parameters.
 * Validates lat and lng as string-to-number conversion with range validation.
 *
 * Effect Schema pattern:
 * - Schema.NumberFromString handles the conversion from query string to number
 * - We compose with our range-validated Latitude/Longitude schemas
 */
const LookupQueryParams = Schema.Struct({
  lat: Schema.compose(Schema.NumberFromString, Latitude),
  lng: Schema.compose(Schema.NumberFromString, Longitude),
});

/**
 * Schema for path parameter in /polygon/:postalCode
 */
const PolygonPathParams = Schema.Struct({
  postalCode: Schema.String,
});

// =============================================================================
// Response Types
// =============================================================================

/**
 * Map URLs included in the response.
 */
interface MapUrls {
  readonly google: string;
  readonly osm: string;
  readonly polygon?: string | undefined;
}

/**
 * Full response for the /lookup endpoint.
 */
interface LookupResponse {
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
  readonly source: "local" | "cache" | "nominatim";
  readonly mapUrl: MapUrls;
  readonly coordinatesUrl: MapUrls;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Build map URLs for a postal code result.
 */
function buildMapUrls(
  postalCode: string,
  city: string,
  country: string,
  baseUrl: string
): MapUrls {
  const query = encodeURIComponent(`${postalCode} ${city} ${country}`);
  return {
    google: `https://www.google.com/maps/search/${query}`,
    osm: `https://www.openstreetmap.org/search?query=${query}`,
    polygon: `${baseUrl}/polygon/${encodeURIComponent(postalCode)}`,
  };
}

/**
 * Build coordinates map URLs.
 */
function buildCoordinatesUrls(lat: number, lng: number, baseUrl: string): MapUrls {
  return {
    google: `https://www.google.com/maps?q=${lat},${lng}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`,
    polygon: `${baseUrl}/map?lat=${lat}&lng=${lng}`,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * GET / - Serve index.html
 *
 * Returns the API documentation homepage as static HTML.
 */
const indexHandler = Effect.succeed(HttpServerResponse.html(indexHtml));

/**
 * GET /map - Serve map.html
 *
 * Returns the map visualization page as static HTML.
 */
const mapHandler = Effect.succeed(HttpServerResponse.html(mapHtml));

/**
 * GET /polygon/:postalCode - Return GeoJSON for a postal code
 *
 * Tries embedded Danish data first, then D1 cache for other countries.
 * Returns 404 if polygon not found.
 */
const polygonHandler = Effect.gen(function* () {
  // Access path params using HttpRouter.schemaPathParams
  const { postalCode } = yield* HttpRouter.schemaPathParams(PolygonPathParams);

  // Try Danish embedded data first
  const dkPolygon = yield* findPolygonByPostalCode(postalCode, geojson);
  if (Option.isSome(dkPolygon)) {
    return yield* pipe(
      HttpServerResponse.json(dkPolygon.value),
      Effect.map((response) =>
        HttpServerResponse.setHeader(response, "Content-Type", "application/geo+json")
      )
    );
  }

  // Try D1 cache for non-Danish postal codes
  // Note: We need CloudflareBindings for this
  const { db } = yield* CloudflareBindings;
  const cached = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare("SELECT geometry FROM postal_cache WHERE postal_code = ? LIMIT 1")
        .bind(postalCode)
        .first<{ geometry: string }>(),
    catch: () =>
      new CacheError({
        message: "Failed to query cache",
        operation: "read",
      }),
  });

  if (cached?.geometry) {
    const geometry = JSON.parse(cached.geometry) as unknown;
    return yield* pipe(
      HttpServerResponse.json(geometry),
      Effect.map((response) =>
        HttpServerResponse.setHeader(response, "Content-Type", "application/geo+json")
      )
    );
  }

  // Polygon not found
  return yield* HttpServerResponse.json({ error: "Polygon not found" }, { status: 404 });
});

/**
 * GET /lookup - Main postal code lookup
 *
 * The core endpoint that:
 * 1. Validates coordinates from query params
 * 2. Tries Danish local data first (for Denmark coordinates)
 * 3. Falls back to D1 cache
 * 4. Falls back to Nominatim API
 * 5. Caches Nominatim results
 * 6. Returns response with cache headers
 *
 * Effect pipeline pattern:
 * - Effect.gen provides clean async sequencing
 * - Tagged errors bubble up for handler-level error mapping
 * - CloudflareBindings accessed via yield*
 */
const lookupHandler = Effect.gen(function* () {
  // Step 1: Validate query params using schema
  const { lat, lng } = yield* pipe(
    HttpRouter.schemaParams(LookupQueryParams),
    Effect.mapError(
      (parseError) =>
        new InvalidCoordinatesError({
          message: `Invalid coordinates: ${parseError.message}`,
        })
    )
  );

  // Build URLs for response
  const baseUrl = ""; // Will be set from request later if needed
  const coordinatesUrl = buildCoordinatesUrls(lat, lng, baseUrl);

  /**
   * Helper to create the final response with cache headers.
   */
  const respond = (
    result: {
      postalCode: string;
      city: string;
      country: string;
      source: "local" | "cache" | "nominatim";
    },
    cacheHit: boolean
  ) =>
    Effect.gen(function* () {
      const mapUrl = buildMapUrls(result.postalCode, result.city, result.country, baseUrl);
      const response: LookupResponse = {
        ...result,
        mapUrl,
        coordinatesUrl,
      };

      const jsonResponse = yield* HttpServerResponse.json(response);
      return pipe(
        jsonResponse,
        (r) => HttpServerResponse.setHeader(r, "X-Cache", cacheHit ? "HIT" : "MISS"),
        (r) => HttpServerResponse.setHeader(r, "X-Cache-Source", result.source)
      );
    });

  // Step 2: Try Denmark local data first (fast, accurate)
  const isDenmark = lat >= 54.5 && lat <= 58 && lng >= 8 && lng <= 15.5;
  if (isDenmark) {
    const dkResult = yield* findPostalCode(lat, lng, geojson);
    if (Option.isSome(dkResult)) {
      return yield* respond(
        {
          postalCode: dkResult.value.postnummer,
          city: dkResult.value.navn,
          country: "Denmark",
          source: "local",
        },
        true
      );
    }
  }

  // Step 3: Try D1 cache
  const cached = yield* findInCache(lat, lng);
  if (Option.isSome(cached)) {
    return yield* respond(
      {
        postalCode: cached.value.postalCode,
        city: cached.value.city,
        country: cached.value.country,
        source: "cache",
      },
      true
    );
  }

  // Step 4: Fall back to Nominatim
  const nominatimResult = yield* reverseGeocode(lat, lng);

  // Step 5: Cache the result if we have geometry
  if (nominatimResult.geometry) {
    yield* pipe(
      saveToCache(
        {
          postalCode: nominatimResult.result.postalCode,
          city: nominatimResult.result.city,
          country: nominatimResult.result.countryCode,
        },
        nominatimResult.geometry as {
          readonly type: "Polygon" | "MultiPolygon";
          readonly coordinates: number[][][] | number[][][][];
        }
      ),
      // Cache failures shouldn't break the response
      Effect.catchAll(() => Effect.void)
    );
  }

  // Step 6: Return response
  return yield* respond(
    {
      postalCode: nominatimResult.result.postalCode,
      city: nominatimResult.result.city,
      country: nominatimResult.result.country,
      source: "nominatim",
    },
    false
  );
});

/**
 * GET /cleanup - Cache cleanup endpoint
 *
 * Removes expired cache entries. Can be called by cron trigger.
 */
const cleanupHandler = Effect.gen(function* () {
  const deleted = yield* cleanupExpired;
  return yield* HttpServerResponse.json({ deleted });
});

// =============================================================================
// Error Handlers
// =============================================================================

/**
 * Convert application errors to HTTP responses.
 *
 * This pattern uses HttpRouter.catchAll to handle all error types
 * and convert them to appropriate HTTP status codes.
 *
 * We use HttpServerResponse.unsafeJson here because:
 * - Error response bodies are simple objects that will always serialize
 * - It returns HttpServerResponse directly (not Effect) which is needed
 *   for the error handler return type
 */
type AppError =
  | InvalidCoordinatesError
  | PostalCodeNotFoundError
  | CacheError
  | NominatimError
  | ParseError
  | HttpBody.HttpBodyError;

const errorToResponse = (
  error: AppError
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> => {
  // Pattern match on error._tag for type-safe error handling
  if ("_tag" in error) {
    switch (error._tag) {
      case "InvalidCoordinatesError":
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: error.message }, { status: 400 })
        );

      case "PostalCodeNotFoundError":
        return Effect.succeed(
          HttpServerResponse.unsafeJson(
            { error: error.message, lat: error.lat, lng: error.lng },
            { status: 404 }
          )
        );

      case "CacheError":
        // Cache errors are internal - don't expose details
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: "Internal server error" }, { status: 500 })
        );

      case "NominatimError":
        // Map Nominatim errors - use 502 for upstream failures
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: "External service error" }, { status: 502 })
        );

      case "ParseError":
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: "Invalid request parameters" }, { status: 400 })
        );

      case "HttpBodyError":
        // This shouldn't happen with simple JSON, but handle it
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: "Response serialization error" }, { status: 500 })
        );
    }
  }

  // Fallback for unknown errors
  return Effect.succeed(
    HttpServerResponse.unsafeJson({ error: "Internal server error" }, { status: 500 })
  );
};

// =============================================================================
// Router Definition
// =============================================================================

/**
 * The main HTTP router for the Postnummer API.
 *
 * Routes are defined using HttpRouter.empty.pipe() with HttpRouter.get/post/etc.
 * Each route handler is an Effect that returns a Respondable (usually HttpServerResponse).
 *
 * Error handling is done at the router level using HttpRouter.catchAll, which
 * converts application errors to appropriate HTTP responses.
 */
export const router = HttpRouter.empty.pipe(
  // Static pages
  HttpRouter.get("/", indexHandler),
  HttpRouter.get("/map", mapHandler),

  // API endpoints
  HttpRouter.get("/polygon/:postalCode", polygonHandler),
  HttpRouter.get("/lookup", lookupHandler),
  HttpRouter.get("/cleanup", cleanupHandler),

  // Global error handling
  // Converts all application errors to HTTP responses
  HttpRouter.catchAll(errorToResponse)
);

/**
 * Export the router type for use in the main entry point.
 *
 * The router has type HttpRouter<never, CloudflareBindings> meaning:
 * - E = never (all errors are handled by catchAll)
 * - R = CloudflareBindings (requires bindings to be provided)
 */
export type AppRouter = typeof router;
