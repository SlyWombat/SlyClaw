import {
  ECOWITT_API_KEY,
  ECOWITT_APP_KEY,
  ECOWITT_LOCAL_PORT,
  ECOWITT_MAC,
  ECOWITT_STATION_NAME,
} from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Ecowitt cloud API types (real_time endpoint)
// ---------------------------------------------------------------------------

interface EcowittValue {
  value: string;
  unit: string;
}

interface EcowittRealTimeData {
  outdoor?: {
    temperature?: EcowittValue;
    feels_like?: EcowittValue;
    app_temp?: EcowittValue;
    dew_point?: EcowittValue;
    humidity?: EcowittValue;
  };
  indoor?: {
    temperature?: EcowittValue;
    humidity?: EcowittValue;
  };
  wind?: {
    wind_speed?: EcowittValue;
    wind_gust?: EcowittValue;
    wind_direction?: EcowittValue;
  };
  rainfall?: {
    rain_rate?: EcowittValue;
    daily?: EcowittValue;
    hourly?: EcowittValue;
    event?: EcowittValue;
    weekly?: EcowittValue;
    monthly?: EcowittValue;
    yearly?: EcowittValue;
  };
  pressure?: {
    relative?: EcowittValue;
    absolute?: EcowittValue;
  };
  solar_and_uvi?: {
    solar?: EcowittValue;
    uvi?: EcowittValue;
  };
  lightning?: {
    distance?: EcowittValue;
    count?: EcowittValue;
    time?: EcowittValue;
  };
  pm25_ch1?: {
    pm25?: EcowittValue;
    real_time_aqi?: EcowittValue;
    '24_hours_aqi'?: EcowittValue;
  };
}

interface EcowittApiResponse {
  code: number;
  msg: string;
  time: string;
  data?: EcowittRealTimeData;
}

// ---------------------------------------------------------------------------
// Cache: avoid hammering the API on rapid queries
// ---------------------------------------------------------------------------

let cachedData: EcowittRealTimeData | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// Synchronous getter — returns formatted summary if cache is populated, null otherwise.
// Used to inject weather into the Ollama system prompt without a tool call.
export function getCachedWeather(): string | null {
  if (!cachedData) return null;
  return formatWeatherSummary(cachedData, ECOWITT_STATION_NAME);
}

export function injectLocalData(data: EcowittRealTimeData): void {
  cachedData = data;
  cacheTimestamp = Date.now();
}

// Start background polling so get_weather always returns from cache instantly.
// Called once from src/index.ts after config is ready.
export function startWeatherBackgroundRefresh(): void {
  if (!ECOWITT_APP_KEY || !ECOWITT_API_KEY || !ECOWITT_MAC) return;
  if (refreshTimer) return; // already running

  const refresh = () => {
    fetchFromCloud()
      .then((data) => {
        cachedData = data;
        cacheTimestamp = Date.now();
        logger.debug('Weather cache refreshed');
      })
      .catch((err) => logger.warn({ err }, 'Background weather refresh failed'));
  };

  refresh(); // immediate first fetch
  refreshTimer = setInterval(refresh, CACHE_TTL_MS);
  logger.info({ intervalMs: CACHE_TTL_MS }, 'Weather background refresh started');
}

// ---------------------------------------------------------------------------
// Fetch from Ecowitt cloud API
// ---------------------------------------------------------------------------

