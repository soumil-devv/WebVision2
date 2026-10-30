"""Pure calculations: India's National AQI, health-profile limits, exercise scores and map grids."""

import math
from bisect import bisect_left
from typing import Literal

import numpy as np
from pydantic import BaseModel

# CPCB NAQI breakpoints: concentration (µg/m³, CO in mg/m³) at each index boundary below, and the
# averaging window in hours. CPCB leaves "Severe" open-ended, so its upper end extends the width of
# "Very poor" to make 500 reachable. Check against the current CPCB publication before launch.
INDEX = [0, 50, 100, 200, 300, 400, 500]
BREAKPOINTS = {
    "pm2_5": ([0, 30, 60, 90, 120, 250, 380], 24),
    "pm10": ([0, 50, 100, 250, 350, 430, 510], 24),
    "no2": ([0, 40, 80, 180, 280, 400, 520], 24),
    "o3": ([0, 50, 100, 168, 208, 748, 1288], 8),
    "co": ([0, 1, 2, 10, 17, 34, 51], 8),
    "so2": ([0, 40, 80, 380, 800, 1600, 2400], 24),
    "nh3": ([0, 200, 400, 800, 1200, 1800, 2400], 24),
}
CATEGORIES = ["Good", "Satisfactory", "Moderately polluted", "Poor", "Very poor", "Severe"]


def naqi(series):
    """Hourly NAQI for an air series: rolling averages -> sub-index per pollutant -> max.

    Returns (unix times, NAQI ints, dominant pollutant names), aligned with series["t"].
    """
    t = np.array(series["t"])
    # in_window(h)[i, j]: sample j falls in the h-hour averaging window ending at sample i.
    in_window = lambda hours: (t[None, :] <= t[:, None]) & (t[None, :] > t[:, None] - hours * 3600)
    subs = []
    for name, (bounds, hours) in BREAKPOINTS.items():
        x = np.array(series[name], float) / (1000 if name == "co" else 1)
        w = in_window(hours)
        subs.append(np.interp(w @ x / w.sum(1), bounds, INDEX))
    subs = np.array(subs)
    names = list(BREAKPOINTS)
    return t, subs.max(0).round().astype(int), [names[i] for i in subs.argmax(0)]


def category(value):
    """CPCB category name: Good ≤ 50, Satisfactory ≤ 100, ... Severe > 400."""
    return CATEGORIES[bisect_left([50, 100, 200, 300, 400], value)]


class Profile(BaseModel):
    asthma: bool = False
    age: Literal["child", "adult", "senior"] = "adult"
    activity: Literal["walk", "jog", "run", "cycle"] = "walk"


def limits(profile):
    """(highest 'safe' NAQI, NAQI above which to avoid exercise) for a profile."""
    if profile.asthma:
        return 50, 100
    if profile.age != "adult":
        return 100, 150
    return (150, 250) if profile.activity == "walk" else (100, 200)


def verdict(value, profile):
    safe, avoid = limits(profile)
    return "safe" if value <= safe else "avoid" if value > avoid else "caution"


# The score range for each verdict, so the number always agrees with the words.
SCORE_BANDS = {"safe": (70, 100), "caution": (40, 69), "avoid": (0, 39)}


def score(value, temp, humidity, wind_kmh, uv, profile):
    """0-100 exercise score. NAQI places it within its verdict's band; bad weather lowers it towards the band's floor."""
    safe, avoid = limits(profile)
    floor, top = SCORE_BANDS[verdict(value, profile)]
    air = min(np.interp(value, [0, safe, avoid, 500], [100, 70, 40, 0]), top)
    clamp = lambda x: min(max(x, 0.0), 1.0)
    weather = (.375 * clamp((abs(temp - 18) - 8) / 12)  # comfortable between 10 and 26 °C
               + .25 * clamp((humidity - 70) / 30)
               + .25 * clamp(uv / 10)
               + .125 * clamp((wind_kmh - 20) / 30))
    return round(float(floor + (air - floor) * (1 - weather)))


def advice(rows, i):
    """Friendly recommendation for hour i of an outlook, firm when the air is Very poor or Severe."""
    row, when = rows[i], "right now" if i == 0 else f"at {rows[i]['local']}"
    if row["verdict"] == "safe":
        text = f"It should be fine for you to go outside {when}, so go ahead and enjoy it."
    elif row["verdict"] == "caution":
        text = f"It should be okay to go outside {when}, but it would be wise to keep it shorter or easier."
    else:
        text = (f"You SHOULD NOT be going outside {when} unless it is absolutely essential." if row["naqi"] > 300
                else f"You should avoid going outside {when}.")
        later = next((r for r in rows[i + 1:i + 7] if r["verdict"] != "avoid"), None)
        text += (f" It would be better to go out at {later['local']}, when NAQI should be around {later['naqi']}." if later
                 else " The air isn't expected to improve enough in the next few hours.")
    return text + " This is about spending time outside in the open air; travelling in a car or similar vehicle would affect you much less."


STEPS = (0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0)


def grid(south, west, north, east, n):
    """Grid points snapped to a fixed step (so caches are shared), at most about (n + 2)² of them.

    Returns (lats ascending, lons ascending, step), or None when the box is too big to sample.
    """
    step = next((s for s in STEPS if max(north - south, east - west) / s <= n), None)
    if step is None:
        return None
    axis = lambda lo, hi: [round(i * step, 4) for i in range(math.floor(lo / step), math.ceil(hi / step) + 1)]
    return axis(south, north), axis(west, east), step


def idw(points, values, lats, lons):
    """Inverse-distance-weighted interpolation of values (hours x points) onto every (lat, lon) cell.

    Returns an array of shape (hours, len(lats) * len(lons)), cells in row-major order.
    """
    cells = np.array([(a, b) for a in lats for b in lons])
    distance = np.hypot(*(cells[:, None, :] - np.array(points)[None, :, :]).transpose(2, 0, 1)) + 1e-9
    weights = distance ** -2
    return np.array(values) @ (weights / weights.sum(1, keepdims=True)).T
