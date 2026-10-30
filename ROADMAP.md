# WebVision2: Final Roadmap

A weather site, hosted on Vercel, built around air quality: forecasts, a live **NAQI** heatmap, and advice on where and when it's safe to walk, jog or exercise, especially for people with asthma.

## 1. Architecture

```
Browser (Next.js + Leaflet + MapTiler tiles)
  ├─ NAQI heatmap · 48-hour time slider · wind particle layer · AI chat widget
  │  calls only our own /api routes (only the MapTiler key is public, restricted by domain)
  ▼
Vercel Python Functions (FastAPI; uv for dependencies, requirements.txt for deployment)
  ├─► Upstash Redis — cache per H3 cell and hour, per-IP rate limits
  ├─► OpenWeather — Air Pollution, Forecast, Geocoding (One Call 3.0 if subscribed)
  ├─► Open-Meteo — hourly UV and other weather, if One Call 3.0 isn't available
  ├─► OSM Overpass — parks, tracks, footpaths
  └─► Gemini — AI health advisor, using function calling
```

| Layer | Choice |
|---|---|
| Frontend | Next.js, `react-leaflet`, `leaflet.heat`, `leaflet-velocity` |
| Base map | MapTiler "OpenStreetMap" style |
| Backend | FastAPI in `/api` on Vercel's Python runtime |
| Python tooling | `uv` + `pyproject.toml` + `uv.lock`; `requirements.txt` exported for Vercel |
| Cache / limits | Upstash Redis (from the Vercel Marketplace) |

## 2. Python dependencies

Defined in `pyproject.toml`, locked in `uv.lock`, and exported to `requirements.txt` with:
`uv export --no-dev --no-hashes --no-emit-project -o requirements.txt`. Re-run this after every `uv add`.

| Package | Purpose |
|---|---|
| `fastapi`, `pydantic` | API routes; checking the data from OpenWeather and Gemini |
| `httpx` | Async HTTP client, so grid points can be fetched in parallel |
| `numpy` | Grids, IDW interpolation, rolling averages for NAQI, wind u/v, scoring |
| `h3` | Hexagonal grid cells used to sample the map and as cache keys |
| `upstash-redis`, `upstash-ratelimit` | Cache that lasts between serverless calls; per-IP rate limits |
| `google-genai` | Gemini SDK |
| `python-dotenv` | Local `.env` loading |
| dev: `pytest`, `pytest-asyncio`, `respx`, `uvicorn`, `ruff` | Tests with mocked APIs, local server, linting |

`scipy`, `pandas` and `geopandas` are left out on purpose to stay under Vercel's function size limit.

## 3. External APIs and keys

| API | Used for | Status |
|---|---|---|
| OpenWeather **Air Pollution** (current, forecast, history) | Pollutant levels for NAQI, hourly for about 4 days | ✅ key works |
| OpenWeather **5-day / 3-hour Forecast** | Rain chance, humidity, wind, clouds, temperature | ✅ key works |
| OpenWeather **Geocoding** | Search; place names in chat ("near Dwarka") | ✅ same key |
| OpenWeather **One Call 3.0** | Hourly forecast **with UV** | ❌ returns 401; needs a "One Call by Call" subscription (1,000 free calls a day, card required) |
| **Open-Meteo** (no key) | Fallback for hourly UV, temperature, humidity and wind | Free, non-commercial use |
| **MapTiler** | Base map tiles | ⏳ key still needed |
| **Overpass API** (OSM) | Parks, tracks, footpaths | No key |
| **Gemini API** | AI health advisor | ✅ key works (`GEMINI_MODEL=gemini-flash-latest`) |
| **Upstash Redis** | Cache and rate limits | ⏳ create through Vercel Marketplace |

