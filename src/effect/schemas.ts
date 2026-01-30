/**
 * Effect Schema Definitions
 *
 * Effect Schema provides:
 * 1. Runtime validation - parse unknown data safely
 * 2. Type inference - TypeScript types derived from schemas
 * 3. Encoding/decoding - transform between wire format and domain types
 * 4. Composability - build complex schemas from simple ones
 *
 * Key patterns:
 * - Schema.Struct({ ... }) defines object schemas
 * - Schema.Literal("a", "b") creates union of literal types
 * - Schema.optional() makes fields optional
 * - Schema.decodeUnknown() parses and validates data
 *
 * Schema is available directly from the main "effect" package.
 */

import { Schema } from "effect";

// =============================================================================
// Coordinates Schema
// =============================================================================

/**
 * Coordinates schema for validating lat/lng query parameters.
 *
 * Latitude: -90 to 90
 * Longitude: -180 to 180
 *
 * We use Schema.Number with Schema.filter for range validation.
 * The filter receives the value and returns a boolean or an error message.
 */
export const Latitude = Schema.Number.pipe(
  Schema.filter((n) => n >= -90 && n <= 90, {
    message: () => "Latitude must be between -90 and 90",
  })
);

export const Longitude = Schema.Number.pipe(
  Schema.filter((n) => n >= -180 && n <= 180, {
    message: () => "Longitude must be between -180 and 180",
  })
);

/**
 * Coordinates struct combining lat and lng.
 * Used for validating incoming lookup requests.
 */
export const Coordinates = Schema.Struct({
  lat: Latitude,
  lng: Longitude,
});

/**
 * TypeScript type inferred from the Coordinates schema.
 * Use Schema.Type.infer<typeof Schema> to derive types from schemas.
 */
export type Coordinates = typeof Coordinates.Type;

// =============================================================================
// MapUrls Schema
// =============================================================================

/**
 * MapUrls schema matching the existing interface in src/types.ts.
 *
 * Note on optional properties with exactOptionalPropertyTypes:
 * - Schema.optional() creates truly optional fields (key may be absent)
 * - Schema.optionalWith({ exact: true }) for exact optional property types
 */
export const MapUrls = Schema.Struct({
  google: Schema.String,
  osm: Schema.String,
  // polygon is optional - use Schema.optional for optional fields
  polygon: Schema.optional(Schema.String),
});

export type MapUrls = typeof MapUrls.Type;

// =============================================================================
// PostalCodeResult Schema
// =============================================================================

/**
 * Source indicates where the postal code data came from:
 * - "local": Embedded Danish postal code data (postnumre.ts)
 * - "cache": D1 database cache from previous Nominatim lookups
 * - "nominatim": Fresh lookup from Nominatim API
 */
export const Source = Schema.Literal("local", "cache", "nominatim");
export type Source = typeof Source.Type;

/**
 * PostalCodeResult schema matching the existing interface.
 *
 * This is the core response type for the /lookup endpoint.
 */
export const PostalCodeResult = Schema.Struct({
  postalCode: Schema.String,
  city: Schema.String,
  country: Schema.String,
  source: Source,
  mapUrl: MapUrls,
});

export type PostalCodeResult = typeof PostalCodeResult.Type;

// =============================================================================
// PostalCodeResponse Schema (extends PostalCodeResult with coordinatesUrl)
// =============================================================================

/**
 * PostalCodeResponse extends PostalCodeResult with coordinatesUrl.
 * This is the full response sent to clients.
 *
 * We use Schema.extend() to add fields to an existing struct schema.
 */
export const PostalCodeResponse = Schema.extend(
  PostalCodeResult,
  Schema.Struct({
    coordinatesUrl: MapUrls,
  })
);

export type PostalCodeResponse = typeof PostalCodeResponse.Type;

// =============================================================================
// CachedPostalCode Schema (D1 database row)
// =============================================================================

/**
 * Schema for rows stored in the D1 postal_codes cache table.
 * Used when reading/writing cache entries.
 */
export const CachedPostalCode = Schema.Struct({
  id: Schema.Number,
  country_code: Schema.String,
  postal_code: Schema.String,
  city: Schema.String,
  min_lat: Schema.Number,
  max_lat: Schema.Number,
  min_lng: Schema.Number,
  max_lng: Schema.Number,
  geometry: Schema.String,
  expires_at: Schema.Number,
});

export type CachedPostalCode = typeof CachedPostalCode.Type;

// =============================================================================
// NominatimResponse Schema (for parsing API responses)
// =============================================================================

/**
 * Nominatim address component schema.
 * All fields are optional since Nominatim may return partial data.
 */
export const NominatimAddress = Schema.Struct({
  postcode: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  town: Schema.optional(Schema.String),
  village: Schema.optional(Schema.String),
  municipality: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  country_code: Schema.optional(Schema.String),
});

/**
 * GeoJSON geometry from Nominatim.
 * Can be Polygon or MultiPolygon.
 */
export const NominatimGeometry = Schema.Struct({
  type: Schema.Literal("Polygon", "MultiPolygon"),
  // coordinates is complex nested array - use Schema.Unknown and cast at runtime
  // This is pragmatic: full type would be Schema.Union of deeply nested arrays
  coordinates: Schema.Unknown,
});

/**
 * Nominatim reverse geocoding response.
 * Note: lat/lon come as strings from Nominatim API, not numbers.
 */
export const NominatimResponse = Schema.Struct({
  place_id: Schema.Number,
  lat: Schema.String,
  lon: Schema.String,
  display_name: Schema.String,
  address: NominatimAddress,
  geojson: Schema.optional(NominatimGeometry),
});

export type NominatimResponse = typeof NominatimResponse.Type;
