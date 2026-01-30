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
  "source": "local"
}
```

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

## Data Sources

- **Denmark**: Postal code boundaries from [Data-Science.dk](https://data-science.dk/) (WGS84 GeoJSON)
- **Worldwide**: [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) with polygon caching
