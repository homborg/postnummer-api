/**
 * Effect HTTP Router - HTML Routes Only
 *
 * This module handles static HTML routes using @effect/platform's HttpRouter.
 * JSON API endpoints are handled by HttpApi in api.ts.
 *
 * Routes:
 * - GET / - API documentation homepage
 * - GET /map - Map visualization page
 */

import * as Effect from "effect/Effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";

import indexHtml from "../index.html";
import mapHtml from "../map.html";

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * GET / - Serve index.html
 *
 * Returns the API documentation homepage as static HTML.
 */
const indexHandler = Effect.succeed(HttpServerResponse.html(indexHtml)).pipe(
  Effect.withSpan("routes.index")
);

/**
 * GET /map - Serve map.html
 *
 * Returns the map visualization page as static HTML.
 */
const mapHandler = Effect.succeed(HttpServerResponse.html(mapHtml)).pipe(
  Effect.withSpan("routes.map")
);

// =============================================================================
// Router Definition
// =============================================================================

/**
 * HTML-only router for static pages.
 *
 * JSON API endpoints are handled separately by HttpApi (see api.ts).
 * This router only handles:
 * - / - API documentation homepage
 * - /map - Map visualization page
 */
export const htmlRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", indexHandler),
  HttpRouter.get("/map", mapHandler)
);

/**
 * Export the router type for use in the main entry point.
 */
export type HtmlRouter = typeof htmlRouter;
