import numpy as np
import pytest

from analysis import Profile, advice, category, grid, idw, naqi, score, verdict

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
    assert score(20, 18, 50, 10, 0, walker) == 96
    assert score(500, 45, 100, 60, 12, walker) == 0


@pytest.mark.parametrize("profile", [Profile(), Profile(activity="run"), Profile(age="senior"), Profile(asthma=True)])
@pytest.mark.parametrize("weather", [(18, 50, 10, 0), (45, 100, 60, 12)])  # perfect and terrible
def test_score_always_agrees_with_the_verdict(profile, weather):
    bands = {"safe": (70, 100), "caution": (40, 69), "avoid": (0, 39)}
    for value in range(0, 501, 5):
        low, high = bands[verdict(value, profile)]
        assert low <= score(value, *weather, profile) <= high


def test_score_falls_as_air_worsens_and_weather_only_lowers_it():
    asthma = Profile(asthma=True)
    scores = [score(v, 18, 50, 10, 0, asthma) for v in range(0, 501, 5)]
    assert scores == sorted(scores, reverse=True)
    assert score(88, 18, 50, 10, 0, asthma) > score(88, 42, 95, 40, 9, asthma) >= 40


def test_grid_snaps_and_refuses_large_boxes():
    lats, lons, step = grid(28.51, 77.01, 28.69, 77.29, 3)
    assert step == 0.1 and lats == [28.5, 28.6, 28.7] and lons[0] == 77.0 and lons[-1] == 77.3
    assert grid(0, 0, 20, 20, 3) is None


def test_idw_reproduces_samples():
    values = np.array([[10.0, 30.0]])
    out = idw([(0, 0), (0, 1)], values, [0], [0, 0.5, 1])
    assert out[0] == pytest.approx([10, 20, 30])


ASTHMA = Profile(asthma=True)


def outlook(*values, profile=ASTHMA):
    return [{"local": f"Fri {14 + i}:00", "naqi": v, "verdict": verdict(v, profile)} for i, v in enumerate(values)]


def test_advice_suggests_a_later_hour_when_air_improves():
    text = advice(outlook(180, 150, 110, 70), 0)
    assert "You should avoid going outside right now." in text
    assert "better to go out at Fri 17:00, when NAQI should be around 70" in text


def test_advice_never_suggests_an_hour_that_is_still_avoid():
    text = advice(outlook(180, 150, 150, 150, 150, 150, 150, 50), 0)
    assert "isn't expected to improve" in text and "Fri 21:00" not in text


@pytest.mark.parametrize("profile", [Profile(), Profile(asthma=True)])
def test_advice_is_firm_above_300_for_every_profile(profile):
    assert "You SHOULD NOT be going outside right now unless it is absolutely essential." in advice(outlook(340, profile=profile), 0)


def test_advice_is_friendly_otherwise_and_always_covers_vehicles():
    rows = outlook(40, 80)
    assert "go ahead" in advice(rows, 0) and "okay" in advice(rows, 1) and "at Fri 15:00" in advice(rows, 1)
    assert all("car or similar vehicle" in advice(rows, i) for i in range(2))
