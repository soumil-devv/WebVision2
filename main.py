"""WebVision2: FastAPI backend under /api, plus the static frontend in public/."""

import asyncio
import logging
import math
import os
import time
from pathlib import Path
from typing import Annotated, Literal

from dotenv import load_dotenv

load_dotenv()  # before importing modules that read the environment

import httpx
import numpy as np
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from google.genai.errors import APIError
from pydantic import BaseModel, Field
from upstash_ratelimit.asyncio import Ratelimit, SlidingWindow

import advisor
import services
from analysis import Profile, advice, category, grid, idw, limits, naqi, score, verdict

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO lines include request URLs, which carry API keys
log = logging.getLogger("webvision")

HOURS = 48
Lat = Annotated[float, Query(ge=-90, le=90)]
Lon = Annotated[float, Query(ge=-180, le=180)]
# Without Upstash (local development) requests are not rate limited.
ratelimit = (Ratelimit(redis=services.redis, limiter=SlidingWindow(max_requests=60, window=60), prefix="rl")
             if services.redis else None)


class Place(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    profile: Profile = Profile()


class Message(BaseModel):
    role: Literal["user", "model"]
    text: str = Field(min_length=1, max_length=2000)


class ChatRequest(Place):
    messages: list[Message] = Field(min_length=1, max_length=20)


async def rate_limit(request: Request):
    if not ratelimit:
        return
    forwarded = request.headers.get("x-forwarded-for")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    try:
        allowed = (await ratelimit.limit(ip)).allowed
    except Exception as e:  # noqa: BLE001 - never take the site down because the limiter is unreachable
        log.warning("rate limiter unavailable: %s", e)
        return
    if not allowed:
        raise HTTPException(429, "Too many requests. Please wait a minute and try again.")


def bbox(south: Lat, west: Lon, north: Lat, east: Lon):
    if south >= north or west >= east:
        raise HTTPException(422, "Invalid map bounds.")
    return south, west, north, east


def sample_grid(box, n):
    g = grid(*box, n)
    if not g:
        raise HTTPException(422, "Zoom in to see this layer.")
    return g


def next_hours():
    """Unix times of the current UTC hour and the following HOURS - 1 hours."""
    start = int(time.time()) // 3600 * 3600
    return [start + 3600 * k for k in range(HOURS)]


async def safe_window(lat, lon, profile):
    """Hourly NAQI, weather, score and verdict for the next 48 hours, in the location's local time."""
    wx, aq = await asyncio.gather(services.weather(lat, lon), services.air_series(lat, lon))
    t, values, dominant = naqi(aq)
    aq_index = {int(ti): i for i, ti in enumerate(t)}
    h, start = wx["hourly"], time.time() - 3600
    rows = []
    for i, ti in enumerate(h["time"]):
        # Air data is on UTC hours; local hours can be offset (e.g. :30 in India), so use the hour they fall in.
        j = aq_index.get(ti - ti % 3600)
        if ti <= start or j is None or len(rows) == HOURS:
            continue
        get = lambda key, default=0.0, i=i: default if h[key][i] is None else h[key][i]
        row = {"time": ti, "local": time.strftime("%a %H:%M", time.gmtime(ti + wx["utc_offset_seconds"])),
               "naqi": int(values[j]), "category": category(values[j]), "dominant": dominant[j],
               "temp": get("temperature_2m", 18.0), "humidity": get("relative_humidity_2m"),
               "rain_chance": get("precipitation_probability"), "wind_kmh": get("wind_speed_10m"), "uv": get("uv_index"),
               "verdict": verdict(values[j], profile)}
        row["score"] = score(row["naqi"], row["temp"], row["humidity"], row["wind_kmh"], row["uv"], profile)
        rows.append(row)
    if not rows:
        raise HTTPException(502, "No forecast is available for this location right now.")
    for i, row in enumerate(rows):
        row["advice"] = advice(rows, i)
    safe, avoid = limits(profile)
    # Suggest waking hours (5 AM - 9 PM local), preferring hours that aren't "avoid".
    awake = [r for r in rows[:24] if 5 <= time.gmtime(r["time"] + wx["utc_offset_seconds"]).tm_hour <= 21] or rows[:24]
    best = max(awake, key=lambda r: (r["verdict"] != "avoid", r["score"]))
    return {"limits": {"safe": safe, "avoid": avoid}, "best": best, "hours": rows}


async def safe_spots(lat, lon, profile):
    """The three named parks within 4 km with the lowest NAQI now (nearest first on ties)."""
    found = await services.parks(lat, lon)
    snap = lambda x: round(round(x / 0.05) * 0.05, 2)  # air data is coarse; share one sample per ~5 km
    keys = sorted({(snap(p["lat"]), snap(p["lon"])) for p in found})
    current = {}
    for key, series in zip(keys, await asyncio.gather(*(services.air_series(*k) for k in keys))):
        t, values, _ = naqi(series)
        current[key] = int(values[max(np.searchsorted(t, time.time(), "right") - 1, 0)])
    spots = [{**p, "naqi": (v := current[snap(p["lat"]), snap(p["lon"])]), "verdict": verdict(v, profile),
              "distance_km": round(111.32 * math.hypot(p["lat"] - lat, (p["lon"] - lon) * math.cos(math.radians(lat))), 1)}
             for p in found]
    unique = {}
    for s in sorted((s for s in spots if s["distance_km"] <= 4), key=lambda s: (s["naqi"], s["distance_km"])):
        unique.setdefault(s["name"], s)  # one entry per name (OSM often splits a park into parts)
    return list(unique.values())[:3]


api = APIRouter(prefix="/api", dependencies=[Depends(rate_limit)])


@api.get("/config")
def config():
    return {"maptiler_key": os.getenv("MAPTILER_KEY", "")}


@api.get("/geocode")
async def geocode(q: Annotated[str, Query(min_length=2, max_length=100)]):
    return await services.geocode(q)


@api.get("/weather")
async def weather(lat: Lat, lon: Lon):
    return await services.weather(lat, lon)


@api.post("/safe-window")
async def safe_window_route(place: Place):
    return await safe_window(place.lat, place.lon, place.profile)


@api.post("/safe-spots")
async def safe_spots_route(place: Place):
    return await safe_spots(place.lat, place.lon, place.profile)


@api.get("/naqi/grid")
async def naqi_grid(box: Annotated[tuple, Depends(bbox)]):
    """NAQI for the next 48 hours, interpolated onto a fine grid of cells covering the map view."""
    lats, lons, step = sample_grid(box, 3)
    points, hours, gate = [(a, b) for a in lats for b in lons], next_hours(), asyncio.Semaphore(8)

    async def sample(point):
        async with gate:  # stay within OpenWeather's per-minute limit
            try:
                t, values, _ = naqi(await services.air_series(*point))
                return np.interp(hours, t, values)
            except (httpx.HTTPError, KeyError, ValueError) as e:  # a missing sample only blurs the map
                log.warning("air sample %s failed: %r", point, e)

    samples = await asyncio.gather(*map(sample, points))
    valid = [(p, s) for p, s in zip(points, samples) if s is not None]
    if not valid:
        raise HTTPException(502, "Air-quality data is unavailable right now. Please try again shortly.")
    size, south, west = step / 4, lats[0] - step / 2, lons[0] - step / 2
    cell_lats = [south + (i + 0.5) * size for i in range(len(lats) * 4)]
    cell_lons = [west + (j + 0.5) * size for j in range(len(lons) * 4)]
    frames = idw([p for p, _ in valid], np.array([s for _, s in valid]).T, cell_lats, cell_lons)
    return {"south": south, "west": west, "size": size, "rows": len(cell_lats), "cols": len(cell_lons),
            "hours": hours, "frames": frames.round().astype(int).tolist()}


@api.get("/wind/grid")
async def wind_grid(box: Annotated[tuple, Depends(bbox)]):
    """Wind u/v components for the next 48 hours, in leaflet-velocity's grid layout (rows north to south)."""
    lats, lons, step = sample_grid(box, 6)
    lats, hours = lats[::-1], next_hours()
    u, v = [], []
    for h in await services.wind([(a, b) for a in lats for b in lons]):
        speed = np.array(h["wind_speed_10m"], float)
        angle = np.radians(np.array(h["wind_direction_10m"], float))  # direction the wind blows from
        u.append(np.interp(hours, h["time"], np.nan_to_num(-speed * np.sin(angle))))
        v.append(np.interp(hours, h["time"], np.nan_to_num(-speed * np.cos(angle))))
    frames = lambda x: np.array(x).T.round(2).tolist()  # hours x points
    return {"header": {"la1": lats[0], "lo1": lons[0], "dx": step, "dy": step, "nx": len(lons), "ny": len(lats)},
            "hours": hours, "u": frames(u), "v": frames(v)}


@api.post("/chat")
async def chat(request: ChatRequest):
    profile = request.profile

    async def find_place(name: str) -> list:
        """Find coordinates for a place name such as 'Dwarka, Delhi'. Returns up to 5 matches."""
        return await services.geocode(name)

    async def hourly_outlook(lat: float, lon: float) -> dict:
        """Hourly NAQI, dominant pollutant, weather, exercise score (0-100) and written advice for the next 48 hours at
        a location, in local time, for the user's health profile. The first row is the current hour; 'best' is the
        best hour in the next 24 hours."""
        return await safe_window(lat, lon, profile)

    async def safe_spots_near(lat: float, lon: float) -> list:
        """Up to three named parks within 4 km of a location with the cleanest air right now."""
        return await safe_spots(lat, lon, profile)

    tools = [find_place, hourly_outlook, safe_spots_near]
    return {"reply": await advisor.reply(request.messages, profile, request.lat, request.lon, tools)}


app = FastAPI(title="WebVision2")
app.add_middleware(GZipMiddleware, minimum_size=1000)


async def upstream_error(request, exc):
    log.warning("upstream error on %s: %r", request.url.path, exc)
    if isinstance(exc, APIError) and exc.code == 429:  # Gemini's request quota
        return JSONResponse({"detail": "The advisor is busy. Please try again in a minute."}, 429)
    return JSONResponse({"detail": "A data provider is unavailable right now. Please try again shortly."}, 502)


app.add_exception_handler(httpx.HTTPError, upstream_error)
app.add_exception_handler(APIError, upstream_error)
app.include_router(api)
# On Vercel, public/ is served by the CDN; this mount serves it during local development.
app.mount("/", StaticFiles(directory=Path(__file__).parent / "public", html=True, check_dir=False), name="static")
