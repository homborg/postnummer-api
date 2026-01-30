import { NominatimResponse, PostalCodeResult, buildMapUrl } from "./types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "PostalCodeAPI/1.0 (https://github.com/example/postnummer-api)";

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ result: PostalCodeResult; geometry?: object } | null> {
  const url = new URL("/reverse", NOMINATIM_BASE);
  url.searchParams.set("lat", lat.toString());
  url.searchParams.set("lon", lng.toString());
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("polygon_geojson", "1");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as NominatimResponse;

  if (!data.address?.postcode) {
    return null;
  }

  const city =
    data.address.city ||
    data.address.town ||
    data.address.village ||
    data.address.municipality ||
    "";

  const country = data.address.country || "";

  return {
    result: {
      postalCode: data.address.postcode,
      city,
      country,
      source: "nominatim",
      mapUrl: buildMapUrl(data.address.postcode, city, country),
    },
    geometry: data.geojson,
  };
}
