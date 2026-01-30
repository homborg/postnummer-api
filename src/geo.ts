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

function pointInPolygon(
  point: [number, number],
  polygon: number[][]
): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInMultiPolygon(
  point: [number, number],
  coordinates: number[][][] | number[][][][],
  isMulti: boolean
): boolean {
  if (isMulti) {
    for (const polygon of coordinates as number[][][][]) {
      if (pointInPolygon(point, polygon[0])) {
        return true;
      }
    }
    return false;
  } else {
    return pointInPolygon(point, (coordinates as number[][][])[0]);
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
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
): boolean {
  const point: [number, number] = [lng, lat];
  const isMulti = geometry.type === "MultiPolygon";
  return pointInMultiPolygon(point, geometry.coordinates, isMulti);
}
