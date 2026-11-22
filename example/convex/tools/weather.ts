// See the docs at https://docs.convex.dev/agents/tools
import { tool } from "ai";
import { z } from "zod/v3";

export const getGeocoding = tool({
  description: "Get the latitude and longitude of a location",
  inputSchema: z.object({
    location: z
      .string()
      .describe("The location to get the geocoding for, e.g. 'San Francisco'"),
  }),
  execute: async ({ location }) => {
    console.log("getting geocoding for location", location);
    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = (await geocodingResponse.json()) as {
      results: {
        latitude: number;
        longitude: number;
        name: string;
      }[];
      error?: boolean;
      reason?: string;
    };
    if (!geocodingResponse.ok || geocodingData.error) {
      throw new Error(
        `Geocoding request failed: ${geocodingData.reason ?? geocodingResponse.status}`,
      );
    }

    if (!geocodingData.results?.[0]) {
      throw new Error(`Location '${location}' not found`);
    }

    const { latitude, longitude, name } = geocodingData.results[0];
    console.log("got geocoding for location", name, latitude, longitude);
    return { latitude, longitude, name };
  },
});

export const getWeather = tool({
  description: "Get the weather for a location",
  inputSchema: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  execute: async (args) => {
    console.log("getting weather for location", args);
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit`;

    const response = await fetch(weatherUrl);
    const data = (await response.json()) as {
      current: {
        time: string;
        temperature_2m: number;
        apparent_temperature: number;
        wind_speed_10m: number;
        wind_gusts_10m: number;
        weather_code: number;
      };
      error?: boolean;
      reason?: string;
    };
    console.log("got weather for location", data);
    if (!response.ok || data.error) {
      throw new Error(
        `Weather request failed: ${data.reason ?? response.status}`,
      );
    }
    return {
      temperature: `${data.current.temperature_2m}°F`,
      feelsLike: `${data.current.apparent_temperature}°F`,
      windSpeed: `${data.current.wind_speed_10m} mph`,
      windGust: `${data.current.wind_gusts_10m} mph`,
      description: nameOfWeatherCode(data.current.weather_code),
    };
  },
});

/**
 * Weather from https://open-meteo.com/en/docs?hourly=temperature_2m,weather_code
 * @param code WMO code
 * @returns text description of the weather
 */
function nameOfWeatherCode(code: number) {
  switch (code) {
    case 0:
      return "Clear";
    case 1:
      return "Mainly clear";
    case 2:
      return "Partly cloudy";
    case 3:
      return "Overcast";
    case 45:
      return "Fog and depositing rime fog";
    case 48:
      return "Fog and depositing rime fog";
    case 51:
      return "Drizzle: Light";
    case 53:
      return "Drizzle: Moderate";
    case 55:
      return "Drizzle: Dense intensity";
    case 56:
      return "Freezing Drizzle: Light and dense intensity";
    case 57:
      return "Freezing Drizzle: Dense intensity";
    case 61:
      return "Light Rain";
    case 63:
      return "Moderate Rain";
    case 65:
      return "Heavy Rain";
    case 66:
      return "Light Freezing Rain";
    case 67:
      return "Heavy Freezing Rain";
    case 71:
      return "Lightly Snow";
    case 73:
      return "Snowing";
    case 75:
      return "Snowing heavily";
    case 77:
      return "Snow grains";
    case 80:
      return "Rain showers: Slight";
    case 81:
      return "Rain showers: Moderate";
    case 82:
      return "Rain showers: Violent";
    case 85:
      return "Snow showers: Slight";
    case 86:
      return "Snow showers: Heavy";
    case 95:
      return "Thunderstorm";
    case 96:
      return "Thunderstorm with light hail";
    case 99:
      return "Thunderstorm with heavy hail";
    default:
      return "Unknown";
  }
}
