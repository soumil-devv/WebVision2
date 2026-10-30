"use strict";

// CPCB NAQI category colours and names: Good ≤50, Satisfactory ≤100, Moderately polluted ≤200, Poor ≤300, Very poor ≤400, Severe.
const COLORS = ["#00b050", "#92d050", "#ffff00", "#ff9900", "#ff0000", "#c00000"];
const NAMES = ["Good (0–50)", "Satisfactory (51–100)", "Moderate (101–200)", "Poor (201–300)", "Very poor (301–400)", "Severe (401+)"];
const VERDICT = { safe: "#2e9e5b", caution: "#e0a100", avoid: "#d9372b" };
const POLLUTANT = { pm2_5: "PM2.5", pm10: "PM10", no2: "NO₂", o3: "O₃", co: "CO", so2: "SO₂", nh3: "NH₃" };
const SKY = [[0, "Clear"], [3, "Partly cloudy"], [48, "Fog"], [57, "Drizzle"], [67, "Rain"], [77, "Snow"], [82, "Showers"], [99, "Thunderstorm"]];

const $ = (selector) => document.querySelector(selector);
const level = (naqi) => [50, 100, 200, 300, 400].filter((b) => naqi > b).length;
const sky = (code) => (SKY.find(([max]) => code <= max) || [0, "—"])[1];
const hourLabel = (unix) => new Date(unix * 1000).toLocaleString([], { weekday: "short", hour: "numeric" });

// Build an element; strings become text nodes, so API data is never parsed as HTML.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(path, body) {
  const options = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  let response;
  try {
    response = await fetch(`/api/${path}`, options);
  } catch {
    throw new Error("Network error. Check your connection.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status}).`);
  return data;
}

function setStatus(text) {
  $("#status").textContent = text;
  $("#status").hidden = !text;
}

function loadProfile() {
  try {
    return { asthma: false, age: "adult", activity: "walk", ...JSON.parse(localStorage.getItem("profile") || "{}") };
  } catch {
    return { asthma: false, age: "adult", activity: "walk" };
  }
}

const state = { lat: 28.6139, lon: 77.209, profile: loadProfile() }; // default: New Delhi

// ---------- Map ----------
const map = L.map("map", { preferCanvas: true }).setView([state.lat, state.lon], 11);
const marker = L.marker([state.lat, state.lon]).addTo(map);
const spotLayer = L.layerGroup().addTo(map);
let grid = null, cells = [], wind = null, velocity = null, loadId = 0;

$("#legend").append(el("strong", {}, "NAQI"), ...COLORS.map((c, i) => el("div", {}, el("i", { style: `background:${c}` }), NAMES[i])));

function drawGrid() {
  cells.forEach((c) => c.remove());
  cells = [];
  if (!grid) return;
  const { south, west, size, rows, cols } = grid;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const bounds = [[south + i * size, west + j * size], [south + (i + 1) * size, west + (j + 1) * size]];
      cells.push(L.rectangle(bounds, { stroke: false, fillOpacity: 0.45, interactive: false }).addTo(map));
    }
  }
  showHour();
}

const windData = (h) => ["u", "v"].map((key, n) => ({
  header: { ...wind.header, parameterCategory: 2, parameterNumber: 2 + n, refTime: new Date(wind.hours[h] * 1000).toISOString() },
  data: wind[key][h],
}));

function showHour() {
  const h = +$("#hour").value;
  $("#hour-label").textContent = hourLabel(grid ? grid.hours[h] : Math.floor(Date.now() / 3.6e6) * 3600 + h * 3600);
  if (grid) cells.forEach((c, k) => c.setStyle({ fillColor: COLORS[level(grid.frames[h][k])] }));
  if (velocity && wind) velocity.setData(windData(h));
}

function showWind() {
  if (!$("#wind-toggle").checked || !wind) return;
  if (velocity) return velocity.setData(windData(+$("#hour").value));
  velocity = L.velocityLayer({
    data: windData(+$("#hour").value), displayValues: false, maxVelocity: 15,
    velocityScale: 0.01, lineWidth: 1.5, colorScale: ["rgba(20, 24, 30, 0.75)"],
  }).addTo(map);
}

