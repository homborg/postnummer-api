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
 *   - GET /cleanup - cache cleanup
 *   - GET /docs - Swagger UI (auto-generated)
 *
 * - HttpRouter (routes.ts): HTML pages
 *   - GET / - API documentation homepage
 *   - GET /map - Map visualization page
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
 *    API routes (/lookup, /polygon, /cleanup, /docs) go to HttpApi.
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
  HttpServer.layerContext
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
// Request Handler
// =============================================================================

/**
 * Handle an incoming HTTP request.
 *
 * Routing strategy:
 * 1. HTML routes (/, /map) → HttpRouter
 * 2. API routes (/lookup, /polygon, /cleanup, /docs) → HttpApi
 *
 * @param request - The incoming web Request from Cloudflare
 * @param env - The Cloudflare Worker environment bindings
 * @returns Promise<Response> - The web Response to send back
 */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const bindingsLayer = makeCloudflareBindingsLayer(env);

  // Try HTML routes first (faster for static pages)
  const htmlResponse = await handleHtmlRequest(request, bindingsLayer);
  if (htmlResponse) {
    return htmlResponse;
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
// Worker Export
// =============================================================================

/**
 * Export the Cloudflare Worker default fetch handler.
 *
 * Cloudflare Workers expect a default export with a fetch method:
 * ```typescript
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> { ... }
 * }
 * ```
 *
 * The env parameter contains all bindings defined in wrangler.toml:
 * - DB: D1Database for caching
 * - RATE_LIMITER: RateLimit for rate limiting
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
