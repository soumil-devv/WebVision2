"use strict";

// The ground and ink of the page for each CPCB category, and the stronger colours used on the map and timeline.
const AIR = [["#9bdcb2", "#0b2a1b"], ["#cfe68a", "#232c08"], ["#f5dc66", "#352800"], ["#f4a057", "#351400"], ["#c9302a", "#fff5f0"], ["#5f1220", "#ffe9e4"]];
const SCALE = ["#1fa85f", "#9ccc3c", "#f2c81e", "#f0801f", "#d62a1f", "#7d0f22"];
const NAMES = ["Good", "Satisfactory", "Moderate", "Poor", "Very poor", "Severe"];
const STOPS = [25, 75, 150, 250, 350, 450]; // the middle of each category, for smooth colour between them
const POLLUTANT = { pm2_5: "PM2.5", pm10: "PM10", no2: "NO₂", o3: "ozone", co: "CO", so2: "SO₂", nh3: "ammonia" };
const SKY = [[0, "Clear"], [3, "Partly cloudy"], [48, "Fog"], [57, "Drizzle"], [67, "Rain"], [77, "Snow"], [82, "Showers"], [99, "Thunderstorm"]];
const STILL = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (selector) => document.querySelector(selector);
const level = (naqi) => [50, 100, 200, 300, 400].filter((b) => naqi > b).length;
const sky = (code) => (SKY.find(([max]) => code <= max) || [0, "Unknown"])[1];

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
    throw new Error("We can't reach the network. Check your connection and try again.");
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

const state = { lat: 28.6139, lon: 77.209, place: "New Delhi", profile: loadProfile(), hours: [], best: null, airLevel: null };
const hourIndex = () => +$("#hour").value;

// ---------- The air: colour of the page and the particles in it ----------
function setAir(naqi, flood = false) {
  const lv = level(naqi);
  if (lv === state.airLevel) return;
  const [ground, ink] = AIR[lv], root = document.documentElement.style, first = state.airLevel === null;
  state.airLevel = lv;
  root.setProperty("--ink", ink);
  $('meta[name="theme-color"]').content = ground;
  drawParticles();
  if (!flood || STILL) return root.setProperty("--air", ground);
  // The new air spreads out from the middle of the screen, like a breath.
  const layer = $("#flood");
  layer.style.background = ground;
  layer.style.visibility = "visible";
  layer.animate([{ clipPath: "circle(0% at 50% 42%)" }, { clipPath: "circle(150% at 50% 42%)" }],
    { duration: first ? 1800 : 1200, easing: "cubic-bezier(.16, 1, .3, 1)" }).finished.then(() => {
    root.setProperty("--air", ground);
    layer.style.visibility = "hidden";
  });
}

const canvas = $("#particles"), pen = canvas.getContext("2d");
let specks = [];
function sizeCanvas() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  specks = Array.from({ length: 700 }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: 1 + Math.random() * 2.4, drift: .5 + Math.random() }));
  drawParticles();
}
function drawParticles() {
  const row = state.hours[hourIndex()], count = row ? Math.min(40 + row.naqi * 1.3, specks.length) : 40;
  pen.clearRect(0, 0, canvas.width, canvas.height);
  pen.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--ink");
  pen.globalAlpha = .42;
  for (let i = 0; i < count; i++) pen.fillRect(specks[i].x, specks[i].y, specks[i].r, specks[i].r);
}
function moveParticles() {
  const row = state.hours[hourIndex()];
  if (row) {
    // Wind direction is where it blows from, so the air moves the opposite way.
    const angle = row.wind_dir * Math.PI / 180, speed = .12 + row.wind_kmh * .05;
    for (const s of specks) {
      s.x = (s.x - Math.sin(angle) * speed * s.drift + innerWidth) % innerWidth;
      s.y = (s.y + Math.cos(angle) * speed * s.drift + innerHeight) % innerHeight;
    }
    drawParticles();
  }
  requestAnimationFrame(moveParticles);
}

// ---------- The answer for the chosen hour ----------
function headline(row, now) {
  if (row.naqi > 300) return "Stay inside unless you must.";
  if (row.verdict === "avoid") return now ? "Better to stay in for now." : "Better to stay in then.";
  return row.verdict === "caution" ? "Go out, but take it easy." : "You're fine to go out.";
}