async function loadLayers() {
  const id = ++loadId, b = map.getBounds();
  const clamp = (lon) => Math.min(Math.max(lon, -180), 180);
  const query = `south=${b.getSouth()}&west=${clamp(b.getWest())}&north=${b.getNorth()}&east=${clamp(b.getEast())}`;
  const wantWind = $("#wind-toggle").checked;
  setStatus("Loading air-quality map…");
  const [aq, wd] = await Promise.allSettled([api(`naqi/grid?${query}`), wantWind ? api(`wind/grid?${query}`) : null]);
  if (id !== loadId) return; // a newer request superseded this one
  grid = aq.status === "fulfilled" ? aq.value : null;
  drawGrid();
  if (wantWind) wind = wd.status === "fulfilled" ? wd.value : null;
  showWind();
  const failed = [aq, wd].find((r) => r.status === "rejected");
  setStatus(failed ? failed.reason.message : "");
}

let moveTimer;
map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = setTimeout(loadLayers, 400); });
map.on("click", (e) => setLocation(e.latlng.wrap().lat, e.latlng.wrap().lng));

$("#hour").oninput = showHour;
$("#wind-toggle").onchange = () => {
  if (velocity) { velocity.remove(); velocity = null; }
  if ($("#wind-toggle").checked) loadLayers();
};
let playTimer = null;
$("#play").onclick = () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    $("#play").textContent = "▶";
    return;
  }
  $("#play").textContent = "❚❚";
  playTimer = setInterval(() => { $("#hour").value = (+$("#hour").value + 1) % 48; showHour(); }, 700);
};

// ---------- Location panel ----------
const stat = (name, value) => [el("dt", {}, name), el("dd", {}, value)];
const fail = (selector, error) => $(selector).replaceChildren(el("p", { className: "error" }, error.message));

function renderWeather(w) {
  const c = w.current, d = w.daily;
  $("#wx-now").replaceChildren(
    el("div", { className: "row" },
      el("div", { className: "temp" }, `${Math.round(c.temperature_2m)}°C`),
      el("div", {}, el("strong", {}, sky(c.weather_code)), el("p", { className: "muted" }, `Feels like ${Math.round(c.apparent_temperature)}°C`))),
    el("dl", { className: "stats" },
      ...stat("Humidity", `${c.relative_humidity_2m}%`), ...stat("Rain today", `${d.precipitation_probability_max[0] ?? "–"}%`),
      ...stat("Wind", `${Math.round(c.wind_speed_10m)} km/h`), ...stat("Clouds", `${c.cloud_cover}%`),
      ...stat("UV", `${c.uv_index ?? "–"}`), ...stat("Rain now", `${c.precipitation} mm`)));
  $("#days").replaceChildren(...d.time.map((t, i) => el("div", { className: "day" },
    el("strong", {}, new Date((t + w.utc_offset_seconds) * 1000).toLocaleDateString([], { weekday: "short", timeZone: "UTC" })),
    el("span", {}, sky(d.weather_code[i])),
    el("span", {}, `${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°`),
    el("span", { className: "muted" }, `☂ ${d.precipitation_probability_max[i] ?? "–"}%`))));
}

function renderWindow(w) {
  const now = w.hours[0], lv = level(now.naqi);
  $("#aqi-now").replaceChildren(
    el("div", { className: "badge", style: `background:${COLORS[lv]};color:${lv >= 4 ? "#fff" : "#111"}` }, String(now.naqi)),
    el("div", {}, el("strong", {}, `NAQI · ${now.category}`),
      el("p", { className: "muted" }, `Main pollutant ${POLLUTANT[now.dominant]} · `, el("span", { style: `color:${VERDICT[now.verdict]}` }, now.verdict), " for you now")));
  const b = w.best;
  $("#best").textContent = `${b.local}: score ${b.score}/100, NAQI ${b.naqi} (${b.verdict}).`;
  $("#bars").replaceChildren(...w.hours.slice(0, 24).map((r) =>
    el("span", { title: `${r.local}: score ${r.score}, NAQI ${r.naqi}, ${r.verdict}`, style: `height:${r.score}%;background:${VERDICT[r.verdict]}` })));
  $("#limits").textContent = `For your profile: safe up to NAQI ${w.limits.safe}, avoid above ${w.limits.avoid}.`;
}