Environment variables (see `.env.example`; real values go in `.env` locally and in Vercel project settings):
`OPENWEATHER_API_KEY`, `NEXT_PUBLIC_MAPTILER_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

## 4. AQI scale: India's National AQI (NAQI, CPCB)

OpenWeather returns pollutant levels in µg/m³. We work out NAQI ourselves:

1. Calculate a **sub-index** for each pollutant by linear interpolation within its breakpoint range: `I = (I_hi − I_lo)/(B_hi − B_lo) · (C − B_lo) + I_lo`.
2. **Averaging period:** PM10, PM2.5, NO₂, SO₂ and NH₃ use a 24-hour average; CO and O₃ use an 8-hour average. We calculate rolling averages from the Air Pollution history and forecast data.
3. **NAQI = the highest sub-index**, and the pollutant behind it is shown as the "dominant pollutant". A valid NAQI needs at least 3 pollutants, including PM2.5 or PM10.
4. CO is converted from µg/m³ to mg/m³ before applying its breakpoints. Lead (Pb) isn't available from OpenWeather and is skipped.

| Category | NAQI | Colour | PM10 24h | PM2.5 24h | NO₂ 24h | O₃ 8h | CO 8h (mg/m³) | SO₂ 24h | NH₃ 24h |
|---|---|---|---|---|---|---|---|---|---|
| Good | 0–50 | dark green | 0–50 | 0–30 | 0–40 | 0–50 | 0–1.0 | 0–40 | 0–200 |
| Satisfactory | 51–100 | light green | 51–100 | 31–60 | 41–80 | 51–100 | 1.1–2.0 | 41–80 | 201–400 |
| Moderately polluted | 101–200 | yellow | 101–250 | 61–90 | 81–180 | 101–168 | 2.1–10 | 81–380 | 401–800 |
| Poor | 201–300 | orange | 251–350 | 91–120 | 181–280 | 169–208 | 10.1–17 | 381–800 | 801–1200 |
| Very poor | 301–400 | red | 351–430 | 121–250 | 281–400 | 209–748 | 17.1–34 | 801–1600 | 1201–1800 |
| Severe | 401–500 | maroon | >430 | >250 | >400 | >748 | >34 | >1600 | >1800 |

Breakpoints are stored in a single versioned config file (`naqi_breakpoints`) with unit tests checking the boundary values. They should be checked against the current CPCB publication before launch.

## 5. Features

### F1. Weather reports and forecasts
Current conditions plus hourly and daily forecasts: chance of rain, humidity (moisture), dew point, wind speed and direction, cloud cover, temperature, UV and NAQI with its dominant pollutant.

### F2. NAQI heatmap
H3 cells cover the visible map area, with cell size based on zoom and a cap of about 60–100 cells. Each cell gets a NAQI value, the values are smoothed with IDW in `numpy`, and the result is drawn as a heatmap in CPCB colours. It's labelled "modelled estimate", because OpenWeather's air quality data comes from the CAMS model, not street-level sensors.

### F3. Safe-zone recommendations
Parks, tracks and footpaths from Overpass within a set radius are ranked by NAQI, weather, distance and the user's health profile. The top 3 are shown with their best time window.

### F4. Best time to exercise (hourly safe-window score)
- Each of the next 48 hours gets a **0–100 score** combining NAQI, temperature, humidity, wind and UV. Each factor adds a weighted penalty, and any hour above a hard limit becomes "avoid".
- **Interaction:** a draggable time slider moves the heatmap through the next 24–48 hours and marks the best window, e.g. "6–8 AM · score 87".
- **Efficiency:** one Air Pollution forecast call per cell covers about 96 hours, cut into hourly frames and cached per cell and hour. The frontend loads frames ahead of the slider.

### F5. Personal health profile
- Inputs: **asthma or other respiratory condition, age group** (child, adult, 60+), **activity type** (walk, jog, run, cycle).
- These change the NAQI limits for safe, caution and avoid. Starting defaults, to be tuned:

  | Profile | Safe | Caution | Avoid |
  |---|---|---|---|
  | Healthy adult, walking | ≤ 150 | 151–250 | > 250 |
  | Healthy adult, running | ≤ 100 | 101–200 | > 200 |
  | Child or 60+ | ≤ 100 | 101–150 | > 150 |
  | Asthma, any activity | ≤ 50 | 51–100 | > 100 |

  With these limits, an NAQI of 110 is "safe" for a healthy walker and "avoid" for a runner with asthma.
- Stored only in the browser (localStorage) and sent with each request. Nothing is saved on the server and there are no accounts.
- The heatmap colours, safe zones, hourly scores and AI advisor all use the active profile.

### F6. Wind-based pollution flow
- **Interaction:** a particle-flow layer you can switch on and off (`leaflet-velocity`, Windy style) over the heatmap.
- `/api/wind/grid?bbox&hour=` samples wind on a regular grid. `numpy` converts it to u/v vectors (`u = −s·sin θ`, `v = −s·cos θ`) and returns the grid JSON format `leaflet-velocity` expects. It follows the same time slider and cache as the heatmap.

### F7. AI health advisor (Gemini)
- **Interaction:** a floating chat widget. Example: "Can I jog at 6 PM near Dwarka?"
- **Grounding:** Gemini can call our own functions: `geocode`, `get_forecast`, `get_naqi`, `get_safe_window` and `find_safe_spots`. Answers must quote tool results (NAQI, dominant pollutant, time updated), not the model's own knowledge.
- **Guardrails:** limited to weather, air quality and exercise timing; no diagnosis or medication advice; always a short "not medical advice" note and a reminder to follow your doctor's or asthma action plan. The health profile is passed in as context.
- **Backend:** `/api/chat` streams the response from `google-genai`. The model comes from `GEMINI_MODEL`, the key stays on the server, and chats have a turn limit and a per-IP rate limit.

## 6. API endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/weather?lat&lon` | Current, hourly and daily weather |
| `GET /api/naqi?lat&lon` | Current and hourly NAQI, sub-indices, dominant pollutant |
| `GET /api/naqi/grid?bbox&zoom&hour` | Heatmap frame (H3 cells and NAQI values) |
| `GET /api/wind/grid?bbox&hour` | Wind grid in `leaflet-velocity` format |
| `POST /api/safe-window` | Hourly 0–100 scores for a location and profile |
| `POST /api/safe-spots` | Ranked parks and routes for a location and profile |
| `GET /api/geocode?q` | Place search |
| `POST /api/chat` | Streamed Gemini answer |