async function fetchFromCloud(): Promise<EcowittRealTimeData> {
  const params = new URLSearchParams({
    application_key: ECOWITT_APP_KEY,
    api_key: ECOWITT_API_KEY,
    mac: ECOWITT_MAC,
    call_back: 'all',
    temp_unitid: '1',        // °C
    pressure_unitid: '3',    // hPa
    wind_speed_unitid: '6',  // km/h
    rainfall_unitid: '12',   // mm
    solar_irradiance_unitid: '16', // W/m²
  });

  const url = `https://api.ecowitt.net/api/v3/device/real_time?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    throw new Error(`Ecowitt API HTTP ${res.status}`);
  }

  const body = (await res.json()) as EcowittApiResponse;

  if (body.code !== 0) {
    throw new Error(`Ecowitt API error ${body.code}: ${body.msg}`);
  }

  return body.data ?? {};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function normaliseUnit(unit: string): string {
  return unit
    .replace('℃', '°C')
    .replace('℉', '°F')
    .replace('㎞/h', 'km/h');
}

function fmt(v: EcowittValue | undefined): string {
  if (!v || v.value === '' || v.value === undefined) return 'N/A';
  return `${v.value} ${normaliseUnit(v.unit)}`.trim();
}

function bearingToCompass(deg: number): string {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

export function formatWeatherSummary(data: EcowittRealTimeData, stationName: string): string {
  const lines: string[] = [`*${stationName} — Current Conditions*`];

  // Outdoor
  if (data.outdoor) {
    const o = data.outdoor;
    const temp = fmt(o.temperature);
    const feelsLike = o.feels_like ?? o.app_temp;
    const humidity = fmt(o.humidity);
    const dew = fmt(o.dew_point);
    lines.push(`Outdoor: ${temp}${feelsLike ? ` (feels like ${fmt(feelsLike)})` : ''}`);
    lines.push(`Humidity: ${humidity}${dew !== 'N/A' ? ` | Dew point: ${dew}` : ''}`);
  }

  // Wind
  if (data.wind) {
    const w = data.wind;
    const speed = fmt(w.wind_speed);
    const gust = fmt(w.wind_gust);
    const dir = w.wind_direction?.value
      ? `${w.wind_direction.value}° (${bearingToCompass(parseFloat(w.wind_direction.value))})`
      : 'N/A';
    lines.push(`Wind: ${speed} from ${dir}${gust !== 'N/A' ? `, gusts ${gust}` : ''}`);
  }

  // Rain
  if (data.rainfall) {
    const r = data.rainfall;
    const rate = fmt(r.rain_rate);
    const daily = fmt(r.daily);
    const isRaining = r.rain_rate && parseFloat(r.rain_rate.value) > 0;
    lines.push(isRaining ? `Rain: ${rate}/h | Today: ${daily}` : `Rain: None today (${daily})`);
  }

  // Pressure
  if (data.pressure?.relative) {
    lines.push(`Pressure: ${fmt(data.pressure.relative)}`);
  }

  // UV / Solar
  if (data.solar_and_uvi) {
    const s = data.solar_and_uvi;
    const uvi = fmt(s.uvi);
    const solar = fmt(s.solar);
    if (uvi !== 'N/A' || solar !== 'N/A') {
      lines.push(`UV: ${uvi} | Solar: ${solar}`);
    }
  }

  // PM2.5 air quality
  if (data.pm25_ch1) {
    const pm = data.pm25_ch1;
    const reading = fmt(pm.pm25);
    const aqi = fmt(pm.real_time_aqi);
    if (reading !== 'N/A') {
      const aqiNum = pm.real_time_aqi?.value ?? '';
      lines.push(`Air quality: PM2.5 ${reading} | AQI ${aqiNum}`);
    }
  }

  // Indoor
  if (data.indoor) {
    const i = data.indoor;
    lines.push(`Indoor: ${fmt(i.temperature)} | ${fmt(i.humidity)}`);
  }

  // Lightning
  if (data.lightning?.count && data.lightning.count.value !== '0') {
    lines.push(
      `Lightning: ${fmt(data.lightning.distance)} away | ${data.lightning.count.value} strikes today`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point: get current conditions
// ---------------------------------------------------------------------------

export async function getWeatherConditions(): Promise<string> {
  if (!ECOWITT_APP_KEY || !ECOWITT_API_KEY || !ECOWITT_MAC) {
    return 'Weather station not configured. Set ECOWITT_APP_KEY, ECOWITT_API_KEY, and ECOWITT_MAC in .env';
  }

  // Background refresh keeps the cache warm — serve instantly if available
  if (cachedData) {
    const ageMin = Math.round((Date.now() - cacheTimestamp) / 60_000);
    const suffix = ageMin > 6 ? ` (${ageMin}m ago)` : '';
    return formatWeatherSummary(cachedData, ECOWITT_STATION_NAME) + suffix;
  }

  // Cache not yet populated (first startup before background refresh fires) — fetch now
  try {
    const data = await fetchFromCloud();
    cachedData = data;
    cacheTimestamp = Date.now();
    return formatWeatherSummary(data, ECOWITT_STATION_NAME);
  } catch (err) {
    logger.warn({ err }, 'Ecowitt cloud fetch failed');
    return `Could not fetch weather: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Optional: local push receiver (Ecowitt/Wunderground protocol)
// Station pushes to /data/report/ every 16–60s; values arrive in imperial units
// ---------------------------------------------------------------------------

export function startLocalPushReceiver(): void {
  if (!ECOWITT_LOCAL_PORT) return;

  // Lazy import express — only loaded when local push is configured
  import('express').then(({ default: express }) => {
    const app = express();
    app.use(express.urlencoded({ extended: true }));

    app.post('/data/report/', (req, res) => {
      try {
        const d = req.body as Record<string, string>;

        // Convert from imperial (Ecowitt push) to metric (our display units)
        const toC = (f: string | undefined) =>
          f ? { value: (((parseFloat(f) - 32) * 5) / 9).toFixed(1), unit: '°C' } : undefined;
        const toKmh = (mph: string | undefined) =>
          mph ? { value: (parseFloat(mph) * 1.60934).toFixed(1), unit: 'km/h' } : undefined;
        const toMm = (inch: string | undefined) =>
          inch ? { value: (parseFloat(inch) * 25.4).toFixed(2), unit: 'mm' } : undefined;
        const toMmH = (inch: string | undefined) =>
          inch ? { value: (parseFloat(inch) * 25.4).toFixed(2), unit: 'mm/h' } : undefined;
        const toHpa = (inHg: string | undefined) =>
          inHg ? { value: (parseFloat(inHg) * 33.8639).toFixed(1), unit: 'hPa' } : undefined;
        const raw = (v: string | undefined, unit: string) =>
          v ? { value: v, unit } : undefined;

        const parsed: EcowittRealTimeData = {
          outdoor: {
            temperature: toC(d.tempf),
            humidity: raw(d.humidity, '%'),
            dew_point: toC(d.dewpoint),
            feels_like: toC(d.feelslike ?? d.windchill ?? d.heatindex),
          },
          indoor: {
            temperature: toC(d.tempinf),
            humidity: raw(d.humidityin, '%'),
          },
          wind: {
            wind_speed: toKmh(d.windspeedmph),
            wind_gust: toKmh(d.windgustmph),
            wind_direction: raw(d.winddir, '°'),
          },
          rainfall: {
            rain_rate: toMmH(d.rainratein),
            daily: toMm(d.dailyrainin),
            hourly: toMm(d.hourlyrainin),
            event: toMm(d.eventrainin),
            weekly: toMm(d.weeklyrainin),
            monthly: toMm(d.monthlyrainin),
            yearly: toMm(d.yearlyrainin),
          },
          pressure: {
            relative: toHpa(d.baromrelin),
            absolute: toHpa(d.baromabsin),
          },
          solar_and_uvi: {
            solar: raw(d.solarradiation, 'W/m²'),
            uvi: raw(d.uv, ''),
          },
        };

        injectLocalData(parsed);
        res.sendStatus(200);
      } catch (err) {
        logger.warn({ err }, 'Ecowitt local push parse error');
        res.sendStatus(500);
      }
    });

    app.listen(ECOWITT_LOCAL_PORT, () => {
      logger.info({ port: ECOWITT_LOCAL_PORT }, 'Ecowitt local push receiver listening');
    });
  }).catch((err) => {
    logger.error({ err }, 'Failed to start Ecowitt local push receiver');
  });
}
