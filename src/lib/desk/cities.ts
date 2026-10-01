import type { CityMeta } from "./types";

/**
 * lat/lon/icao are the Polymarket SETTLEMENT station (not the city centre), so
 * both forecast providers and METAR observations target the point that decides
 * the market. Taken from Gamma market descriptions (Oct 2026); coordinates from
 * aviationweather.gov stationinfo. settlementSource "unverified" = no recent
 * Polymarket market seen for that city, main airport assumed. Hong Kong settles
 * on the HK Observatory (no METAR), so icao is "" there and no METAR is used.
 */
export const CITIES: CityMeta[] = [
  { id: "hong-kong", name: "Hong Kong", aliases: ["hk"], lat: 22.3022, lon: 114.1742, tz: "Asia/Hong_Kong", icao: "", country: "HK", station: "Hong Kong Observatory (HKO HQ)", settlementSource: "hko" },
  { id: "seoul", name: "Seoul (Incheon)", aliases: ["seoul", "incheon"], lat: 37.469, lon: 126.451, tz: "Asia/Seoul", icao: "RKSI", country: "KR", station: "Incheon Intl", settlementSource: "noaa" },
  { id: "tokyo", name: "Tokyo", aliases: [], lat: 35.553, lon: 139.781, tz: "Asia/Tokyo", icao: "RJTT", country: "JP", station: "Tokyo Haneda", settlementSource: "noaa" },
  { id: "wuhan", name: "Wuhan", aliases: [], lat: 30.783, lon: 114.205, tz: "Asia/Shanghai", icao: "ZHHH", country: "CN", station: "Wuhan Tianhe Intl", settlementSource: "noaa" },
  { id: "shanghai", name: "Shanghai", aliases: [], lat: 31.146, lon: 121.8, tz: "Asia/Shanghai", icao: "ZSPD", country: "CN", station: "Shanghai Pudong Intl", settlementSource: "noaa" },
  { id: "wellington", name: "Wellington", aliases: [], lat: -41.331, lon: 174.806, tz: "Pacific/Auckland", icao: "NZWN", country: "NZ", station: "Wellington Intl", settlementSource: "noaa" },
  { id: "beijing", name: "Beijing", aliases: [], lat: 40.082, lon: 116.603, tz: "Asia/Shanghai", icao: "ZBAA", country: "CN", station: "Beijing Capital Intl", settlementSource: "noaa" },
  { id: "guangzhou", name: "Guangzhou", aliases: [], lat: 23.392, lon: 113.307, tz: "Asia/Shanghai", icao: "ZGGG", country: "CN", station: "Guangzhou Baiyun Intl", settlementSource: "noaa" },
  { id: "shenzhen", name: "Shenzhen", aliases: [], lat: 22.639, lon: 113.803, tz: "Asia/Shanghai", icao: "ZGSZ", country: "CN", station: "Shenzhen Bao'an Intl", settlementSource: "noaa" },
  { id: "singapore", name: "Singapore", aliases: [], lat: 1.368, lon: 103.982, tz: "Asia/Singapore", icao: "WSSS", country: "SG", station: "Singapore Changi", settlementSource: "noaa" },
  { id: "chengdu", name: "Chengdu", aliases: [], lat: 30.576, lon: 103.95, tz: "Asia/Shanghai", icao: "ZUUU", country: "CN", station: "Chengdu Shuangliu Intl", settlementSource: "noaa" },
  { id: "sao-paulo", name: "Sao Paulo", aliases: ["são paulo", "sao paulo"], lat: -23.432, lon: -46.469, tz: "America/Sao_Paulo", icao: "SBGR", country: "BR", station: "Sao Paulo-Guarulhos Intl", settlementSource: "noaa" },
  { id: "milan", name: "Milan", aliases: ["milano"], lat: 45.631, lon: 8.728, tz: "Europe/Rome", icao: "LIMC", country: "IT", station: "Milan Malpensa", settlementSource: "noaa" },
  { id: "london", name: "London", aliases: [], lat: 51.505, lon: 0.055, tz: "Europe/London", icao: "EGLC", country: "GB", station: "London City Airport", settlementSource: "noaa" },
  { id: "qingdao", name: "Qingdao", aliases: [], lat: 36.362, lon: 120.087, tz: "Asia/Shanghai", icao: "ZSQD", country: "CN", station: "Qingdao Jiaodong Intl", settlementSource: "noaa" },
  { id: "manila", name: "Manila", aliases: [], lat: 14.507, lon: 121.004, tz: "Asia/Manila", icao: "RPLL", country: "PH", station: "Ninoy Aquino Intl", settlementSource: "noaa" },
  { id: "los-angeles", name: "Los Angeles", aliases: ["la"], lat: 33.93817, lon: -118.3866, tz: "America/Los_Angeles", icao: "KLAX", country: "US", station: "Los Angeles Intl", settlementSource: "noaa" },
  { id: "taipei", name: "Taipei", aliases: [], lat: 25.069, lon: 121.552, tz: "Asia/Taipei", icao: "RCSS", country: "TW", station: "Taipei Songshan", settlementSource: "wunderground" },
  { id: "seattle", name: "Seattle", aliases: [], lat: 47.44467, lon: -122.31442, tz: "America/Los_Angeles", icao: "KSEA", country: "US", station: "Seattle-Tacoma Intl", settlementSource: "noaa" },
  { id: "san-francisco", name: "San Francisco", aliases: ["sf"], lat: 37.61961, lon: -122.36561, tz: "America/Los_Angeles", icao: "KSFO", country: "US", station: "San Francisco Intl", settlementSource: "noaa" },
  { id: "denver", name: "Denver", aliases: [], lat: 39.713, lon: -104.758, tz: "America/Denver", icao: "KBKF", country: "US", station: "Buckley Space Force Base", settlementSource: "noaa" },
  { id: "toronto", name: "Toronto", aliases: [], lat: 43.679, lon: -79.629, tz: "America/Toronto", icao: "CYYZ", country: "CA", station: "Toronto Pearson Intl", settlementSource: "noaa" },
  { id: "amsterdam", name: "Amsterdam", aliases: [], lat: 52.315, lon: 4.79, tz: "Europe/Amsterdam", icao: "EHAM", country: "NL", station: "Amsterdam Schiphol", settlementSource: "noaa" },
  { id: "munich", name: "Munich", aliases: ["munchen", "münchen"], lat: 48.348, lon: 11.813, tz: "Europe/Berlin", icao: "EDDM", country: "DE", station: "Munich Airport", settlementSource: "noaa" },
  { id: "paris", name: "Paris", aliases: [], lat: 48.967, lon: 2.428, tz: "Europe/Paris", icao: "LFPB", country: "FR", station: "Paris-Le Bourget", settlementSource: "noaa" },
  { id: "warsaw", name: "Warsaw", aliases: ["warszawa"], lat: 52.163, lon: 20.961, tz: "Europe/Warsaw", icao: "EPWA", country: "PL", station: "Warsaw Chopin", settlementSource: "noaa" },
  { id: "nyc", name: "New York City", aliases: ["nyc", "new york", "new york city"], lat: 40.77945, lon: -73.88027, tz: "America/New_York", icao: "KLGA", country: "US", station: "LaGuardia Airport", settlementSource: "noaa" },
  { id: "miami", name: "Miami", aliases: [], lat: 25.78806, lon: -80.31692, tz: "America/New_York", icao: "KMIA", country: "US", station: "Miami Intl", settlementSource: "noaa" },
  { id: "lucknow", name: "Lucknow", aliases: [], lat: 26.761, lon: 80.889, tz: "Asia/Kolkata", icao: "VILK", country: "IN", station: "Chaudhary Charan Singh Intl", settlementSource: "noaa" },
  { id: "busan", name: "Busan", aliases: ["pusan"], lat: 35.179, lon: 128.938, tz: "Asia/Seoul", icao: "RKPK", country: "KR", station: "Gimhae Intl", settlementSource: "noaa" },
  { id: "chongqing", name: "Chongqing", aliases: [], lat: 29.718, lon: 106.639, tz: "Asia/Shanghai", icao: "ZUCK", country: "CN", station: "Chongqing Jiangbei Intl", settlementSource: "noaa" },
  { id: "kuala-lumpur", name: "Kuala Lumpur", aliases: ["kl"], lat: 2.747, lon: 101.714, tz: "Asia/Kuala_Lumpur", icao: "WMKK", country: "MY", station: "Kuala Lumpur Intl", settlementSource: "noaa" },
  { id: "tel-aviv", name: "Tel Aviv", aliases: ["tel aviv"], lat: 32.011, lon: 34.887, tz: "Asia/Jerusalem", icao: "LLBG", country: "IL", station: "Ben Gurion Intl", settlementSource: "noaa" },
  { id: "madrid", name: "Madrid", aliases: [], lat: 40.466, lon: -3.555, tz: "Europe/Madrid", icao: "LEMD", country: "ES", station: "Madrid-Barajas", settlementSource: "noaa" },
  { id: "cape-town", name: "Cape Town", aliases: [], lat: -33.965, lon: 18.602, tz: "Africa/Johannesburg", icao: "FACT", country: "ZA", station: "Cape Town Intl", settlementSource: "noaa" },
  { id: "karachi", name: "Karachi", aliases: [], lat: 24.902, lon: 67.139, tz: "Asia/Karachi", icao: "OPKC", country: "PK", station: "Jinnah Intl", settlementSource: "noaa" },
  { id: "moscow", name: "Moscow", aliases: [], lat: 55.592, lon: 37.261, tz: "Europe/Moscow", icao: "UUWW", country: "RU", station: "Moscow Vnukovo", settlementSource: "noaa" },
  { id: "dallas", name: "Dallas", aliases: [], lat: 32.83836, lon: -96.83584, tz: "America/Chicago", icao: "KDAL", country: "US", station: "Dallas Love Field", settlementSource: "noaa" },
  { id: "houston", name: "Houston", aliases: [], lat: 29.64582, lon: -95.28214, tz: "America/Chicago", icao: "KHOU", country: "US", station: "Houston Hobby", settlementSource: "noaa" },
  { id: "istanbul", name: "Istanbul", aliases: [], lat: 41.262, lon: 28.74, tz: "Europe/Istanbul", icao: "LTFM", country: "TR", station: "Istanbul Airport", settlementSource: "noaa" },
  { id: "helsinki", name: "Helsinki", aliases: [], lat: 60.327, lon: 24.957, tz: "Europe/Helsinki", icao: "EFHK", country: "FI", station: "Helsinki-Vantaa", settlementSource: "noaa" },
  { id: "ankara", name: "Ankara", aliases: [], lat: 40.128, lon: 32.995, tz: "Europe/Istanbul", icao: "LTAC", country: "TR", station: "Ankara Esenboga Intl", settlementSource: "noaa" },
  { id: "atlanta", name: "Atlanta", aliases: [], lat: 33.62972, lon: -84.44223, tz: "America/New_York", icao: "KATL", country: "US", station: "Hartsfield-Jackson Intl", settlementSource: "noaa" },
  { id: "chicago", name: "Chicago", aliases: [], lat: 41.96017, lon: -87.93161, tz: "America/Chicago", icao: "KORD", country: "US", station: "Chicago O'Hare Intl", settlementSource: "noaa" },
  { id: "jeddah", name: "Jeddah", aliases: [], lat: 21.685, lon: 39.166, tz: "Asia/Riyadh", icao: "OEJN", country: "SA", station: "King Abdulaziz Intl", settlementSource: "noaa" },
  { id: "austin", name: "Austin", aliases: [], lat: 30.1831, lon: -97.68063, tz: "America/Chicago", icao: "KAUS", country: "US", station: "Austin-Bergstrom Intl", settlementSource: "noaa" },
  { id: "boston", name: "Boston", aliases: [], lat: 42.36057, lon: -71.00974, tz: "America/New_York", icao: "KBOS", country: "US", station: "Boston Logan Intl", settlementSource: "unverified" },
  { id: "phoenix", name: "Phoenix", aliases: [], lat: 33.42779, lon: -112.00366, tz: "America/Phoenix", icao: "KPHX", country: "US", station: "Phoenix Sky Harbor Intl", settlementSource: "wunderground" },
  { id: "mexico-city", name: "Mexico City", aliases: ["mexico city", "cdmx"], lat: 19.436, lon: -99.072, tz: "America/Mexico_City", icao: "MMMX", country: "MX", station: "Mexico City Benito Juarez Intl", settlementSource: "noaa" },
  { id: "dubai", name: "Dubai", aliases: [], lat: 25.254, lon: 55.366, tz: "Asia/Dubai", icao: "OMDB", country: "AE", station: "Dubai Intl", settlementSource: "wunderground" },
  { id: "sydney", name: "Sydney", aliases: [], lat: -33.946, lon: 151.173, tz: "Australia/Sydney", icao: "YSSY", country: "AU", station: "Sydney Airport", settlementSource: "unverified" },
  { id: "melbourne", name: "Melbourne", aliases: [], lat: -37.666, lon: 144.832, tz: "Australia/Melbourne", icao: "YMML", country: "AU", station: "Melbourne Airport", settlementSource: "unverified" },
  { id: "berlin", name: "Berlin", aliases: [], lat: 52.38068, lon: 13.53064, tz: "Europe/Berlin", icao: "EDDB", country: "DE", station: "Berlin Brandenburg", settlementSource: "unverified" },
  { id: "rome", name: "Rome", aliases: ["roma"], lat: 41.8, lon: 12.239, tz: "Europe/Rome", icao: "LIRF", country: "IT", station: "Rome Fiumicino", settlementSource: "unverified" },
  { id: "vienna", name: "Vienna", aliases: ["wien"], lat: 48.117, lon: 16.582, tz: "Europe/Vienna", icao: "LOWW", country: "AT", station: "Vienna Intl", settlementSource: "unverified" },
  { id: "bangkok", name: "Bangkok", aliases: [], lat: 13.686, lon: 100.767, tz: "Asia/Bangkok", icao: "VTBS", country: "TH", station: "Bangkok Suvarnabhumi", settlementSource: "unverified" },
  { id: "buenos-aires", name: "Buenos Aires", aliases: ["buenos aires"], lat: -34.822, lon: -58.536, tz: "America/Argentina/Buenos_Aires", icao: "SAEZ", country: "AR", station: "Ministro Pistarini Intl (Ezeiza)", settlementSource: "noaa" },
  { id: "panama-city", name: "Panama City", aliases: ["panama"], lat: 8.967, lon: -79.555, tz: "America/Panama", icao: "MPMG", country: "PA", station: "Marcos A. Gelabert Intl", settlementSource: "noaa" },
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
    station: null,
    settlementSource: "unverified",
  };
}
