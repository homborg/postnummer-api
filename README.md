# Postal Code Lookup API

Lookup postal codes from geographical coordinates worldwide. Deployed on Cloudflare Workers.

- **Denmark**: Fast local lookup using embedded GeoJSON polygons
- **Other countries**: Nominatim reverse geocoding with D1 polygon caching

## Usage

```
GET /lookup?lat=55.676098&lng=12.568337
```

Response:
```json
{
  "postalCode": "1550",
  "city": "København V",
  "country": "Denmark",
  "source": "local",
  "mapUrl": { "google": "...", "osm": "..." },
  "coordinatesUrl": { "google": "...", "osm": "..." }
}
```

Response headers:
- `X-Cache: HIT` or `MISS` (HIT for local/cache, MISS for nominatim)
- `X-Cache-Source: local | cache | nominatim`

### Source values
- `local` - Denmark polygons (embedded data)
- `cache` - Cached polygon from previous Nominatim lookup
- `nominatim` - Fresh lookup from OpenStreetMap Nominatim

## Setup

### 1. Create D1 database

```bash
wrangler d1 create postal-cache
```

Update `wrangler.toml` with the returned database ID.

### 2. Run migrations

```bash
wrangler d1 migrations apply postal-cache --local   # for dev
wrangler d1 migrations apply postal-cache --remote  # for production
```

## Development

```bash
pnpm install
pnpm dev
```

## Deploy

```bash
pnpm deploy
```

## Rate Limiting

The `/lookup` endpoint is rate limited to **60 requests per minute per IP** using Cloudflare's native [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Exceeding the limit returns HTTP 429.

## Data Sources

- **Denmark**: Postal code boundaries from [Data-Science.dk](https://data-science.dk/) (WGS84 GeoJSON)
- **Worldwide**: [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) with polygon caching

## Architecture

Built with [Effect](https://effect.website/) and [@effect/platform](https://github.com/Effect-TS/effect/tree/main/packages/platform) for type-safe, functional HTTP handling.

### Effect Modules

```
src/effect/
├── index.ts      # Worker entry point (toWebHandler)
├── routes.ts     # HttpRouter with all endpoints
├── bindings.ts   # CloudflareBindings Context.Tag & Layer
├── cache.ts      # D1 cache operations (Effect-wrapped)
├── nominatim.ts  # Nominatim HTTP client (Effect-wrapped)
├── geo.ts        # Point-in-polygon functions (Effect-wrapped)
├── schemas.ts    # Effect Schema definitions
└── errors.ts     # Tagged errors (Data.TaggedError)
```

### Key Patterns

- **Context.Tag** for dependency injection (CloudflareBindings)
- **Layer** for providing services at request time
- **Effect.gen** for async pipelines with typed errors
- **Schema** for request/response validation
- **Option** for nullable results, **TaggedError** for failures
