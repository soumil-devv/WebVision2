"""External data sources (OpenWeather, Open-Meteo, Nominatim) behind one small cache."""

import asyncio
import json
import logging
import math
import os
import time

import httpx
from upstash_redis.asyncio import Redis

log = logging.getLogger("webvision")

OWM = "https://api.openweathermap.org"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
POLLUTANTS = ("pm2_5", "pm10", "no2", "o3", "co", "so2", "nh3")

# Upstash when configured (shared across serverless instances), else a per-instance dict.
redis = Redis(os.environ["UPSTASH_KV_REST_API_URL"], os.environ["UPSTASH_KV_REST_API_TOKEN"]) if os.getenv("UPSTASH_KV_REST_API_URL") else None
_memory: dict[str, tuple[float, object]] = {}


async def cached(key, ttl, fetch):
    """Return the cached value for key, or await fetch() and cache it. Cache failures never fail a request."""
    try:
        if redis:
            if (hit := await redis.get(key)) is not None:
                return json.loads(hit)
        elif (hit := _memory.get(key)) and hit[0] > time.time():
            return hit[1]
    except Exception as e:  # noqa: BLE001 - a broken cache must not fail the request
        log.warning("cache read failed for %s: %s", key, e)
    value = await fetch()
    try:
        if redis:
            await redis.set(key, json.dumps(value), ex=ttl)
        else:
            if len(_memory) > 5000:
                _memory.clear()
            _memory[key] = (time.time() + ttl, value)
    except Exception as e:  # noqa: BLE001 - a broken cache must not fail the request
        log.warning("cache write failed for %s: %s", key, e)
    return value


async def get_json(url, timeout=20, **params):
    """GET a JSON document; raises httpx.HTTPError on network errors and non-2xx responses."""
    headers = {"User-Agent": "WebVision2 (https://github.com/soumil-devv/WebVision2)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json()


async def air_series(lat, lon):
    """Hourly pollutant concentrations (µg/m³) for the past 25 h plus the ~4-day forecast."""
    lat, lon = round(lat, 2), round(lon, 2)

    async def fetch():
        now, key = int(time.time()), os.getenv("OPENWEATHER_API_KEY")
        history, forecast = await asyncio.gather(
            get_json(f"{OWM}/data/2.5/air_pollution/history", lat=lat, lon=lon, start=now - 25 * 3600, end=now, appid=key),
            get_json(f"{OWM}/data/2.5/air_pollution/forecast", lat=lat, lon=lon, appid=key),
        )
        rows = {e["dt"]: e["components"] for e in history["list"] + forecast["list"]}
        times = sorted(rows)
        return {"t": times, **{p: [rows[t].get(p, 0.0) for t in times] for p in POLLUTANTS}}

    return await cached(f"aq:{lat},{lon}", 3600, fetch)


async def weather(lat, lon):
    """Current, hourly and 7-day weather in the location's local timezone, times as unix seconds."""
    lat, lon = round(lat, 2), round(lon, 2)
    return await cached(f"wx:{lat},{lon}", 1800, lambda: get_json(
        OPEN_METEO, latitude=lat, longitude=lon, timezone="auto", timeformat="unixtime", forecast_days=7,
        current="temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,"
                "wind_speed_10m,wind_direction_10m,uv_index,weather_code",
        hourly="temperature_2m,relative_humidity_2m,precipitation_probability,cloud_cover,wind_speed_10m,uv_index",
        daily="weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max",
    ))


async def wind(points):
    """Hourly 10 m wind (m/s, direction in degrees) for many points in one request, times in UTC."""
    key = "wind:" + ";".join(f"{a:g},{b:g}" for a, b in points)

    async def fetch():
        data = await get_json(
            OPEN_METEO, latitude=",".join(f"{a:g}" for a, _ in points), longitude=",".join(f"{b:g}" for _, b in points),
            hourly="wind_speed_10m,wind_direction_10m", forecast_days=3, wind_speed_unit="ms", timeformat="unixtime",
        )
        return [d["hourly"] for d in (data if isinstance(data, list) else [data])]

    return await cached(key, 1800, fetch)


async def geocode(query):
    """Up to 5 places matching a name, via OpenWeather geocoding."""
    places = await get_json(f"{OWM}/geo/1.0/direct", q=query, limit=5, appid=os.getenv("OPENWEATHER_API_KEY"))
    return [{k: p.get(k) for k in ("name", "state", "country", "lat", "lon")} for p in places]


async def parks(lat, lon, radius_km=4):
    """Named parks around a point, from OpenStreetMap's Nominatim search. Cached, as its usage policy asks."""
    lat, lon = round(lat, 3), round(lon, 3)
    dlat, dlon = radius_km / 111.32, radius_km / (111.32 * math.cos(math.radians(lat)))

    async def fetch():
        found = await get_json(NOMINATIM, timeout=10, q="park", format="jsonv2", limit=40, bounded=1,
                               viewbox=f"{lon - dlon},{lat + dlat},{lon + dlon},{lat - dlat}")
        # Many small parks are named just "Park", which tells the user nothing.
        return [{"name": p["name"], "lat": float(p["lat"]), "lon": float(p["lon"])} for p in found
                if p.get("category") == "leisure" and p.get("name", "").lower() not in ("", "park")]

    return await cached(f"parks:{lat},{lon}", 86400, fetch)
