# Add Ecowitt Weather Station

This skill integrates your Ecowitt personal weather station so the agent can report real-time conditions: temperature, humidity, wind, rain, UV, pressure, soil sensors, and more.

After setup, you can ask:
- `@Nano what's the weather like?`
- `@Nano is it raining?`
- `@Nano how windy is it?`
- `@Nano what's the UV index?`

The Qwen routing layer gets a `get_weather` tool (no API key needed for calls), and Claude container agents get an `mcp__weather__get_conditions` MCP tool.

---

## How Ecowitt Works

Ecowitt stations can push data two ways:

1. **Ecowitt Cloud API** — station uploads to `ecowitt.net`; you pull via REST with Application Key + API Key + MAC address. Easiest, works from anywhere.
2. **Local push (Wunderground/Ecowitt protocol)** — station POSTs directly to a local endpoint every 16–60s. No cloud dependency, lowest latency.

This skill implements **both** and lets you pick. Cloud API is the default (simpler setup).

---

## Prerequisites

### Ecowitt Cloud API Credentials

You need three values from [ecowitt.net](https://www.ecowitt.net):

1. **Application Key** — go to https://www.ecowitt.net → User Center → Application Key → Create New Application Key
2. **API Key** — same page, below Application Key
3. **Device MAC address** — go to Device List → your station → the MAC is shown under the device name (format: `AA:BB:CC:DD:EE:FF`)

---

## Implementation

### Step 1: Add Config

Read `src/config.ts` and add to the `readEnvFile` call:

```typescript
const envConfig = readEnvFile([
  // ...existing keys...
  'ECOWITT_APP_KEY',
  'ECOWITT_API_KEY',
  'ECOWITT_MAC',
  'ECOWITT_STATION_NAME',
  'ECOWITT_LOCAL_PORT',
]);
```

Add exports at the bottom of `src/config.ts`:

```typescript
// Ecowitt weather station — cloud API credentials
export const ECOWITT_APP_KEY =
  process.env.ECOWITT_APP_KEY || envConfig.ECOWITT_APP_KEY || '';
export const ECOWITT_API_KEY =
  process.env.ECOWITT_API_KEY || envConfig.ECOWITT_API_KEY || '';
export const ECOWITT_MAC =
  process.env.ECOWITT_MAC || envConfig.ECOWITT_MAC || '';
export const ECOWITT_STATION_NAME =
  process.env.ECOWITT_STATION_NAME || envConfig.ECOWITT_STATION_NAME || 'Home';
// Set to a port number to also receive local push data (e.g. 8765); 0 = disabled
export const ECOWITT_LOCAL_PORT = parseInt(
  process.env.ECOWITT_LOCAL_PORT || envConfig.ECOWITT_LOCAL_PORT || '0',
  10,
);
```

### Step 2: Add `.env` Variables

Add to `.env`:

```bash
# Ecowitt weather station
ECOWITT_APP_KEY=<your-application-key>
ECOWITT_API_KEY=<your-api-key>
ECOWITT_MAC=AA:BB:CC:DD:EE:FF
ECOWITT_STATION_NAME=Home
# Optional: enable local push receiver on this port
# ECOWITT_LOCAL_PORT=8765
```

### Step 3: Create the Weather Module

Create `src/weather-station.ts`:

```typescript
import {
  ECOWITT_APP_KEY,
  ECOWITT_API_KEY,
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
const CACHE_TTL_MS = 60_000; // 1 minute

export function injectLocalData(data: EcowittRealTimeData): void {
  cachedData = data;
  cacheTimestamp = Date.now();
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
    temp_unitid: '1',    // °C
    pressure_unitid: '3', // hPa
    wind_speed_unitid: '6', // km/h
    rainfall_unitid: '12', // mm
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
// Format weather data as a human-readable summary
// ---------------------------------------------------------------------------

function fmt(v: EcowittValue | undefined): string {
  if (!v || v.value === '' || v.value === undefined) return 'N/A';
  return `${v.value} ${v.unit}`.trim();
}

function bearingToCompass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
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
    lines.push(`🌡️  Outdoor: ${temp}${feelsLike ? ` (feels like ${fmt(feelsLike)})` : ''}`);
    lines.push(`💧 Humidity: ${humidity}${dew !== 'N/A' ? ` | Dew point: ${dew}` : ''}`);
  }

  // Wind
  if (data.wind) {
    const w = data.wind;
    const speed = fmt(w.wind_speed);
    const gust = fmt(w.wind_gust);
    const dir = w.wind_direction?.value
      ? `${w.wind_direction.value}° (${bearingToCompass(parseFloat(w.wind_direction.value))})`
      : 'N/A';
    lines.push(`💨 Wind: ${speed} from ${dir}${gust !== 'N/A' ? `, gusts ${gust}` : ''}`);
  }

  // Rain
  if (data.rainfall) {
    const r = data.rainfall;
    const rate = fmt(r.rain_rate);
    const daily = fmt(r.daily);
    const isRaining = r.rain_rate && parseFloat(r.rain_rate.value) > 0;
    const rainLine = isRaining
      ? `🌧️  Rain: ${rate}/h | Today: ${daily}`
      : `☀️  Rain: None today (${daily})`;
    lines.push(rainLine);
  }

  // Pressure
  if (data.pressure?.relative) {
    lines.push(`📊 Pressure: ${fmt(data.pressure.relative)}`);
  }

  // UV / Solar
  if (data.solar_and_uvi) {
    const s = data.solar_and_uvi;
    const uvi = fmt(s.uvi);
    const solar = fmt(s.solar);
    if (uvi !== 'N/A' || solar !== 'N/A') {
      lines.push(`☀️  UV: ${uvi} | Solar: ${solar}`);
    }
  }

  // Indoor
  if (data.indoor) {
    const i = data.indoor;
    lines.push(`🏠 Indoor: ${fmt(i.temperature)} | ${fmt(i.humidity)}`);
  }

  // Lightning
  if (data.lightning?.count && data.lightning.count.value !== '0') {
    lines.push(`⚡ Lightning: ${fmt(data.lightning.distance)} away | ${data.lightning.count.value} strikes today`);
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

  // Use cache if fresh
  if (cachedData && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return formatWeatherSummary(cachedData, ECOWITT_STATION_NAME);
  }

  try {
    const data = await fetchFromCloud();
    cachedData = data;
    cacheTimestamp = Date.now();
    return formatWeatherSummary(data, ECOWITT_STATION_NAME);
  } catch (err) {
    logger.warn({ err }, 'Ecowitt cloud fetch failed');
    // Fall back to stale cache if available
    if (cachedData) {
      const ageMin = Math.round((Date.now() - cacheTimestamp) / 60000);
      return `(stale data, ${ageMin}m old)\n` + formatWeatherSummary(cachedData, ECOWITT_STATION_NAME);
    }
    return `Could not fetch weather: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

### Step 4: Add `get_weather` Tool to Ollama

Read `src/ollama-tools.ts` and add the tool definition to `OLLAMA_TOOLS`:

```typescript
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description:
        'Get current weather conditions from the home weather station. Returns real-time temperature, humidity, wind, rain, UV, pressure, and indoor conditions. Use this whenever the user asks about the weather, temperature, rain, wind, or current conditions.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
```

Add the handler in `executeTool()`, just before the `delegate_to_claude` case:

```typescript
    if (name === 'get_weather') {
      const { getWeatherConditions } = await import('./weather-station.js');
      return await getWeatherConditions();
    }
```

### Step 5: Add MCP Tool for Claude Container Agents

Read `container/agent-runner/src/index.ts` and find where MCP tools are registered (look for where `ollama_list_models` / `ollama_generate` are wired in).

Add a weather MCP tool alongside the Ollama MCP tools. In the tools array, add:

```typescript
{
  name: 'mcp__weather__get_conditions',
  description: 'Get current conditions from the home Ecowitt weather station: temperature, humidity, wind, rain, UV, pressure, and indoor readings.',
  input_schema: { type: 'object', properties: {}, required: [] },
},
```

In the tool handler switch/if block, add:

```typescript
if (toolName === 'mcp__weather__get_conditions') {
  // Forward to host weather endpoint
  const res = await fetch('http://host.docker.internal:' + (process.env.WEATHER_LOCAL_PORT || '8766') + '/weather', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { content: [{ type: 'text', text: `Weather endpoint error: ${res.status}` }] };
  const text = await res.text();
  return { content: [{ type: 'text', text }] };
}
```

**Note:** This requires adding a tiny weather HTTP endpoint in `src/index.ts` (Step 6 below). Alternatively, you can skip MCP integration for now — Claude agents can still ask Qwen to fetch weather via `web_search` as a fallback.

### Step 6: Expose a Local Weather HTTP Endpoint (for MCP tool)

This is optional but enables Claude container agents to get weather data via the MCP tool defined in Step 5.

Read `src/index.ts` and add this in `main()` after other server setup:

```typescript
// Local weather endpoint for container agents
if (ECOWITT_APP_KEY || ECOWITT_LOCAL_PORT) {
  const weatherApp = express();
  weatherApp.get('/weather', async (_req, res) => {
    const { getWeatherConditions } = await import('./weather-station.js');
    const result = await getWeatherConditions();
    res.type('text').send(result);
  });
  const WEATHER_LOCAL_PORT = 8766;
  weatherApp.listen(WEATHER_LOCAL_PORT, '127.0.0.1', () => {
    logger.info({ port: WEATHER_LOCAL_PORT }, 'Weather endpoint listening');
  });
}
```

Add `WEATHER_LOCAL_PORT=8766` to the container env in `container-runner.ts` where other env vars are passed.

### Step 7: Optional — Local Push Receiver

If you want the station to push directly to your machine instead of polling the cloud (lower latency, works offline):

1. On your Ecowitt console/GW unit, configure **Custom Server**:
   - Protocol: **Ecowitt** (or Wunderground)
   - Server IP: your machine's LAN IP
   - Path: `/data/report/`
   - Port: `8765` (or whatever you set `ECOWITT_LOCAL_PORT` to)
   - Upload interval: 16s or 60s

2. Add a local push receiver in `src/weather-station.ts`:

```typescript
import express from 'express';
import { ECOWITT_LOCAL_PORT } from './config.js';

export function startLocalPushReceiver(): void {
  if (!ECOWITT_LOCAL_PORT) return;

  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.post('/data/report/', (req, res) => {
    try {
      const d = req.body as Record<string, string>;
      // Map Ecowitt push payload to EcowittRealTimeData shape
      const parsed: EcowittRealTimeData = {
        outdoor: {
          temperature: d.tempf ? { value: String(((parseFloat(d.tempf) - 32) * 5 / 9).toFixed(1)), unit: '°C' } : undefined,
          humidity: d.humidity ? { value: d.humidity, unit: '%' } : undefined,
        },
        wind: {
          wind_speed: d.windspeedmph ? { value: String((parseFloat(d.windspeedmph) * 1.60934).toFixed(1)), unit: 'km/h' } : undefined,
          wind_gust: d.windgustmph ? { value: String((parseFloat(d.windgustmph) * 1.60934).toFixed(1)), unit: 'km/h' } : undefined,
          wind_direction: d.winddir ? { value: d.winddir, unit: '°' } : undefined,
        },
        rainfall: {
          rain_rate: d.rainratein ? { value: String((parseFloat(d.rainratein) * 25.4).toFixed(2)), unit: 'mm/h' } : undefined,
          daily: d.dailyrainin ? { value: String((parseFloat(d.dailyrainin) * 25.4).toFixed(1)), unit: 'mm' } : undefined,
        },
        pressure: {
          relative: d.baromrelin ? { value: String((parseFloat(d.baromrelin) * 33.8639).toFixed(1)), unit: 'hPa' } : undefined,
        },
        solar_and_uvi: {
          solar: d.solarradiation ? { value: d.solarradiation, unit: 'W/m²' } : undefined,
          uvi: d.uv ? { value: d.uv, unit: '' } : undefined,
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
}
```

Call `startLocalPushReceiver()` from `src/index.ts` `main()`.

### Step 8: Build and Test

```bash
npm run build
systemctl --user restart slyclaw
```

Quick test from command line:

```bash
node -e "
import('./dist/weather-station.js').then(async m => {
  console.log(await m.getWeatherConditions());
});
"
```

Then test via WhatsApp:

```
@Nano what's the weather?
@Nano is it raining outside?
@Nano what's the temperature?
```

---

## API Reference

The Ecowitt real_time endpoint returns these data groups (set via `call_back` parameter):

| call_back value | Data |
|---|---|
| `outdoor` | temp, feels_like, dew_point, humidity |
| `indoor` | indoor temp, humidity |
| `wind` | wind_speed, wind_gust, wind_direction |
| `rainfall` | rain_rate, daily, hourly, event, weekly, monthly, yearly |
| `pressure` | relative, absolute |
| `solar_and_uvi` | solar irradiance, UV index |
| `lightning` | distance, count, last time |
| `soil_ch1`–`soil_ch8` | soil moisture/temp sensors |
| `leaf_wetness_ch1`–`ch8` | leaf wetness sensors |
| `pm25_ch1`–`ch4` | particulate matter sensors |
| `co2_aqi_combo` | CO₂ / air quality combo |
| `all` | all of the above |

Unit ID reference:
- Temperature: `1`=°C, `2`=°F
- Pressure: `3`=hPa, `4`=inHg, `5`=mmHg
- Wind: `6`=km/h, `7`=m/s, `8`=mph, `9`=knots, `10`=bft
- Rainfall: `12`=mm, `13`=in
- Solar: `16`=W/m²

---

## Troubleshooting

### "Weather station not configured"
- Verify all three env vars are set: `ECOWITT_APP_KEY`, `ECOWITT_API_KEY`, `ECOWITT_MAC`
- Rebuild after changing `.env`: `npm run build && systemctl --user restart slyclaw`

### "Ecowitt API error -1" or auth failure
- Double-check Application Key and API Key at https://www.ecowitt.net → User Center
- MAC address must match exactly (with colons: `AA:BB:CC:DD:EE:FF`)

### Qwen doesn't call `get_weather`
- Try explicit phrasing: "what's the weather at home" or "check the weather station"
- You can force it: "use get_weather tool to get conditions"

### Stale data returned
- Data is cached for 60 seconds (configurable via `CACHE_TTL_MS` in `weather-station.ts`)
- Check logs: `journalctl --user -u slyclaw -f`

---

## Removal

1. Remove `ECOWITT_*` exports from `src/config.ts` and `readEnvFile` call
2. Delete `src/weather-station.ts`
3. Remove `get_weather` from `OLLAMA_TOOLS` array in `src/ollama-tools.ts`
4. Remove `get_weather` handler from `executeTool()` in `src/ollama-tools.ts`
5. Remove optional MCP tool from `container/agent-runner/src/index.ts`
6. Remove optional weather HTTP endpoint from `src/index.ts`
7. Remove `ECOWITT_*` lines from `.env`
8. Rebuild: `npm run build && systemctl --user restart slyclaw`
