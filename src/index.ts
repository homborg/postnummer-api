import { Hono } from "hono";
import { cors } from "hono/cors";
import { findPostalCode } from "./geo";
import geojson from "./postnumre";
import { findInCache, saveToCache, cleanupExpired } from "./cache";
import { reverseGeocode } from "./nominatim";
import { Env, PostalCodeResponse, buildMapUrl, buildCoordinatesUrl } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

import indexHtml from "./index.html";

app.get("/", (c) => {
  return c.html(indexHtml);
});

app.get("/lookup", async (c) => {
  const latParam = c.req.query("lat");
  const lngParam = c.req.query("lng");

  if (!latParam || !lngParam) {
    return c.json({ error: "Missing lat or lng parameter" }, 400);
  }

  const lat = parseFloat(latParam);
  const lng = parseFloat(lngParam);

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "Invalid lat or lng value" }, 400);
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json({ error: "Coordinates out of range" }, 400);
  }

  // 1. Try Denmark local data first (fast, accurate)
  const isDenmark = lat >= 54.5 && lat <= 58 && lng >= 8 && lng <= 15.5;
  if (isDenmark) {
    const dkResult = findPostalCode(lat, lng, geojson);
    if (dkResult) {
      const result: PostalCodeResponse = {
        postalCode: dkResult.postnummer,
        city: dkResult.navn,
        country: "Denmark",
        source: "local",
        mapUrl: buildMapUrl(dkResult.postnummer, dkResult.navn, "Denmark"),
        coordinatesUrl: buildCoordinatesUrl(lat, lng),
      };
      return c.json(result);
    }
  }

  const coordinatesUrl = buildCoordinatesUrl(lat, lng);

  // 2. Try D1 cache
  const cached = await findInCache(c.env.DB, lat, lng);
  if (cached) {
    return c.json({ ...cached, coordinatesUrl });
  }

  // 3. Fall back to Nominatim
  const nominatimResult = await reverseGeocode(lat, lng);
  if (!nominatimResult) {
    return c.json({ error: "No postal code found for coordinates" }, 404);
  }

  // Cache the result if we have geometry
  if (nominatimResult.geometry) {
    try {
      await saveToCache(
        c.env.DB,
        nominatimResult.result,
        nominatimResult.geometry as { type: string; coordinates: number[][][] | number[][][][] }
      );
    } catch {
      // Caching failure shouldn't break the response
    }
  }

  return c.json({ ...nominatimResult.result, coordinatesUrl });
});

// Cleanup endpoint (can be called by cron trigger)
app.get("/cleanup", async (c) => {
  const deleted = await cleanupExpired(c.env.DB);
  return c.json({ deleted });
});

export default app;
