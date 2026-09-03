import type { CityMeta } from "./types";

export const CITIES: CityMeta[] = [
  { id: "hong-kong", name: "Hong Kong", aliases: ["hk"], lat: 22.3193, lon: 114.1694, tz: "Asia/Hong_Kong", icao: "VHHH", country: "HK" },
  { id: "seoul", name: "Seoul (Incheon)", aliases: ["seoul", "incheon"], lat: 37.4602, lon: 126.4407, tz: "Asia/Seoul", icao: "RKSI", country: "KR" },
  { id: "tokyo", name: "Tokyo", aliases: [], lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo", icao: "RJTT", country: "JP" },
  { id: "wuhan", name: "Wuhan", aliases: [], lat: 30.5928, lon: 114.3055, tz: "Asia/Shanghai", icao: "ZHHH", country: "CN" },
  { id: "shanghai", name: "Shanghai", aliases: [], lat: 31.2304, lon: 121.4737, tz: "Asia/Shanghai", icao: "ZSPD", country: "CN" },
  { id: "wellington", name: "Wellington", aliases: [], lat: -41.2865, lon: 174.7762, tz: "Pacific/Auckland", icao: "NZWN", country: "NZ" },
  { id: "beijing", name: "Beijing", aliases: [], lat: 39.9042, lon: 116.4074, tz: "Asia/Shanghai", icao: "ZBAA", country: "CN" },
  { id: "guangzhou", name: "Guangzhou", aliases: [], lat: 23.1291, lon: 113.2644, tz: "Asia/Shanghai", icao: "ZGGG", country: "CN" },
  { id: "shenzhen", name: "Shenzhen", aliases: [], lat: 22.5431, lon: 114.0579, tz: "Asia/Shanghai", icao: "ZGSZ", country: "CN" },
  { id: "singapore", name: "Singapore", aliases: [], lat: 1.3521, lon: 103.8198, tz: "Asia/Singapore", icao: "WSSS", country: "SG" },
  { id: "chengdu", name: "Chengdu", aliases: [], lat: 30.5728, lon: 104.0668, tz: "Asia/Shanghai", icao: "ZUUU", country: "CN" },
  { id: "sao-paulo", name: "Sao Paulo", aliases: ["são paulo", "sao paulo"], lat: -23.5505, lon: -46.6333, tz: "America/Sao_Paulo", icao: "SBSP", country: "BR" },
  { id: "milan", name: "Milan", aliases: ["milano"], lat: 45.4642, lon: 9.19, tz: "Europe/Rome", icao: "LIMC", country: "IT" },
  { id: "london", name: "London", aliases: [], lat: 51.5074, lon: -0.1278, tz: "Europe/London", icao: "EGLL", country: "GB" },
  { id: "qingdao", name: "Qingdao", aliases: [], lat: 36.0671, lon: 120.3826, tz: "Asia/Shanghai", icao: "ZSQD", country: "CN" },
  { id: "manila", name: "Manila", aliases: [], lat: 14.5995, lon: 120.9842, tz: "Asia/Manila", icao: "RPLL", country: "PH" },
  { id: "los-angeles", name: "Los Angeles", aliases: ["la"], lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles", icao: "KLAX", country: "US" },
  { id: "taipei", name: "Taipei", aliases: [], lat: 25.033, lon: 121.5654, tz: "Asia/Taipei", icao: "RCTP", country: "TW" },
  { id: "seattle", name: "Seattle", aliases: [], lat: 47.6062, lon: -122.3321, tz: "America/Los_Angeles", icao: "KSEA", country: "US" },
  { id: "san-francisco", name: "San Francisco", aliases: ["sf"], lat: 37.7749, lon: -122.4194, tz: "America/Los_Angeles", icao: "KSFO", country: "US" },
  { id: "denver", name: "Denver", aliases: [], lat: 39.7392, lon: -104.9903, tz: "America/Denver", icao: "KDEN", country: "US" },
  { id: "toronto", name: "Toronto", aliases: [], lat: 43.6532, lon: -79.3832, tz: "America/Toronto", icao: "CYYZ", country: "CA" },
  { id: "amsterdam", name: "Amsterdam", aliases: [], lat: 52.3676, lon: 4.9041, tz: "Europe/Amsterdam", icao: "EHAM", country: "NL" },
  { id: "munich", name: "Munich", aliases: ["munchen", "münchen"], lat: 48.1351, lon: 11.582, tz: "Europe/Berlin", icao: "EDDM", country: "DE" },
  { id: "paris", name: "Paris", aliases: [], lat: 48.8566, lon: 2.3522, tz: "Europe/Paris", icao: "LFPG", country: "FR" },
  { id: "warsaw", name: "Warsaw", aliases: ["warszawa"], lat: 52.2297, lon: 21.0122, tz: "Europe/Warsaw", icao: "EPWA", country: "PL" },
  { id: "nyc", name: "New York City", aliases: ["nyc", "new york", "new york city"], lat: 40.7829, lon: -73.9654, tz: "America/New_York", icao: "KNYC", country: "US" },
  { id: "miami", name: "Miami", aliases: [], lat: 25.7617, lon: -80.1918, tz: "America/New_York", icao: "KMIA", country: "US" },
  { id: "lucknow", name: "Lucknow", aliases: [], lat: 26.8467, lon: 80.9462, tz: "Asia/Kolkata", icao: "VILK", country: "IN" },
  { id: "busan", name: "Busan", aliases: ["pusan"], lat: 35.1796, lon: 129.0756, tz: "Asia/Seoul", icao: "RKPK", country: "KR" },
  { id: "chongqing", name: "Chongqing", aliases: [], lat: 29.4316, lon: 106.9123, tz: "Asia/Shanghai", icao: "ZUCK", country: "CN" },
  { id: "kuala-lumpur", name: "Kuala Lumpur", aliases: ["kl"], lat: 3.139, lon: 101.6869, tz: "Asia/Kuala_Lumpur", icao: "WMKK", country: "MY" },
  { id: "tel-aviv", name: "Tel Aviv", aliases: ["tel aviv"], lat: 32.0853, lon: 34.7818, tz: "Asia/Jerusalem", icao: "LLBG", country: "IL" },
  { id: "madrid", name: "Madrid", aliases: [], lat: 40.4168, lon: -3.7038, tz: "Europe/Madrid", icao: "LEMD", country: "ES" },
  { id: "cape-town", name: "Cape Town", aliases: [], lat: -33.9249, lon: 18.4241, tz: "Africa/Johannesburg", icao: "FACT", country: "ZA" },
  { id: "karachi", name: "Karachi", aliases: [], lat: 24.8607, lon: 67.0011, tz: "Asia/Karachi", icao: "OPKC", country: "PK" },
  { id: "moscow", name: "Moscow", aliases: [], lat: 55.7558, lon: 37.6173, tz: "Europe/Moscow", icao: "UUEE", country: "RU" },
  { id: "dallas", name: "Dallas", aliases: [], lat: 32.7767, lon: -96.797, tz: "America/Chicago", icao: "KDFW", country: "US" },
  { id: "houston", name: "Houston", aliases: [], lat: 29.7604, lon: -95.3698, tz: "America/Chicago", icao: "KIAH", country: "US" },
  { id: "istanbul", name: "Istanbul", aliases: [], lat: 41.0082, lon: 28.9784, tz: "Europe/Istanbul", icao: "LTFM", country: "TR" },
  { id: "helsinki", name: "Helsinki", aliases: [], lat: 60.1699, lon: 24.9384, tz: "Europe/Helsinki", icao: "EFHK", country: "FI" },
  { id: "ankara", name: "Ankara", aliases: [], lat: 39.9334, lon: 32.8597, tz: "Europe/Istanbul", icao: "LTAC", country: "TR" },
  { id: "atlanta", name: "Atlanta", aliases: [], lat: 33.749, lon: -84.388, tz: "America/New_York", icao: "KATL", country: "US" },
  { id: "chicago", name: "Chicago", aliases: [], lat: 41.8781, lon: -87.6298, tz: "America/Chicago", icao: "KORD", country: "US" },
  { id: "jeddah", name: "Jeddah", aliases: [], lat: 21.4858, lon: 39.1925, tz: "Asia/Riyadh", icao: "OEJN", country: "SA" },
  { id: "austin", name: "Austin", aliases: [], lat: 30.2672, lon: -97.7431, tz: "America/Chicago", icao: "KAUS", country: "US" },
  { id: "boston", name: "Boston", aliases: [], lat: 42.3601, lon: -71.0589, tz: "America/New_York", icao: "KBOS", country: "US" },
  { id: "phoenix", name: "Phoenix", aliases: [], lat: 33.4484, lon: -112.074, tz: "America/Phoenix", icao: "KPHX", country: "US" },
  { id: "mexico-city", name: "Mexico City", aliases: ["mexico city", "cdmx"], lat: 19.4326, lon: -99.1332, tz: "America/Mexico_City", icao: "MMMX", country: "MX" },
  { id: "dubai", name: "Dubai", aliases: [], lat: 25.2048, lon: 55.2708, tz: "Asia/Dubai", icao: "OMDB", country: "AE" },
  { id: "sydney", name: "Sydney", aliases: [], lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney", icao: "YSSY", country: "AU" },
  { id: "melbourne", name: "Melbourne", aliases: [], lat: -37.8136, lon: 144.9631, tz: "Australia/Melbourne", icao: "YMML", country: "AU" },
  { id: "berlin", name: "Berlin", aliases: [], lat: 52.52, lon: 13.405, tz: "Europe/Berlin", icao: "EDDB", country: "DE" },
  { id: "rome", name: "Rome", aliases: ["roma"], lat: 41.9028, lon: 12.4964, tz: "Europe/Rome", icao: "LIRF", country: "IT" },
  { id: "vienna", name: "Vienna", aliases: ["wien"], lat: 48.2082, lon: 16.3738, tz: "Europe/Vienna", icao: "LOWW", country: "AT" },
  { id: "bangkok", name: "Bangkok", aliases: [], lat: 13.7563, lon: 100.5018, tz: "Asia/Bangkok", icao: "VTBS", country: "TH" },
];

const byAlias = new Map<string, CityMeta>();
for (const city of CITIES) {
  byAlias.set(norm(city.name), city);
  byAlias.set(norm(city.id), city);
  for (const alias of city.aliases) byAlias.set(norm(alias), city);
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveCity(raw: string): CityMeta | null {
  const key = norm(raw);
  const hit = byAlias.get(key);
  if (hit) return hit;
  for (const city of CITIES) {
    if (key.includes(norm(city.name)) || norm(city.name).includes(key)) return city;
    if (city.aliases.some((a) => key.includes(norm(a)))) return city;
  }
  return null;
}

export function unknownCity(raw: string): CityMeta {
  const id = norm(raw).replace(/\s+/g, "-") || "unknown";
  return {
    id,
    name: raw.trim(),
    aliases: [],
    lat: 0,
    lon: 0,
    tz: "UTC",
    icao: "",
    country: "",
  };
}
