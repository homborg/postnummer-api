/**
 * Effect HttpApi Definition
 *
 * This module defines the Postnummer API using @effect/platform's HttpApi pattern.
 * It provides a declarative API definition with automatic OpenAPI generation.
 *
 * Key patterns:
 *
 * 1. HttpApi.make + HttpApiGroup + HttpApiEndpoint
 *    Define API structure declaratively, separate from implementation.
 *
 * 2. HttpApiBuilder.group
 *    Implement handlers for each endpoint in a group.
 *
 * 3. HttpApiBuilder.toWebHandler
 *    Convert to a web-standard handler for Cloudflare Workers.
 *
 * Only JSON endpoints are defined here:
 * - GET /lookup - coordinates to postal code lookup
 * - GET /polygon/:postalCode - GeoJSON polygon for a postal code
 *
 * HTML endpoints (/, /map) remain on the existing HttpRouter.
 * Cache cleanup is handled by a scheduled cron trigger (see index.ts).
 */

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform";
import { Effect, Layer, Option, pipe, Schema } from "effect";
import { OpenApi } from "@effect/platform";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";

import {
  Latitude,
  Longitude,
  LookupResponseSchema,
  LookupResponse,
  GeoJSONGeometrySchema,
  BadRequestSchema,
  NotFoundErrorSchema,
  InternalErrorSchema,
  BadGatewaySchema,
  PolygonQueryParamsSchema,
} from "./schemas";
import { findPostalCode, findPolygonByPostalCode } from "./geo";
import { findInCache, saveToCache, findGeometryByPostalCode } from "./cache";
import { reverseGeocode } from "./nominatim";
import geojson from "../postnumre";

// =============================================================================
// API Definition
// =============================================================================

/**
 * Lookup endpoint - GET /lookup?lat=...&lng=...
 */
const lookupEndpoint = HttpApiEndpoint.get("lookup", "/lookup")
  .setUrlParams(
    Schema.Struct({
      lat: Schema.compose(Schema.NumberFromString, Latitude),
      lng: Schema.compose(Schema.NumberFromString, Longitude),
    })
  )
  .addSuccess(LookupResponseSchema)
  .addError(BadRequestSchema, { status: 400 })
  .addError(NotFoundErrorSchema, { status: 404 })
  .addError(InternalErrorSchema, { status: 500 })
  .addError(BadGatewaySchema, { status: 502 })
  .annotate(OpenApi.Summary, "Lookup postal code by coordinates")
  .annotate(
    OpenApi.Description,
    "Returns postal code information for given latitude and longitude coordinates. " +
      "Tries Danish local data first, then D1 cache, then Nominatim API."
  );

/**
 * Polygon endpoint - GET /polygon/:postalCode
 */
const postalCodeParam = HttpApiSchema.param("postalCode", Schema.String);

const polygonEndpoint = HttpApiEndpoint.get("polygon")`/polygon/${postalCodeParam}`
  .setUrlParams(PolygonQueryParamsSchema)
  .addSuccess(GeoJSONGeometrySchema)
  .addError(BadRequestSchema, { status: 400 })
  .addError(NotFoundErrorSchema, { status: 404 })
  .annotate(OpenApi.Summary, "Get polygon geometry for a postal code")
  .annotate(
    OpenApi.Description,
    "Returns GeoJSON polygon geometry for the given postal code. " +
      "Provide the country query parameter (ISO-3166 alpha-2). " +
      "If omitted, the service falls back to request.cf.country when available. " +
      "Danish postal codes use embedded data; others use cached Nominatim data."
  );

/**
 * Main API group for postal code operations
 */
const postalCodeGroup = HttpApiGroup.make("postalCode")
  .add(lookupEndpoint)
  .add(polygonEndpoint)
  .annotate(OpenApi.Title, "Postal Code API");

/**
 * The full Postnummer API definition
 */
