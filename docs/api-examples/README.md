# API Response Examples

Sample responses from the Nominatim reverse geocoding API for reference, testing, and documentation.

## Files

| File | Location | Description |
|------|----------|-------------|
| `nominatim-copenhagen-dk.json` | 55.6761, 12.5683 | Copenhagen, Denmark (has polygon) |
| `nominatim-berlin-de.json` | 52.5200, 13.4050 | Berlin, Germany |
| `nominatim-newyork-us.json` | 40.7128, -74.0060 | New York City, USA |
| `nominatim-ocean-null-island.json` | 0, 0 | Null Island (ocean, no result) |

## API Endpoint

```
GET https://nominatim.openstreetmap.org/reverse
  ?format=jsonv2
  &lat={latitude}
  &lon={longitude}
  &addressdetails=1
  &polygon_geojson=1
```

## Usage

These examples can be used to:
- Validate Effect Schema definitions against real API responses
- Write unit tests without hitting the live API
- Document expected response structure
- Debug parsing issues

## Fetched

2026-01-30
