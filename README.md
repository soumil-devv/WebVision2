# BreathEasy

## Problem statement

Millions of people in Indian cities live with asthma, yet many step outside without knowing how polluted the air around them is, or when it would be safer to go out.

BreathEasy is a website that shows air quality (India's National AQI, NAQI) across the user's surrounding area on a live map. It uses their health profile (asthma, age and activity) to advise when and where it is safest to walk, jog, run or cycle.

**Live site:** https://webvision.kakar.tech

## Features

- **NAQI map:** a colour-coded map of the area in view, using the official CPCB categories.
- **48-hour forecast slider:** drag or play through the coming hours to see how air quality is expected to change.
- **Personal health profile:** asthma, age and activity type change the safe and avoid limits. The profile is stored only in the browser.
- **Best time to exercise:** an hourly 0–100 score combining NAQI, temperature, humidity, wind and UV. 70–100 means safe, 40–69 caution and 0–39 avoid, matching the verdict shown.
- **Cleanest spots nearby:** named parks within 4 km, ranked by air quality and distance.
- **Wind layer:** animated particles showing where the air is moving.
- **AI health advisor:** a chat, powered by Gemini, that answers questions like "Can I jog at 6 PM near Dwarka?" using the app's live data.
- **Weather:** current conditions and a 7-day forecast, including rain chance, humidity, wind, cloud cover and UV.

## How it works

| Part | Technology |
|---|---|
| Backend | Python, FastAPI, NumPy |
| Frontend | HTML, CSS, JavaScript, Leaflet, leaflet-velocity |
| Air quality and place search | OpenWeather |
| Weather and wind | Open-Meteo |
| Parks | OpenStreetMap (Nominatim) |
| Map tiles | MapTiler |
| AI advisor | Gemini API |
| Cache and rate limiting | Upstash Redis |
| Hosting | Vercel |

NAQI is calculated from OpenWeather's pollutant levels using CPCB breakpoints, with 24-hour averages for PM2.5, PM10, NO₂, SO₂ and NH₃, and 8-hour averages for CO and O₃. The overall value is the highest pollutant sub-index.

## Run locally

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12 or later.

1. Copy the example environment file, then add your API keys to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Start the app, then open http://localhost:8000:

   ```bash
   uv run uvicorn main:app --reload
   ```

Upstash is optional locally: without it, the app uses an in-memory cache and no rate limiting.

To run the tests:

```bash
uv run pytest
```

## Limitations

- NAQI values are estimates from modelled pollution data, so they may differ from local monitoring stations.
- NAQI breakpoints should be checked against the current CPCB publication.
- The health profile limits are starting values and have not been clinically validated.
- Cleanest spots uses OpenStreetMap's free Nominatim service, which allows light use only, and parks named just "Park" are left out.

## Disclaimer

BreathEasy is not medical advice. Follow your doctor's guidance or your asthma action plan.