export const PostnummerApi = HttpApi.make("PostnummerApi")
  .add(postalCodeGroup)
  .annotate(OpenApi.Title, "Postnummer API")
  .annotate(
    OpenApi.Description,
    "Danish postal code lookup API from geographical coordinates. " +
      "Uses embedded Danish postal code data for Denmark and Nominatim for other locations."
  );

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
): { google: string; osm: string; polygon?: string } {
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
function buildCoordinatesUrls(
  lat: number,
  lng: number,
  baseUrl: string
): { google: string; osm: string; polygon?: string } {
  return {
    google: `https://www.google.com/maps?q=${lat},${lng}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`,
    polygon: `${baseUrl}/map?lat=${lat}&lng=${lng}`,
  };
}

// =============================================================================
// API Implementation
// =============================================================================

/**
 * Implement the postalCode group handlers
 */
export const PostalCodeGroupLive = HttpApiBuilder.group(
  PostnummerApi,
  "postalCode",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("lookup", ({ urlParams: { lat, lng } }) =>
          pipe(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "lookup.lat": lat, "lookup.lng": lng });
              const baseUrl = "";
              const coordinatesUrl = buildCoordinatesUrls(lat, lng, baseUrl);

              const respond = (result: {
                postalCode: string;
                city: string;
                country: string;
                source: "local" | "cache" | "nominatim";
              }): LookupResponse => {
                const mapUrl = buildMapUrls(
                  result.postalCode,
                  result.city,
                  result.country,
                  baseUrl
                );
                return {
                  ...result,
                  mapUrl,
                  coordinatesUrl,
                };
              };

              // Try Denmark local data first
              const isDenmark =
                lat >= 54.5 && lat <= 58 && lng >= 8 && lng <= 15.5;
              if (isDenmark) {
                const dkResult = yield* findPostalCode(lat, lng, geojson);
                if (Option.isSome(dkResult)) {
                  return respond({
                    postalCode: dkResult.value.postnummer,
                    city: dkResult.value.navn,
                    country: "Denmark",
                    source: "local",
                  });
                }
              }

              // Try D1 cache
              const cached = yield* pipe(
                findInCache(lat, lng),
                Effect.catchTag("CacheError", (e) =>
                  pipe(
                    Effect.logWarning(`Cache lookup failed, falling back to Nominatim: ${e.message}`),
                    Effect.map(() => Option.none())
                  )
                )
              );
              if (Option.isSome(cached)) {
                return respond({
                  postalCode: cached.value.postalCode,
                  city: cached.value.city,
                  country: cached.value.country,
                  source: "cache",
                });
              }

              // Fall back to Nominatim
              const nominatimResult = yield* reverseGeocode(lat, lng);

              // Cache the result if we have polygon geometry (ignore errors)
              // Only Polygon/MultiPolygon are cacheable; LineString/Point are not useful
              const geom = nominatimResult.geometry;
              if (
                geom &&
                (geom.type === "Polygon" || geom.type === "MultiPolygon")
              ) {
                yield* pipe(
                  saveToCache(
                    {
                      postalCode: nominatimResult.result.postalCode,
                      city: nominatimResult.result.city,
                      country: nominatimResult.result.countryCode,
                    },
                    geom as {
                      readonly type: "Polygon" | "MultiPolygon";
                      readonly coordinates: number[][][] | number[][][][];
                    }
                  ),
                  Effect.catchAll(() => Effect.void)
                );
              }

              return respond({
                postalCode: nominatimResult.result.postalCode,
                city: nominatimResult.result.city,
                country: nominatimResult.result.country,
                source: "nominatim",
              });
            }),
            // Map application errors to API error schemas
            Effect.catchTag("PostalCodeNotFoundError", (e) =>
              Effect.fail({
                error: e.message,
                lat: e.lat,
                lng: e.lng,
              } satisfies typeof NotFoundErrorSchema.Type)
            ),
            Effect.catchTag("NominatimError", (e) =>
              // Use BadGateway for upstream failures, InternalError for other issues
              e.statusCode !== undefined && e.statusCode >= 500
                ? Effect.fail({
                    error: e.message,
                  } satisfies typeof BadGatewaySchema.Type)
                : Effect.fail({
                    error: e.message,
                  } satisfies typeof InternalErrorSchema.Type)
            ),
            Effect.withSpan("api.lookup")
          )
        )
        .handle("polygon", ({ path: { postalCode }, urlParams }) =>
          pipe(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "polygon.postalCode": postalCode });
              const request = yield* HttpServerRequest.HttpServerRequest;
              const cfCountry = (request.source as Request & { cf?: { country?: string } })
                .cf?.country;
              const countryCode = (urlParams.country ?? cfCountry)?.trim().toUpperCase();

              if (!countryCode) {
                return yield* Effect.fail({
                  error: "Country code is required for polygon lookup",
                } satisfies typeof BadRequestSchema.Type);
              }

              // Try Danish embedded data first
              if (countryCode === "DK") {
                const dkPolygon = yield* findPolygonByPostalCode(
                  postalCode,
                  geojson
                );
                if (Option.isSome(dkPolygon)) {
                  return HttpServerResponse.unsafeJson(dkPolygon.value, {
                    headers: {
                      vary: "cf-country,country",
                    },
                  });
                }
              }

              // Try D1 cache for non-Danish postal codes
              const cached = yield* findGeometryByPostalCode(
                postalCode,
                countryCode
              );
              if (Option.isSome(cached)) {
                return HttpServerResponse.unsafeJson(cached.value, {
                  headers: {
                    vary: "cf-country,country",
                  },
                });
              }

              // Polygon not found
              return yield* Effect.fail({
                error: "Polygon not found",
              } satisfies typeof NotFoundErrorSchema.Type);
            }),
            Effect.catchTag("CacheError", (e) =>
              Effect.fail({
                error: e.message,
              } satisfies typeof InternalErrorSchema.Type)
            ),
            Effect.withSpan("api.polygon")
          )
        );
    })
);

/**
 * The full API implementation layer
 */
export const PostnummerApiLive = HttpApiBuilder.api(PostnummerApi).pipe(
  Layer.provide(PostalCodeGroupLive)
);
