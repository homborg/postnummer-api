export interface PostalCode {
  postnummer: string;
  navn: string;
}

export interface Feature {
  type: "Feature";
  properties: {
    postnummer: string;
    navn: string;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

type Polygon = readonly (readonly number[])[];
type MultiPolygon = readonly Polygon[];
type Coordinates = readonly (readonly (readonly number[])[])[] | readonly MultiPolygon[];

function pointInPolygon(
  point: [number, number],
  polygon: Polygon
): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (!pi || !pj) continue;
    const xi = pi[0];
    const yi = pi[1];
    const xj = pj[0];
    const yj = pj[1];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInMultiPolygon(
  point: [number, number],
  coordinates: Coordinates,
  isMulti: boolean
): boolean {
  if (isMulti) {
    for (const polygon of coordinates as readonly MultiPolygon[]) {
      const ring = polygon[0];
      if (ring && pointInPolygon(point, ring)) {
        return true;
      }
    }
    return false;
  } else {
    const ring = (coordinates as readonly Polygon[])[0];
    return ring ? pointInPolygon(point, ring) : false;
  }
}

export function findPostalCode(
  lat: number,
  lng: number,
  geojson: FeatureCollection
): PostalCode | null {
  const point: [number, number] = [lng, lat];

  for (const feature of geojson.features) {
    const isMulti = feature.geometry.type === "MultiPolygon";
    if (pointInMultiPolygon(point, feature.geometry.coordinates, isMulti)) {
      return {
        postnummer: feature.properties.postnummer,
        navn: feature.properties.navn,
      };
    }
  }

  return null;
}

export function pointInGeometry(
  lat: number,
  lng: number,
  geometry: { type: string; coordinates: Coordinates }
): boolean {
  const point: [number, number] = [lng, lat];
  const isMulti = geometry.type === "MultiPolygon";
  return pointInMultiPolygon(point, geometry.coordinates, isMulti);
}

export function findPolygonByPostalCode(
  postalCode: string,
  geojson: FeatureCollection
): Feature["geometry"] | null {
  for (const feature of geojson.features) {
    if (feature.properties.postnummer === postalCode) {
      return feature.geometry;
    }
  }
  return null;
}
