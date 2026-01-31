/**
 * Effect OpenTelemetry Tracer for Cloudflare Workers
 *
 * Configures Effect spans to export via OpenTelemetry.
 * Uses SimpleSpanProcessor (not BatchSpanProcessor) for Workers compatibility.
 *
 * ConsoleSpanExporter outputs to console.log which Cloudflare captures
 * in the observability dashboard when traces are enabled.
 */

import { NodeSdk } from "@effect/opentelemetry";
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";

/**
 * Tracer layer for Effect OpenTelemetry integration.
 *
 * Provides tracing capabilities to all Effect.withSpan() calls in the application.
 * Spans are exported via ConsoleSpanExporter to Cloudflare's logging system.
 */
export const TracerLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: "postnummer-api",
  },
  spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
}));
