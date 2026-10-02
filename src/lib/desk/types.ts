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
  /** Raw model probability (bias-corrected WeatherNext / intraday), before the market blend. */
  modelP: number;
  /** Tradeable probability: w·modelP + (1 − w)·marketMid (0 on the observation's settled side). */
  blendP?: number;
  /** YES mid used in the blend: (bid + ask) / 2, else the Gamma price. */
  marketMid?: number | null;
  /** Model weight w of the blend for this event at snapshot time. */
  blendW?: number;
  /** Edges: blendP − executable price − taker fee per share. */
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
  /** Latest METAR temp (°C) at the settlement station and its time (ISO); null without METAR. Never a forecast. */
  latestObsC?: number | null;
  latestObsAt?: string | null;
  modelMeanC: number | null;
  modelStdC: number | null;
  modelMinC: number | null;
  modelMaxC: number | null;
  membersC: number[];
  /** Daily-MAX members by local date (high markets). */
  membersByDate: Record<string, number[]>;
  /** Daily-MIN members by local date (low markets; only cities with live low markets). */
  membersMinByDate: Record<string, number[]>;
  /** Provider label of membersMinByDate (WeatherNext / Open-Meteo ensemble / multi-model); null if none. */
  minSource?: string | null;
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
  /**
   * Stats of the daily-MIN members actually used to price a LOW event (°C).
   * Null for high events (the UI keeps the city's daily-max stats for those).
   */
  lowEnsemble?: EnsembleStats | null;
  /** Live-day time-of-day conditioning used to price this event (null off the live day / no observation). */
  intraday?: {
    localHour: number;
    remainingFrac: number;
    observedC: number;
    remainingFcC: number | null;
    biasC: number;
    centerC: number;
    sigmaC: number;
  } | null;
  bestSignal: Signal | null;
};

/** Ensemble summary for display, °C. */
export type EnsembleStats = {
  members: number;
  stdC: number | null;
  minC: number | null;
  maxC: number | null;
  source: string | null;
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
  /** Probability the trade is sized on (side-adjusted): the model/market blend. */
  modelP: number;
  /** Side-adjusted raw model probability (pre-blend). */
  rawModelP?: number;
  /** Side-adjusted market mid used in the blend. */
  marketMid?: number | null;
  blendW?: number;
  /** Net edge: modelP − executable price − taker fee. */
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
  /** Taker fee paid at fill (USDC; 0.05 × shares × p × (1 − p)); subtracted from PnL. Older fills: none. */
  fee?: number;
  /** Kelly target stake before the book walk; cost < requestedStake ⇔ depth-limited partial fill. */
  requestedStake?: number;
  /** Book levels consumed by the walk (price is the VWAP over them). */
  bookLevels?: number;
  depthLimited?: boolean;
  /** Limit price of the walk (highest price still clearing the edge floor net of fee). */
  limitPrice?: number;
  rawModelP?: number;
  marketMid?: number | null;
  blendW?: number;
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
