export type TempUnit = "C" | "F";
export type TempKind = "high" | "low";
export type Side = "YES" | "NO";

export type CityMeta = {
  id: string;
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
  tz: string;
  /** METAR id of the settlement station ("" when it has no METAR, e.g. HKO). */
  icao: string;
  country: string;
  /** Settlement station name from the market rules. */
  station?: string | null;
  settlementSource?: "noaa" | "wunderground" | "hko" | "unverified";
};

export type BucketBound = {
  lo: number;
  hi: number;
  label: string;
  kind: "floor" | "exact" | "range" | "ceil";
};

export type MarketBucket = {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;
  label: string;
  lo: number;
  hi: number;
  kind: BucketBound["kind"];
  yesPrice: number;
  noPrice: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume: number;
  volume24hr: number;
  clobYes: string | null;
  clobNo: string | null;
  modelP: number;
  edgeYes: number;
  edgeNo: number;
  kellyYes: number;
  kellyNo: number;
  tradeable: boolean;
};

export type HourPoint = {
  time: string;
  tempC: number;
};

export type WeatherNow = {
  tempC: number | null;
  humidity: number | null;
  windMs: number | null;
  weatherCode: number | null;
  cover: string | null;
  station: string | null;
  observedAt: string | null;
  observedMaxC: number | null;
  /** Min METAR temp at the settlement station so far on the city's current local day. */
  observedMinC: number | null;
  modelMeanC: number | null;
  modelStdC: number | null;
  modelMinC: number | null;
  modelMaxC: number | null;
  membersC: number[];
  /** Daily-MAX members by local date (high markets). */
  membersByDate: Record<string, number[]>;
  /** Daily-MIN members by local date (low markets; only cities with live low markets). */
  membersMinByDate: Record<string, number[]>;
  localDate: string;
  hourly: HourPoint[];
  source: string;
};

export type DeskEvent = {
  eventId: string;
  slug: string;
  title: string;
  cityId: string;
  cityName: string;
  kind: TempKind;
  unit: TempUnit;
  eventDate: string;
  endDate: string;
  volume: number;
  volume24hr: number;
  liquidity: number;
  image: string | null;
  context: string | null;
  buckets: MarketBucket[];
  implied: number | null;
  /** Ensemble mean of the event's kind (daily max for high, daily min for low), event unit. */
  modelHigh: number | null;
  observed: number | null;
  bestSignal: Signal | null;
};

export type Signal = {
  id: string;
  eventId: string;
  marketId: string;
  cityId: string;
  cityName: string;
  date: string;
  kind: TempKind;
  unit: TempUnit;
  question: string;
  label: string;
  side: Side;
  marketP: number;
  modelP: number;
  edge: number;
  kelly: number;
  volume24hr: number;
};

export type DeskSnapshot = {
  fetchedAt: string;
  events: DeskEvent[];
  weather: Record<string, WeatherNow>;
  signals: Signal[];
  totals: {
    events: number;
    cities: number;
    volume24hr: number;
    openSignals: number;
  };
  sources: string[];
  warning: string | null;
};

export type PaperFill = {
  id: string;
  eventId: string;
  marketId: string;
  cityId: string;
  cityName: string;
  date: string;
  question: string;
  side: Side;
  price: number;
  shares: number;
  cost: number;
  modelP: number;
  placedAt: string;
  status: "open" | "won" | "lost";
  payout: number;
};

export type BotSettings = {
  bankroll: number;
  kellyFraction: number;
  minEdge: number;
  minPrice: number;
  maxPrice: number;
  maxPosPct: number;
  armed: boolean;
};
