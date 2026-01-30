/**
 * Effect Tagged Errors
 *
 * Effect uses Data.TaggedError for typed errors with a `_tag` discriminator.
 *
 * Why tagged errors?
 * 1. Type-safe error handling - compiler knows all possible errors
 * 2. Pattern matching - switch on _tag to handle specific errors
 * 3. Error composition - combine errors from different services
 * 4. Rich error data - include context like coordinates, status codes
 *
 * Pattern:
 * ```typescript
 * class MyError extends Data.TaggedError("MyError")<{
 *   message: string;
 *   someContext: number;
 * }> {}
 *
 * // Usage:
 * Effect.fail(new MyError({ message: "Failed", someContext: 42 }))
 *
 * // Handling:
 * pipe(
 *   effect,
 *   Effect.catchTag("MyError", (error) => {
 *     console.log(error.someContext); // typed!
 *     return Effect.succeed(fallback);
 *   })
 * )
 * ```
 *
 * The _tag property is automatically added and can be used for:
 * - Effect.catchTag() to catch specific errors
 * - Effect.catchTags() to handle multiple error types
 * - Pattern matching in switch statements
 */

import { Data } from "effect";

// =============================================================================
// PostalCodeNotFoundError
// =============================================================================

/**
 * Thrown when no postal code is found for the given coordinates.
 * This can happen when:
 * - Coordinates are in the ocean
 * - Coordinates are in an area without postal code data
 * - Nominatim doesn't have data for the location
 */
export class PostalCodeNotFoundError extends Data.TaggedError(
  "PostalCodeNotFoundError"
)<{
  /** Human-readable error message */
  readonly message: string;
  /** The latitude that was searched */
  readonly lat: number;
  /** The longitude that was searched */
  readonly lng: number;
}> {}

// =============================================================================
// NominatimError
// =============================================================================

/**
 * Thrown when the Nominatim API request fails.
 * Examples:
 * - Network timeout
 * - Rate limited (429)
 * - Server error (5xx)
 * - Invalid response format
 */
export class NominatimError extends Data.TaggedError("NominatimError")<{
  /** Human-readable error message */
  readonly message: string;
  /** HTTP status code if applicable */
  readonly statusCode?: number | undefined;
  /** The underlying error, if any */
  readonly cause?: unknown;
}> {}

// =============================================================================
// CacheError
// =============================================================================

/**
 * Thrown when D1 database operations fail.
 * Examples:
 * - Query execution error
 * - Connection issues
 * - Invalid SQL
 */
export class CacheError extends Data.TaggedError("CacheError")<{
  /** Human-readable error message */
  readonly message: string;
  /** The operation that failed: "read", "write", "cleanup" */
  readonly operation: "read" | "write" | "cleanup";
  /** The underlying error, if any */
  readonly cause?: unknown;
}> {}

// =============================================================================
// RateLimitError
// =============================================================================

/**
 * Thrown when rate limit is exceeded.
 * This maps to HTTP 429 Too Many Requests.
 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  /** Human-readable error message */
  readonly message: string;
  /** Seconds until the rate limit resets */
  readonly retryAfter: number;
}> {}

// =============================================================================
// Error Union Type
// =============================================================================

/**
 * Union of all application errors.
 * Useful for typing catch-all error handlers.
 *
 * Usage:
 * ```typescript
 * const handleError = (error: AppError): Response => {
 *   switch (error._tag) {
 *     case "InvalidCoordinatesError":
 *       return new Response(error.message, { status: 400 });
 *     case "PostalCodeNotFoundError":
 *       return new Response(error.message, { status: 404 });
 *     // ... etc
 *   }
 * }
 * ```
 */
export type AppError =
  | PostalCodeNotFoundError
  | NominatimError
  | CacheError
  | RateLimitError;
