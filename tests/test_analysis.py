import numpy as np
import pytest

from analysis import Profile, category, grid, idw, naqi, score, verdict

POLLUTANTS = ("pm2_5", "pm10", "no2", "o3", "co", "so2", "nh3")


def series(hours=30, **constant):
    """Hourly series with constant concentrations (others zero)."""
    t = [3600 * i for i in range(hours)]
    return {"t": t, **{p: [constant.get(p, 0.0)] * hours for p in POLLUTANTS}}


@pytest.mark.parametrize("pollutant, concentration, expected", [
    ("pm2_5", 60, 100), ("pm2_5", 30, 50), ("pm10", 250, 200), ("o3", 168, 200),
    ("co", 10_000, 200),  # µg/m³ -> 10 mg/m³
    ("pm2_5", 1000, 500),  # beyond the scale is capped
])
def test_breakpoints(pollutant, concentration, expected):
    _, values, dominant = naqi(series(**{pollutant: concentration}))
    assert values[-1] == expected and dominant[-1] == pollutant


def test_24h_rolling_average():
    s = series(hours=48)
    s["pm2_5"][-1] = 240  # one spike: 24 h mean = 10 µg/m³ -> sub-index 16.7
    assert naqi(s)[1][-1] == 17


def test_category_boundaries():
    assert [category(v) for v in (0, 50, 51, 100, 101, 400, 401)] == [
        "Good", "Good", "Satisfactory", "Satisfactory", "Moderately polluted", "Very poor", "Severe"]


def test_same_naqi_differs_by_profile():
    walker, asthmatic_runner = Profile(), Profile(asthma=True, activity="run")
    assert verdict(110, walker) == "safe" and verdict(110, asthmatic_runner) == "avoid"
    assert score(20, 18, 50, 10, 0, walker) == 95
    assert score(500, 45, 100, 60, 12, walker) == 0


def test_grid_snaps_and_refuses_large_boxes():
    lats, lons, step = grid(28.51, 77.01, 28.69, 77.29, 3)
    assert step == 0.1 and lats == [28.5, 28.6, 28.7] and lons[0] == 77.0 and lons[-1] == 77.3
    assert grid(0, 0, 20, 20, 3) is None


def test_idw_reproduces_samples():
    values = np.array([[10.0, 30.0]])
    out = idw([(0, 0), (0, 1)], values, [0], [0, 0.5, 1])
    assert out[0] == pytest.approx([10, 20, 30])