## 7. Phases

| # | Phase | Weeks | Work | Done when |
|---|---|---|---|---|
| 0 | Setup | 1 | ✅ repo, ✅ uv/`pyproject.toml`, ✅ `requirements.txt`, ✅ `.env`; Vercel project, environment variables, Upstash, CI (ruff + pytest), test endpoint | Test endpoint is live on Vercel |
| 1 | Weather core | 1–2 | `/api/weather`, `/api/geocode`, forecast cards, search, browser location | Forecast shown for any searched city |
| 2 | NAQI engine | 2 | Breakpoint config, sub-indices, rolling averages, `/api/naqi` | Tests pass for all breakpoint boundaries |
| 3 | Heatmap + time slider | 3–4 | H3 grid, Redis cache, IDW, `/api/naqi/grid`, heatmap, legend, 48-hour slider with frames loaded ahead | Slider runs smoothly over Delhi |
| 4 | Health profile + safe windows | 4 | Profile UI, limits config, `/api/safe-window`, best-window display | Same NAQI gives different verdicts for different profiles |
| 5 | Wind flow | 5 | `/api/wind/grid`, `leaflet-velocity` layer and switch, synced with the slider | Particles move with the slider |
| 6 | Safe zones | 5 | Overpass, ranking, `/api/safe-spots`, top 3 cards | Ranked parks shown with best time |
| 7 | AI health advisor | 6 | Gemini function calling, streaming chat widget, guardrails, mocked-tool tests | The Dwarka question gets an answer based on live data |
| 8 | Polish and launch | 7 | Mobile layout, accessibility, error and empty states, rate limits, disclaimers, production deployment | Production URL is live |

## 8. Technical risks and how to handle them

1. **API call volume.** One forecast call per H3 cell covers every hour, with a 1-hour cache per cell, a cap on cells per view, at most about 10 parallel requests to stay under 60 calls a minute, and the cache filled gradually across requests.
2. **NAQI needs 24-hour and 8-hour averages.** Combine Air Pollution history (past hours) with forecast data (future hours) for rolling windows, cache the merged series per cell, and test the edge cases.
3. **Modelled, coarse data.** Smooth with IDW, show "modelled estimate" with an updated time, and optionally compare against OpenAQ or CPCB station data.
4. **UV without One Call 3.0.** Use Open-Meteo for hourly UV and other weather until or unless One Call is subscribed. Wrap providers behind a single interface so they can be swapped.
5. **Scoring.** Weighted penalties plus hard limits, with weights from the profile. PM2.5 and O₃ get the most weight for asthma, and ozone usually peaks in the afternoon. Unit-test each component.
6. **Smooth animation.** Canvas layers, small payloads (rounded values, visible area only) and frames loaded ahead of the slider.
7. **AI accuracy and safety.** Answers only from tool results, with guardrails, a turn limit, a rate limit, and tests with fixed tool outputs.
8. **Vercel limits.** No disk, a size limit, cold starts and time limits. Keep dependencies small, cache in Redis, keep requests short; Hobby-plan cron can pre-warm only a few cities such as Delhi NCR.
9. **Secrets.** The OpenWeather, Gemini and Upstash keys stay on the server only. The MapTiler key is public by design, so restrict it to our domains in the MapTiler dashboard. `.env` is git-ignored.
10. **Reliability.** Retries with increasing delays, falling back to older cached data labelled "updated X min ago", and all external APIs mocked in tests.

## 9. Still needed before or while building
- **MapTiler API key:** the link provided still has the `INSERT_YOUR_OWN_API_KEY` placeholder.
- **Upstash Redis** database through the Vercel Marketplace.
- **Decision:** subscribe to One Call 3.0, or use Open-Meteo for hourly UV.
