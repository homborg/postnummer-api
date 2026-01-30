/**
 * Effect Entry Point for Cloudflare Workers
 *
 * This module exports the main fetch handler for the Postnummer API,
 * wiring up the Effect HTTP router with Cloudflare Worker bindings.
 *
 * Key Effect Patterns for Cloudflare Workers:
 *
 * 1. Request-time Layer construction
 *    Cloudflare Workers receive `env` (bindings) with each request.
 *    We construct the Layer at request time and provide it to the Effect:
 *
 *    ```typescript
 *    async fetch(request: Request, env: Env): Promise<Response> {
 *      const layer = makeCloudflareBindingsLayer(env);
 *      return Effect.runPromise(
 *        program.pipe(Effect.provide(layer))
 *      );
 *    }
 *    ```
 *
 * 2. HttpRouter.toHttpApp - Converting router to an HttpApp
 *    The router is an HttpRouter<E, R>. We need to convert it to an
 *    HttpApp (Effect<HttpServerResponse, E, R>) to run it:
 *
 *    ```typescript
 *    const httpApp = HttpRouter.toHttpApp(router);
 *    ```
 *
 * 3. HttpServerResponse.toWeb - Converting to web Response
 *    Effect's HttpServerResponse can be converted to a web Response:
 *
 *    ```typescript
 *    const webResponse = HttpServerResponse.toWeb(effectResponse);
 *    ```
 *
 * 4. Effect.provide - Supplying dependencies
 *    Effect.provide(layer) removes the dependency from the Effect's R type,
 *    allowing us to run the Effect with Effect.runPromise.
 *
 * Why this approach?
 * - Cloudflare bindings come per-request in the env parameter
 * - We must construct and provide the Layer per-request
 * - This is clean and explicit about what happens at each step
 */

import { Effect, pipe } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";

import { router } from "./routes";
import { makeCloudflareBindingsLayer, type Env } from "./bindings";

// =============================================================================
// Convert Router to HttpApp
// =============================================================================

/**
 * Convert our router to an HttpApp.
 *
 * HttpRouter.toHttpApp returns an Effect that produces the HttpApp.
 * The HttpApp itself is Effect<HttpServerResponse, E, R | HttpServerRequest>.
 *
 * Since our router has all errors handled by catchAll, E = never.
 * R = CloudflareBindings (our router's dependencies).
 */
const httpApp = HttpRouter.toHttpApp(router);

// =============================================================================
// Request Handler
// =============================================================================

/**
 * Handle an incoming HTTP request using the Effect pipeline.
 *
 * This is the core function that:
 * 1. Constructs the CloudflareBindings Layer from the Worker's env
 * 2. Converts the web Request to an Effect HttpServerRequest
 * 3. Runs the HttpApp with the request and bindings provided
 * 4. Converts the HttpServerResponse to a web Response
 *
 * The pipeline:
 * - httpApp produces the HttpApp (Effect<Response, E, R | Request>)
 * - Effect.flatMap runs the app
 * - Effect.provideService injects the HttpServerRequest
 * - Effect.provide injects the CloudflareBindings Layer
 * - Effect.runPromise executes and returns Promise<HttpServerResponse>
 * - HttpServerResponse.toWeb converts to web Response
 *
 * @param request - The incoming web Request from Cloudflare
 * @param env - The Cloudflare Worker environment bindings
 * @returns Promise<Response> - The web Response to send back
 */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  // Step 1: Construct the Layer with Cloudflare bindings
  const bindingsLayer = makeCloudflareBindingsLayer(env);

  // Step 2: Build the program that:
  // - Gets the HttpApp from our router
  // - Runs it to get an HttpServerResponse
  const program = pipe(
    httpApp,
    Effect.flatMap((app) => app),
    // Provide the incoming request as an Effect service
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(request)
    ),
    // Provide the Cloudflare bindings Layer
    Effect.provide(bindingsLayer),
    // Handle Scope for resource cleanup
    Effect.scoped
  );

  // Step 3: Run the Effect to get HttpServerResponse
  const response = await Effect.runPromise(program);

  // Step 4: Convert HttpServerResponse to web Response
  // HttpServerResponse.toWeb handles all body types and streaming
  return HttpServerResponse.toWeb(response);
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
