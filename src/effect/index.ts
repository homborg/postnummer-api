/**
 * Effect Entry Point for Cloudflare Workers
 *
 * This module exports the main fetch handler for the Postnummer API,
 * combining HttpApi (JSON endpoints) with HttpRouter (HTML pages).
 *
 * Architecture:
 * - HttpApi (api.ts): JSON API endpoints with OpenAPI/Swagger
 *   - GET /lookup - coordinates to postal code
 *   - GET /polygon/:postalCode - GeoJSON geometry
 *   - GET /docs - Swagger UI (auto-generated)
 *
 * - HttpRouter (routes.ts): HTML pages
 *   - GET / - API documentation homepage
 *   - GET /map - Map visualization page
 *
 * - Scheduled handler: Cache cleanup (cron-triggered)
 *
 * - Rate limiting: Cloudflare Rate Limiting binding enforces request limits
 *
 * Key Effect Patterns for Cloudflare Workers:
 *
 * 1. HttpApiBuilder.toWebHandler - Converting HttpApi to web handler
 *    Creates a handler function that takes a Request and returns Response.
 *
 * 2. Request-time Layer construction
 *    Cloudflare Workers receive `env` (bindings) with each request.
 *    We must construct the Layer at request time.
 *
 * 3. Routing strategy
 *    HTML routes (/, /map) go to HttpRouter.
 *    API routes (/lookup, /polygon, /docs) go to HttpApi.
 *
 * 4. Scheduled handler
 *    Cloudflare cron triggers call the scheduled() handler directly.
 *    Used for periodic cache cleanup without HTTP exposure.
 *
 * 5. Rate limiting
 *    API routes are rate limited using Cloudflare's Rate Limiting binding.
 *    Returns 429 with Retry-After header when limit is exceeded.
 */

import { Effect, Layer, pipe } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as HttpServer from "@effect/platform/HttpServer";
import { HttpApiBuilder, HttpApiSwagger } from "@effect/platform";

import { htmlRouter } from "./routes";
import {
  PostnummerApi,
  PostnummerApiLive,
  PostalCodeGroupLive,
} from "./api";
import {
  CloudflareBindings,
  makeCloudflareBindingsLayer,
  type Env,
} from "./bindings";
import { cleanupExpired } from "./cache";
import { TracerLive } from "./tracer";

// =============================================================================
// HTML Router Handler
// =============================================================================

/**
 * Convert the HTML router to an HttpApp for handling HTML pages.
 */
const htmlApp = HttpRouter.toHttpApp(htmlRouter);

/**
 * Handle HTML routes (/, /map) using the HttpRouter.
 */
async function handleHtmlRequest(
  request: Request,
  bindingsLayer: Layer.Layer<CloudflareBindings>
): Promise<Response | null> {
  const url = new URL(request.url);

  // Only handle HTML routes
  if (url.pathname !== "/" && url.pathname !== "/map") {
    return null;
  }

  const program = pipe(
    htmlApp,
    Effect.flatMap((app) => app),
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(request)
    ),
    Effect.provide(bindingsLayer),
    Effect.scoped
  );

  const response = await Effect.runPromise(program);
  return HttpServerResponse.toWeb(response);
}

// =============================================================================
// Static API Layer (built once at module load)
// =============================================================================

/**
 * Swagger UI layer - built once at startup.
 * This is expensive to construct so we do it at module scope.
 */
const SwaggerLayer = HttpApiSwagger.layer({
  path: "/docs",
}).pipe(Layer.provide(PostnummerApiLive));

/**
 * Base API layer without bindings - built once at startup.
 * Combines the API implementation with Swagger UI and HTTP server context.
 */
const ApiLayerBase = Layer.mergeAll(
  PostnummerApiLive,
  SwaggerLayer,
  HttpServer.layerContext,
  TracerLive
);

// =============================================================================
// API Handler Factory
// =============================================================================

/**
 * Create an API handler for the given environment.
 *
 * Uses HttpApiBuilder.toWebHandler to create a web-standard handler.
 * Only the bindings layer varies per-request; the API layer base is reused.
 */
