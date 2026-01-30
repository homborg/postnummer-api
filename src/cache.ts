import { CachedPostalCode, PostalCodeResult, buildMapUrl } from "./types";
import { pointInGeometry } from "./geo";

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function findInCache(
  db: D1Database,
  lat: number,
  lng: number
): Promise<PostalCodeResult | null> {
  const now = Math.floor(Date.now() / 1000);

  // Query by bounding box
  const candidates = await db
    .prepare(
      `SELECT * FROM postal_cache 
       WHERE min_lat <= ? AND max_lat >= ? 
         AND min_lng <= ? AND max_lng >= ?
         AND expires_at > ?`
    )
    .bind(lat, lat, lng, lng, now)
    .all<CachedPostalCode>();

  if (!candidates.results?.length) {
    return null;
  }

  // Check point-in-polygon for each candidate
  for (const cached of candidates.results) {
    const geometry = JSON.parse(cached.geometry);
    if (pointInGeometry(lat, lng, geometry)) {
      return {
        postalCode: cached.postal_code,
        city: cached.city,
        country: cached.country_code,
        source: "cache",
        mapUrl: buildMapUrl(cached.postal_code, cached.city, cached.country_code),
      };
    }
  }

  return null;
}

export async function saveToCache(
  db: D1Database,
  result: PostalCodeResult,
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
): Promise<void> {
  const bbox = computeBoundingBox(geometry.coordinates, geometry.type === "MultiPolygon");
  const expiresAt = Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS;

  await db
    .prepare(
      `INSERT OR REPLACE INTO postal_cache 
       (country_code, postal_code, city, min_lat, max_lat, min_lng, max_lng, geometry, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      result.country,
      result.postalCode,
      result.city,
      bbox.minLat,
      bbox.maxLat,
      bbox.minLng,
      bbox.maxLng,
      JSON.stringify(geometry),
      expiresAt
    )
    .run();
}

export async function cleanupExpired(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare("DELETE FROM postal_cache WHERE expires_at <= ?")
    .bind(now)
    .run();
  return result.meta.changes ?? 0;
}

function computeBoundingBox(
  coordinates: number[][][] | number[][][][],
  isMulti: boolean
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const processRing = (ring: number[][]) => {
    for (const coord of ring) {
      const lng = coord[0];
      const lat = coord[1];
      if (lng === undefined || lat === undefined) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
    }
  };

  if (isMulti) {
    for (const polygon of coordinates as number[][][][]) {
      const ring = polygon[0];
      if (ring) processRing(ring);
    }
  } else {
    const ring = (coordinates as number[][][])[0];
    if (ring) processRing(ring);
  }

  return { minLat, maxLat, minLng, maxLng };
}
