/**
 * Cloudflare Bindings Service
 *
 * This module provides Effect services for accessing Cloudflare Worker bindings
 * (D1 database, Rate Limiter) in an Effect-idiomatic way.
 *
 * Key Effect patterns:
 *
 * 1. Context.Tag - Service Identifiers
 *    Effect uses Context.Tag to create unique identifiers for services.
 *    Think of it as a "key" in a dependency injection container.
 *
 *    ```typescript
 *    class MyService extends Context.Tag("MyService")<
 *      MyService,     // The Tag itself (for type inference)
 *      ServiceType    // The type of value this tag provides
 *    >() {}
 *    ```
 *
 * 2. Layer - Dependency Injection
 *    Layers are "recipes" for constructing services. They describe:
 *    - What service they provide (the "output")
 *    - What dependencies they need (the "requirements")
 *    - How to construct the service
 *
 *    ```typescript
 *    const MyServiceLive = Layer.succeed(MyService, { ... })  // No dependencies
 *    const MyServiceLive = Layer.effect(MyService, Effect.gen(function* () {
 *      const dep = yield* SomeDependency;  // Require another service
 *      return { ... };
 *    }))
 *    ```
 *
 * 3. Using Services in Effects
 *    Services are accessed using yield* in Effect.gen:
 *
 *    ```typescript
 *    const program = Effect.gen(function* () {
 *      const bindings = yield* CloudflareBindings;
 *      const result = await bindings.db.prepare("SELECT...").all();
 *      return result;
 *    })
 *    ```
 *
 * For Cloudflare Workers, bindings come from the request's `env` parameter.
 * We create a Layer at request time that provides these bindings to the
 * Effect runtime.
 */

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

// =============================================================================
// Cloudflare Bindings Interface
// =============================================================================

/**
 * Interface matching the Cloudflare Worker environment bindings.
 *
 * This mirrors the Env type from src/types.ts but is defined here to:
 * 1. Keep Effect modules self-contained
 * 2. Allow for gradual migration
 *
 * D1Database and RateLimit are global types from @cloudflare/workers-types.
 */
export interface CloudflareBindingsService {
  /**
   * D1 database connection for caching postal code lookups.
   * Used by the CacheService to store and retrieve cached results.
   */
  readonly db: D1Database;

  /**
   * Cloudflare rate limiter binding.
   * Used to enforce request rate limits per client IP.
   */
  readonly rateLimiter: RateLimit;
}

// =============================================================================
// CloudflareBindings Context.Tag
// =============================================================================

/**
 * Context.Tag for Cloudflare Worker bindings.
 *
 * This creates a unique identifier that Effect uses to:
 * 1. Track this service as a dependency (the R in Effect<A, E, R>)
 * 2. Look up the service implementation at runtime
 *
 * Usage in Effect.gen:
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const bindings = yield* CloudflareBindings;
 *   const stmt = bindings.db.prepare("SELECT * FROM postal_codes WHERE ...");
 *   const result = await stmt.all();
 *   return result;
 * })
 * ```
 *
 * The resulting `program` has type Effect<Result, Error, CloudflareBindings>,
 * meaning it requires CloudflareBindings to be provided before it can run.
 */
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  CloudflareBindingsService
>() {}

// =============================================================================
// Layer Construction
// =============================================================================

/**
 * Create a Layer that provides CloudflareBindings from the Worker's Env.
 *
 * This is called at the start of each request, when we receive the `env`
 * parameter from Cloudflare. It creates a Layer that provides the bindings
 * to all Effect programs in the request pipeline.
 *
 * @param env - The Cloudflare Worker environment bindings
 * @returns A Layer that provides CloudflareBindings
 *
 * @example
 * ```typescript
 * // In the Worker fetch handler:
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const layer = makeCloudflareBindingsLayer(env);
 *     return Effect.runPromise(
 *       program.pipe(Effect.provide(layer))
 *     );
 *   }
 * }
 * ```
 *
 * Layer.succeed creates a Layer with no dependencies (Layer<CloudflareBindings, never, never>)
 * - First type param: what it provides (CloudflareBindings)
 * - Second type param: errors (never - construction can't fail)
 * - Third type param: requirements (never - no dependencies)
 */
export const makeCloudflareBindingsLayer = (env: {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
}): Layer.Layer<CloudflareBindings> =>
  Layer.succeed(CloudflareBindings, {
    db: env.DB,
    rateLimiter: env.RATE_LIMITER,
  });

// =============================================================================
// Re-export the Env type for convenience
// =============================================================================

/**
 * The raw Cloudflare Worker environment type.
 * Re-exported for use in request handlers.
 */
export interface Env {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
}