function createApiHandler(env: Env): {
  handler: (request: Request) => Promise<Response>;
  dispose: () => Promise<void>;
} {
  const bindingsLayer = makeCloudflareBindingsLayer(env);
  const ApiLive = ApiLayerBase.pipe(Layer.provide(bindingsLayer));

  return HttpApiBuilder.toWebHandler(ApiLive);
}

// =============================================================================
// Rate Limiting
// =============================================================================

/**
 * Check rate limit for the request.
 *
 * Uses the client IP address (from CF-Connecting-IP header) as the rate limit key.
 * The rate limiter is configured in wrangler.toml with limit and period settings.
 *
 * @param request - The incoming request
 * @param env - The Cloudflare Worker environment
 * @returns Response with 429 status if rate limited, null otherwise
 */
async function checkRateLimit(
  request: Request,
  env: Env
): Promise<Response | null> {
  const rateLimiter = env.RATE_LIMITER;

  // Get client IP from Cloudflare header (falls back to "unknown" if not available)
  const clientIP = request.headers.get("CF-Connecting-IP") ?? "unknown";

  try {
    const { success } = await rateLimiter.limit({ key: clientIP });

    if (!success) {
      // Rate limit exceeded - return 429 Too Many Requests
      // The period is configured in wrangler.toml (60 seconds)
      const retryAfter = 60;

      return new Response(
        JSON.stringify({
          error: "Too many requests. Please try again later.",
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        }
      );
    }
  } catch (error) {
    // On rate limiter error, log and allow the request (fail open)
    console.error("[Rate Limit] Error checking rate limit:", error);
  }

  return null;
}

// =============================================================================
// Request Handler
// =============================================================================

/**
 * Handle an incoming HTTP request.
 *
 * Request flow:
 * 1. Check rate limit for API routes
 * 2. HTML routes (/, /map) → HttpRouter (not rate limited)
 * 3. API routes (/lookup, /polygon, /docs) → HttpApi (rate limited)
 *
 * @param request - The incoming web Request from Cloudflare
 * @param env - The Cloudflare Worker environment bindings
 * @returns Promise<Response> - The web Response to send back
 */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const bindingsLayer = makeCloudflareBindingsLayer(env);
  const url = new URL(request.url);

  // Try HTML routes first (faster for static pages, not rate limited)
  const htmlResponse = await handleHtmlRequest(request, bindingsLayer);
  if (htmlResponse) {
    return htmlResponse;
  }

  // Rate limit API routes only (not /docs for better developer experience)
  if (url.pathname !== "/docs") {
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
  }

  // Handle API routes
  const { handler, dispose } = createApiHandler(env);
  try {
    return await handler(request);
  } finally {
    await dispose();
  }
}

// =============================================================================
// Scheduled Handler (Cron Cleanup)
// =============================================================================

/**
 * Handle scheduled events (cron triggers).
 *
 * Cloudflare cron triggers call this handler directly - it's an internal
 * event, not an HTTP request, so no authentication is needed.
 *
 * @param _event - The scheduled event (unused, contains cron metadata)
 * @param env - The Cloudflare Worker environment bindings
 * @param ctx - The execution context for waitUntil
 */
async function handleScheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const bindingsLayer = makeCloudflareBindingsLayer(env);

  const program = pipe(
    cleanupExpired,
    Effect.tap((deleted) =>
      Effect.log(`Cache cleanup complete: ${deleted} expired entries removed`)
    ),
    Effect.catchTag("CacheError", (e) =>
      Effect.logError(`Cache cleanup failed: ${e.message}`)
    ),
    Effect.provide(bindingsLayer)
  );

  ctx.waitUntil(Effect.runPromise(program));
}

// =============================================================================
// Worker Export
// =============================================================================

/**
 * Export the Cloudflare Worker handlers.
 *
 * Cloudflare Workers expect a default export with handler methods:
 * - fetch: HTTP request handler
 * - scheduled: Cron trigger handler
 *
 * The env parameter contains all bindings defined in wrangler.toml:
 * - DB: D1Database for caching
 * - RATE_LIMITER: RateLimit for rate limiting
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    return handleScheduled(event, env, ctx);
  },
};
