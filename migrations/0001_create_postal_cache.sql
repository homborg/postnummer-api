-- Cached postal code polygons from Nominatim
CREATE TABLE IF NOT EXISTS postal_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  city TEXT NOT NULL,
  min_lat REAL NOT NULL,
  max_lat REAL NOT NULL,
  min_lng REAL NOT NULL,
  max_lng REAL NOT NULL,
  geometry TEXT NOT NULL, -- GeoJSON polygon
  expires_at INTEGER NOT NULL, -- Unix timestamp
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(country_code, postal_code)
);

-- Index for bounding box queries
CREATE INDEX IF NOT EXISTS idx_postal_cache_bbox 
  ON postal_cache(min_lat, max_lat, min_lng, max_lng);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_postal_cache_expires 
  ON postal_cache(expires_at);