function renderSpots(spots) {
  spotLayer.clearLayers();
  if (!spots.length) return $("#spots").replaceChildren(el("li", { className: "muted" }, "No named parks found within 4 km."));
  $("#spots").replaceChildren(...spots.map((s) => {
    L.circleMarker([s.lat, s.lon], { radius: 7, color: VERDICT[s.verdict], weight: 3 }).bindTooltip(s.name).addTo(spotLayer);
    return el("li", {},
      el("button", { className: "link", onclick: () => map.flyTo([s.lat, s.lon], 15) }, s.name),
      el("span", { className: "muted" }, ` ${s.distance_km} km · NAQI ${s.naqi} · ${s.verdict}`));
  }));
}

function refreshPlace() {
  const body = { lat: state.lat, lon: state.lon, profile: state.profile };
  api(`weather?lat=${state.lat}&lon=${state.lon}`).then(renderWeather, (e) => fail("#wx-now", e));
  api("safe-window", body).then(renderWindow, (e) => { fail("#aqi-now", e); $("#best").textContent = ""; $("#bars").replaceChildren(); });
  api("safe-spots", body).then(renderSpots, (e) => fail("#spots", e));
}

function setLocation(lat, lon, fly = false) {
  Object.assign(state, { lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
  marker.setLatLng([state.lat, state.lon]);
  if (fly) map.setView([state.lat, state.lon], 12);
  refreshPlace();
}

$("#search").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const places = await api(`geocode?q=${encodeURIComponent($("#q").value.trim())}`);
    $("#results").replaceChildren(...(places.length ? places.map((p) => el("li", {},
      el("button", { className: "link", onclick: () => { $("#results").replaceChildren(); setLocation(p.lat, p.lon, true); } },
        [p.name, p.state, p.country].filter(Boolean).join(", ")))) : [el("li", { className: "muted" }, "No places found.")]));
  } catch (error) {
    $("#results").replaceChildren(el("li", { className: "error" }, error.message));
  }
};

$("#locate").onclick = () => {
  if (!navigator.geolocation) return setStatus("Location is not available in this browser.");
  navigator.geolocation.getCurrentPosition(
    (p) => setLocation(p.coords.latitude, p.coords.longitude, true),
    () => setStatus("Couldn't get your location. Search for a place instead."));
};

const profileForm = $("#profile");
profileForm.asthma.checked = state.profile.asthma;
profileForm.age.value = state.profile.age;
profileForm.activity.value = state.profile.activity;
profileForm.onchange = () => {
  state.profile = { asthma: profileForm.asthma.checked, age: profileForm.age.value, activity: profileForm.activity.value };
  try { localStorage.setItem("profile", JSON.stringify(state.profile)); } catch { /* storage unavailable: keep for this visit */ }
  refreshPlace();
};

// ---------- Chat ----------
const chatHistory = [];
const addMessage = (role, text) => {
  const node = el("p", { className: `msg ${role}` }, text);
  $("#log").append(node);
  node.scrollIntoView({ block: "end" });
  return node;
};
$("#chat-open").onclick = () => { $("#chat").hidden = false; $("#chat-open").hidden = true; $("#msg").focus(); };
$("#chat-close").onclick = () => { $("#chat").hidden = true; $("#chat-open").hidden = false; };
$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#msg").value.trim(), send = $("#chat-form button");
  if (!text || send.disabled) return;
  $("#msg").value = "";
  send.disabled = true;
  addMessage("user", text);
  chatHistory.push({ role: "user", text });
  const pending = addMessage("model", "Checking live data…");
  try {
    // An odd-length tail of the alternating chatHistory always starts with a user message.
    const { reply } = await api("chat", { lat: state.lat, lon: state.lon, profile: state.profile, messages: chatHistory.slice(-19) });
    pending.textContent = reply;
    chatHistory.push({ role: "model", text: reply });
  } catch (error) {
    pending.textContent = error.message;
    pending.classList.add("error");
    chatHistory.pop(); // keep user/model turns alternating
  }
  send.disabled = false;
};

// ---------- Start ----------
api("config").catch(() => ({})).then(({ maptiler_key: key }) => {
  const osm = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';
  const [url, attribution] = key
    ? [`https://api.maptiler.com/maps/openstreetmap/256/{z}/{x}/{y}.png?key=${key}`, `<a href="https://www.maptiler.com/copyright/">© MapTiler</a> ${osm}`]
    : ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", osm];
  L.tileLayer(url, { attribution, maxZoom: 19 }).addTo(map);
});
showHour();
refreshPlace();
loadLayers();
