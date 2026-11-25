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

/* HTML for an icon tinted with the current text colour, or "" when there's none for this type. */
function weatherIcon(type, day, cls) {
  const name = WEATHER_ICONS[type];
  if (!name) return "";
  const file = name.replace("{dn}", day === false ? "night" : "day");
  return `<i class="wi ${cls || ""}" style="--icon:url(/static/icons/${file}.svg)"></i>`;
}
