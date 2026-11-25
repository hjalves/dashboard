"use strict";
/* IPMA weather type (https://api.ipma.pt/open-data/weather-type-classe.json) → Meteocons monochrome
   icon (MIT, static/icons/). "{dn}" becomes "day" or "night". A hand-made table on purpose: IPMA's
   own icons are colourful and skeuomorphic; the user chose a flat Metro set (2026-11-25).
   Unknown types and "no information" (0, -99) get no icon: the description text is still shown. */
const WEATHER_ICONS = {
  1: "clear-{dn}",                    // Clear sky
  2: "partly-cloudy-{dn}",            // Partly cloudy (pouco nublado)
  3: "overcast-{dn}",                 // Sunny intervals (parcialmente nublado)
  4: "cloudy",                        // Cloudy (muito nublado ou encoberto)
  5: "cloudy",                        // Cloudy (high cloud)
  6: "partly-cloudy-{dn}-rain",       // Showers/rain
  7: "partly-cloudy-{dn}-drizzle",    // Light showers/rain
  8: "overcast-{dn}-rain",            // Heavy showers/rain
  9: "rain",                          // Rain/showers
  10: "drizzle",                      // Light rain
  11: "rain",                         // Heavy rain/showers
  12: "overcast-{dn}-rain",           // Intermittent rain
  13: "overcast-{dn}-drizzle",        // Intermittent light rain
  14: "rain",                         // Intermittent heavy rain
  15: "drizzle",                      // Drizzle
  16: "mist",                         // Mist
  17: "fog",                          // Fog
  18: "snow",                         // Snow
  19: "thunderstorms-{dn}",           // Thunderstorms
  20: "thunderstorms-{dn}-rain",      // Showers and thunderstorms
  21: "hail",                         // Hail
  22: "snowflake",                    // Frost
  23: "thunderstorms-rain",           // Rain and thunderstorms
  24: "cloudy",                       // Convective clouds
  25: "partly-cloudy-{dn}",           // Partly cloudy
  26: "fog-{dn}",                     // Fog
  27: "cloudy",                       // Cloudy
  28: "partly-cloudy-{dn}-snow",      // Snow showers
  29: "sleet",                        // Rain and snow
  30: "sleet",                        // Rain and snow
};

/* MET Norway symbol code (without _day/_night; names from github.com/metno/weathericons
   legend.csv, typos included as the API sends them) → Meteocons monochrome icon. */
const METNO_ICONS = {
  clearsky: "clear-{dn}",
  fair: "partly-cloudy-{dn}",
  partlycloudy: "overcast-{dn}",
  cloudy: "cloudy",
  fog: "fog",
  lightrainshowers: "partly-cloudy-{dn}-drizzle",
  rainshowers: "partly-cloudy-{dn}-rain",
  heavyrainshowers: "overcast-{dn}-rain",
  lightrainshowersandthunder: "thunderstorms-{dn}-rain",
  rainshowersandthunder: "thunderstorms-{dn}-rain",
  heavyrainshowersandthunder: "thunderstorms-{dn}-rain",
  lightsleetshowers: "partly-cloudy-{dn}-sleet",
  sleetshowers: "partly-cloudy-{dn}-sleet",
  heavysleetshowers: "partly-cloudy-{dn}-sleet",
  lightssleetshowersandthunder: "thunderstorms-{dn}-sleet",
  sleetshowersandthunder: "thunderstorms-{dn}-sleet",
  heavysleetshowersandthunder: "thunderstorms-{dn}-sleet",
  lightsnowshowers: "partly-cloudy-{dn}-snow",
  snowshowers: "partly-cloudy-{dn}-snow",
  heavysnowshowers: "partly-cloudy-{dn}-snow",
  lightssnowshowersandthunder: "thunderstorms-{dn}-snow",
  snowshowersandthunder: "thunderstorms-{dn}-snow",
  heavysnowshowersandthunder: "thunderstorms-{dn}-snow",
  lightrain: "drizzle",
  rain: "rain",
  heavyrain: "rain",
  lightrainandthunder: "thunderstorms-rain",
  rainandthunder: "thunderstorms-rain",
  heavyrainandthunder: "thunderstorms-rain",
  lightsleet: "sleet",
  sleet: "sleet",
  heavysleet: "sleet",
  lightsleetandthunder: "thunderstorms-sleet",
  sleetandthunder: "thunderstorms-sleet",
  heavysleetandthunder: "thunderstorms-sleet",
  lightsnow: "snow",
  snow: "snow",
  heavysnow: "snow",
  lightsnowandthunder: "thunderstorms-snow",
  snowandthunder: "thunderstorms-snow",
  heavysnowandthunder: "thunderstorms-snow",
};

/* HTML for an icon tinted with the current text colour, or "" when there's none.
   `type` is a MET Norway symbol (string) or an IPMA weather type (number). */
function weatherIcon(type, day, cls) {
  const name = typeof type === "string" ? METNO_ICONS[type] : WEATHER_ICONS[type];
  if (!name) return "";
  const file = name.replace("{dn}", day === false ? "night" : "day");
  return `<i class="wi ${cls || ""}" style="--icon:url(/static/icons/${file}.svg)"></i>`;
}