function showHour(flood = false) {
  const h = hourIndex(), row = state.hours[h], stamp = grid ? grid.hours[h] : Math.floor(Date.now() / 3.6e6) * 3600 + h * 3600;
  $("#thumb").style.left = `calc(${(h + .5) / 48 * 100}% - 1.5px)`;
  $("#hour-label").textContent = row ? (h ? row.local : "Right now") : new Date(stamp * 1000).toLocaleString([], { weekday: "short", hour: "numeric" });
  paintField(h);
  if (velocity && wind) velocity.setData(windData(h));
  if (!row) return;
  $("#hour").setAttribute("aria-valuetext", `${row.local}, NAQI ${row.naqi}, ${row.category}`);
  setAir(row.naqi, flood);
  $("#verdict").textContent = headline(row, h === 0);
  $("#reading").textContent = `NAQI ${row.naqi} in ${state.place} ${h ? `on ${row.local}` : "right now"}. ${row.category}, mostly ${POLLUTANT[row.dominant] || row.dominant}.`;
  $("#advice").textContent = row.advice;
  $("#stats").replaceChildren(...[["Temperature", `${Math.round(row.temp)}°C`], ["Chance of rain", `${row.rain_chance}%`], ["Humidity", `${row.humidity}%`],
    ["Wind", `${Math.round(row.wind_kmh)} km/h`], ["Cloud cover", `${row.clouds}%`], ["UV", `${Math.round(row.uv)}`]]
    .map(([name, value]) => el("div", {}, el("dt", {}, name), el("dd", {}, value))));
}

function renderWindow(w) {
  Object.assign(state, { hours: w.hours, best: w.best });
  $("#bars").replaceChildren(...w.hours.map((r) => el("span", { style: `height:${Math.max(r.score, 8)}%;background:${SCALE[level(r.naqi)]};opacity:${r.verdict === "avoid" ? .45 : 1}` })));
  const good = w.best.verdict !== "avoid";
  $("#best").textContent = good ? `Best in the next 24 hours: ${w.best.local}` : "No good window in the next 24 hours";
  $("#best").disabled = !good;
  showHour(true);
}

function failWindow(error) {
  Object.assign(state, { hours: [], best: null });
  $("#verdict").textContent = "We can't read the air right now.";
  $("#reading").replaceChildren();
  $("#advice").replaceChildren(el("span", { className: "error" }, `${error.message} `), el("button", { className: "link", onclick: refreshPlace }, "Try again"));
  $("#stats").replaceChildren();
  $("#bars").replaceChildren();
  $("#best").textContent = "";
}

$("#best").onclick = () => {
  $("#hour").value = Math.max(state.hours.findIndex((r) => r.time === state.best.time), 0);
  showHour();
};

