export interface MapUrls {
  google: string;
  osm: string;
}

export interface PostalCodeResult {
  postalCode: string;
  city: string;
  country: string;
  source: "local" | "cache" | "nominatim";
  mapUrl: MapUrls;
}

export interface PostalCodeResponse extends PostalCodeResult {
  coordinatesUrl: MapUrls;
}

export function buildMapUrl(postalCode: string, city: string, country: string): MapUrls {
  const query = encodeURIComponent(`${postalCode} ${city} ${country}`);
  return {
    google: `https://www.google.com/maps/search/${query}`,
    osm: `https://www.openstreetmap.org/search?query=${query}`,
  };
}

export function buildCoordinatesUrl(lat: number, lng: number): MapUrls {
  return {
    google: `https://www.google.com/maps?q=${lat},${lng}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`,
  };
}

export interface CachedPostalCode {
  id: number;
  country_code: string;
  postal_code: string;
  city: string;
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
  geometry: string;
  expires_at: number;
}

export interface NominatimResponse {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  address: {
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    country?: string;
    country_code?: string;
  };
  geojson?: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface Env {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
}