// ---------- Map ----------
const map = L.map("map", { preferCanvas: true, scrollWheelZoom: false }).setView([state.lat, state.lon], 11);
const marker = L.circleMarker([state.lat, state.lon], { radius: 9, color: "#12171a", weight: 3, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
const spotLayer = L.layerGroup().addTo(map);
let grid = null, field = null, wind = null, velocity = null, loadId = 0, placeId = 0;

$("#legend").append(...NAMES.map((name, i) => el("span", { className: i > 3 ? "dark" : "", style: `background:${SCALE[i]}` }, name)));

// Mix the two nearest category colours, so the map reads as one continuous air field.
const channels = SCALE.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
function fieldColor(naqi) {
  const upper = STOPS.findIndex((s) => naqi < s);
  if (upper <= 0) return channels[upper < 0 ? channels.length - 1 : 0];
  const t = (naqi - STOPS[upper - 1]) / (STOPS[upper] - STOPS[upper - 1]);
  return channels[upper].map((c, i) => channels[upper - 1][i] + (c - channels[upper - 1][i]) * t);
}

const fieldCanvas = document.createElement("canvas");
function paintField(h) {
  if (!grid) return;
  const { rows, cols, south, west, size, frames } = grid, draw = fieldCanvas.getContext("2d");
  Object.assign(fieldCanvas, { width: cols, height: rows });
  const image = draw.createImageData(cols, rows);
  frames[h].forEach((naqi, k) => {
    // Grid rows run south to north; image rows run top to bottom.
    const y = rows - 1 - Math.floor(k / cols), at = (y * cols + k % cols) * 4;
    image.data.set([...fieldColor(naqi), 255], at);
  });
  draw.putImageData(image, 0, 0);
  const bounds = [[south, west], [south + rows * size, west + cols * size]], url = fieldCanvas.toDataURL();
  if (!field) field = L.imageOverlay(url, bounds, { opacity: .62, className: "air-field" }).addTo(map);
  else field.setBounds(bounds).setUrl(url);
}

const windData = (h) => ["u", "v"].map((key, n) => ({
  header: { ...wind.header, parameterCategory: 2, parameterNumber: 2 + n, refTime: new Date(wind.hours[h] * 1000).toISOString() },
  data: wind[key][h],
}));

function showWind() {
  if (!$("#wind-toggle").checked || !wind) return;
  if (velocity) return velocity.setData(windData(hourIndex()));
  velocity = L.velocityLayer({
    data: windData(hourIndex()), displayValues: false, maxVelocity: 15,
    velocityScale: 0.01, lineWidth: 1.5, colorScale: ["rgba(18, 23, 26, .8)"],
  }).addTo(map);
}

async function loadLayers() {
  const id = ++loadId, b = map.getBounds();
  const clamp = (lon) => Math.min(Math.max(lon, -180), 180);
  const query = `south=${b.getSouth()}&west=${clamp(b.getWest())}&north=${b.getNorth()}&east=${clamp(b.getEast())}`;
  const wantWind = $("#wind-toggle").checked;
  setStatus("Reading the air on the map…");
  const [aq, wd] = await Promise.allSettled([api(`naqi/grid?${query}`), wantWind ? api(`wind/grid?${query}`) : null]);
  if (id !== loadId) return; // a newer request superseded this one
  grid = aq.status === "fulfilled" ? aq.value : null;
  if (!grid && field) { field.remove(); field = null; }
  paintField(hourIndex());
  if (wantWind) wind = wd.status === "fulfilled" ? wd.value : null;
  showWind();
  const failed = [aq, wd].find((r) => r.status === "rejected");
  setStatus(failed ? failed.reason.message : "");
}

let moveTimer;
map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = setTimeout(loadLayers, 400); });
map.on("click", (e) => setLocation(e.latlng.wrap().lat, e.latlng.wrap().lng, "this spot"));

$("#hour").oninput = () => showHour();
$("#wind-toggle").onchange = () => {
  if (velocity) { velocity.remove(); velocity = null; }
  if ($("#wind-toggle").checked) loadLayers();
};
let playTimer = null;
$("#play").onclick = () => {
  const playing = !playTimer;
  clearInterval(playTimer);
  playTimer = playing ? setInterval(() => { $("#hour").value = (hourIndex() + 1) % 48; showHour(); }, 600) : null;
  $("#play-shape").setAttribute("d", playing ? "M7 4h3v16H7zM14 4h3v16h-3z" : "M7 4l13 8-13 8z");
  $("#play").setAttribute("aria-label", playing ? "Pause" : "Play the next 48 hours");
};

// ---------- Parks and the week ----------
function renderSpots(spots) {
  spotLayer.clearLayers();
  if (!spots.length) return $("#spots").replaceChildren(el("li", {}, "We couldn't find a named park within 4 km of here."));
  $("#spots").replaceChildren(...spots.map((s) => {
    L.circleMarker([s.lat, s.lon], { radius: 7, color: "#12171a", weight: 2, fillColor: SCALE[level(s.naqi)], fillOpacity: 1 }).bindTooltip(s.name).addTo(spotLayer);
    return el("li", {},
      el("button", { className: "link", onclick: () => map.flyTo([s.lat, s.lon], 15) }, s.name),
      el("span", {}, `${s.distance_km} km away. NAQI ${s.naqi}, ${{ safe: "good for you", caution: "okay with care", avoid: "better avoided" }[s.verdict]} now.`));
  }));
}

function renderWeek(w) {
  const d = w.daily;
  $("#days").replaceChildren(...d.time.map((t, i) => el("div", { className: "day" },
    el("strong", {}, new Date((t + w.utc_offset_seconds) * 1000).toLocaleDateString([], { weekday: "short", timeZone: "UTC" })),
    el("span", {}, sky(d.weather_code[i])),
    el("span", {}, `${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°`),
    el("span", {}, `Rain ${d.precipitation_probability_max[i] ?? 0}%`))));
}

// ---------- Choosing a place and a profile ----------
function refreshPlace() {
  const id = ++placeId, body = { lat: state.lat, lon: state.lon, profile: state.profile };
  const current = (render) => (value) => { if (id === placeId) render(value); };
  const message = (selector, tag) => current((e) => $(selector).replaceChildren(el(tag, { className: "error" }, e.message)));
  api(`weather?lat=${state.lat}&lon=${state.lon}`).then(current(renderWeek), message("#days", "p"));
  api("safe-window", body).then(current(renderWindow), current(failWindow));
  api("safe-spots", body).then(current(renderSpots), message("#spots", "li"));
}

function setLocation(lat, lon, place, fly = false) {
  Object.assign(state, { lat: +lat.toFixed(4), lon: +lon.toFixed(4), place });
  marker.setLatLng([state.lat, state.lon]);
  if (fly) map.setView([state.lat, state.lon], 12);
  $("#hour").value = 0;
  refreshPlace();
}

$("#search").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const places = await api(`geocode?q=${encodeURIComponent($("#q").value.trim())}`);
    $("#results").replaceChildren(...(places.length ? places.map((p) => el("li", {},
      el("button", { className: "link", onclick: () => { $("#results").replaceChildren(); $("#q").value = ""; setLocation(p.lat, p.lon, p.name, true); } },
        [p.name, p.state, p.country].filter(Boolean).join(", ")))) : [el("li", {}, "We couldn't find that place. Try a nearby city.")]));
  } catch (error) {
    $("#results").replaceChildren(el("li", {}, error.message));
  }
};

$("#locate").onclick = () => {
  if (!navigator.geolocation) return setStatus("Your browser can't share a location. Search for a place instead.");
  navigator.geolocation.getCurrentPosition(
    (p) => setLocation(p.coords.latitude, p.coords.longitude, "your location", true),
    () => setStatus("We couldn't get your location. Search for a place instead."));
};

const profileForm = $("#profile");
profileForm.asthma.value = state.profile.asthma ? "1" : "";
profileForm.age.value = state.profile.age;
profileForm.activity.value = state.profile.activity;
profileForm.onchange = () => {
  state.profile = { asthma: !!profileForm.asthma.value, age: profileForm.age.value, activity: profileForm.activity.value };
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
$("#chat-close").onclick = () => { $("#chat").hidden = true; $("#chat-open").hidden = false; $("#chat-open").focus(); };
document.querySelectorAll("#starters button").forEach((b) => { b.onclick = () => { $("#msg").value = b.textContent; $("#chat-form").requestSubmit(); }; });
$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#msg").value.trim(), send = $("#chat-form button");
  if (!text || send.disabled) return;
  $("#msg").value = "";
  send.disabled = true;
  $("#starters")?.remove();
  addMessage("user", text);
  chatHistory.push({ role: "user", text });
  const pending = addMessage("model", "Checking the live air…");
  try {
    // An odd-length tail of the alternating chatHistory always starts with a user message.
    const place = `${text}\n(The user's chosen place is ${state.place}.)`;
    const { reply } = await api("chat", { lat: state.lat, lon: state.lon, profile: state.profile, messages: [...chatHistory.slice(-19, -1), { role: "user", text: place }] });
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
    ? [`https://api.maptiler.com/maps/dataviz/256/{z}/{x}/{y}.png?key=${key}`, `<a href="https://www.maptiler.com/copyright/">© MapTiler</a> ${osm}`]
    : ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", osm];
  L.tileLayer(url, { attribution, maxZoom: 19 }).addTo(map);
});
addEventListener("resize", sizeCanvas);
sizeCanvas();
if (!STILL) moveParticles();
showHour();
refreshPlace();
loadLayers();
