/* Route Optimizer Lite - frontend logic (vanilla JS).
 *
 * All state lives in this module (browser memory only). Reloading the page
 * resets everything - there is no database.
 */

"use strict";

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */

const state = {
  startAddress: "",
  startValidation: null, // validation result for the start address
  stops: [],             // [{ id, address, status, formattedAddress, lat, lng,
                         //    matchedCity, message }]
  validated: false,      // last validation succeeded AND nothing changed since
  needsValidation: true, // list/start/city changed since last validation
  lastResult: null,      // last /api/optimize response
  groups: null,          // editable route groups: [{ stops:[...], optimized,
                         //   distanceMeters, durationSeconds, encodedPolylines,
                         //   reason, avgKm }]
  manualMode: false,     // next optimize should send mode "manual"
  optimizeStale: false,  // groups changed manually since last optimize
  // --- Visited Stops Tracker (frontend-only, localStorage-backed) ---
  trackGroups: null,     // normalized [{clusterIndex, title, clustered, stops}]
  visited: {},           // { stopKey: { visited: true, visitedAt: ISO } }
  routeSignature: null,  // localStorage key suffix for the current route
  trackingActive: false, // true once an optimized result is being tracked
  hideVisited: false,    // collapse visited rows from the list
  hideVisitedMarkers: false, // hide visited markers from the map
  clusterSizeSummary: null,  // {useMinMaxStops, min, max, allWithinMin/Max} from backend
};

let nextId = 1;

const MAX_STOPS = 50;

/* ---------------------------------------------------------------------------
 * DOM references
 * ------------------------------------------------------------------------- */

const el = {
  start: document.getElementById("startAddress"),
  stopsInput: document.getElementById("stopsInput"),
  stopCounter: document.getElementById("stopCounter"),
  loadBtn: document.getElementById("loadBtn"),
  validateBtn: document.getElementById("validateBtn"),
  optimizeBtn: document.getElementById("optimizeBtn"),
  clearBtn: document.getElementById("clearBtn"),
  copyBtn: document.getElementById("copyBtn"),
  copyAllBtn: document.getElementById("copyAllBtn"),
  statusPill: document.getElementById("statusPill"),
  stopsList: document.getElementById("stopsList"),
  results: document.getElementById("results"),
  resultSummary: document.getElementById("resultSummary"),
  orderedList: document.getElementById("orderedList"),
  routeGroups: document.getElementById("routeGroups"),
  grandSummary: document.getElementById("grandSummary"),
  groupCards: document.getElementById("groupCards"),
  combineBtn: document.getElementById("combineBtn"),
  autoSummary: document.getElementById("autoSummary"),
  manualNote: document.getElementById("manualNote"),
  warnings: document.getElementById("warnings"),
  alert: document.getElementById("alert"),
  alertText: document.getElementById("alertText"),
  alertClose: document.getElementById("alertClose"),
  loading: document.getElementById("loading"),
  loadingText: document.getElementById("loadingText"),
  mapMessage: document.getElementById("mapMessage"),
  // City restriction
  cityEnabled: document.getElementById("cityEnabled"),
  cityFields: document.getElementById("cityFields"),
  cityName: document.getElementById("cityName"),
  cityCountry: document.getElementById("cityCountry"),
  cityStrict: document.getElementById("cityStrict"),
  // Clustering
  sprWrap: document.getElementById("sprWrap"),
  norWrap: document.getElementById("norWrap"),
  autoWrap: document.getElementById("autoWrap"),
  stopsPerRoute: document.getElementById("stopsPerRoute"),
  numberOfRoutes: document.getElementById("numberOfRoutes"),
  autoRecommended: document.getElementById("autoRecommended"),
  distanceSensitivity: document.getElementById("distanceSensitivity"),
  autoCombine: document.getElementById("autoCombine"),
  autoMaxStops: document.getElementById("autoMaxStops"),
  // Visited Stops Tracker
  tracker: document.getElementById("tracker"),
  globalProgress: document.getElementById("globalProgress"),
  nextStop: document.getElementById("nextStop"),
  hideVisited: document.getElementById("hideVisited"),
  hideVisitedMarkers: document.getElementById("hideVisitedMarkers"),
  clearRouteProgressBtn: document.getElementById("clearRouteProgressBtn"),
  clearAllProgressBtn: document.getElementById("clearAllProgressBtn"),
  // Min/max stops per route
  useMinMax: document.getElementById("useMinMax"),
  minMaxFields: document.getElementById("minMaxFields"),
  minStops: document.getElementById("minStops"),
  maxStops: document.getElementById("maxStops"),
  // Save & share / sessions
  sessionBanner: document.getElementById("sessionBanner"),
  bannerRestore: document.getElementById("bannerRestore"),
  bannerIgnore: document.getElementById("bannerIgnore"),
  bannerDelete: document.getElementById("bannerDelete"),
  exportBtn: document.getElementById("exportBtn"),
  importInput: document.getElementById("importInput"),
  saveName: document.getElementById("saveName"),
  saveLocalBtn: document.getElementById("saveLocalBtn"),
  restoreLastBtn: document.getElementById("restoreLastBtn"),
  clearSessionBtn: document.getElementById("clearSessionBtn"),
  savedRoutes: document.getElementById("savedRoutes"),
};

// localStorage keys + schema version.
const LAST_SESSION_KEY = "routeOptimizerLite:lastSession";
const SAVED_ROUTES_KEY = "routeOptimizerLite:savedRoutes";
const SCHEMA_VERSION = 1;

// Distinct colors for route-group polylines / markers.
const CLUSTER_COLORS = [
  "#4f8cff", "#f0c34a", "#5fd97b", "#ff8a82", "#b388ff",
  "#33ccff", "#ff9f43", "#2ec5a8", "#e57bd8", "#9aa7b4",
];

/* ---------------------------------------------------------------------------
 * Helpers: alert / loading / status / counter
 * ------------------------------------------------------------------------- */

function showError(message) {
  el.alertText.textContent = message;
  el.alert.classList.remove("hidden", "info");
}
function showInfo(message) {
  el.alertText.textContent = message;
  el.alert.classList.remove("hidden");
  el.alert.classList.add("info");
}
function hideError() {
  el.alert.classList.add("hidden");
  el.alert.classList.remove("info");
}
function showLoading(text) {
  el.loadingText.textContent = text;
  el.loading.classList.remove("hidden");
}
function hideLoading() {
  el.loading.classList.add("hidden");
}

function setStatus(text, color) {
  el.statusPill.textContent = text;
  el.statusPill.className = "pill pill-" + color;
}

/** Update the "Stops: X / 50" counter from a given count. */
function setCounter(count) {
  el.stopCounter.textContent = "Stops: " + count + " / " + MAX_STOPS;
  el.stopCounter.classList.toggle("over", count > MAX_STOPS);
}
/** Counter based on loaded stops (after load/edit/delete). */
function updateCounter() {
  setCounter(state.stops.length);
}
/** Live preview counter based on the textarea (before Load Stops). */
function previewCounter() {
  setCounter(parseStops(el.stopsInput.value).length);
}

/** Re-enable / disable Optimize based on current validation state. */
function refreshOptimizeButton() {
  el.optimizeBtn.disabled = !(state.validated && !state.needsValidation);
}

/** Mark that addresses/start/city changed and validation must be redone. */
function markNeedsValidation() {
  state.validated = false;
  state.needsValidation = true;
  // A pending manual grouping references old indexes; don't reuse it.
  state.manualMode = false;
  setStatus("Needs validation again", "yellow");
  refreshOptimizeButton();
}

/** Discard editable route groups (called when the stop list changes). */
function resetGroups() {
  state.groups = null;
  state.manualMode = false;
  state.optimizeStale = false;
  // The route changed; pause tracking until a fresh optimize.
  state.trackingActive = false;
  state.trackGroups = null;
  if (el.tracker) el.tracker.classList.add("hidden");
  if (el.routeGroups) el.routeGroups.classList.add("hidden");
  if (el.groupCards) el.groupCards.innerHTML = "";
  if (el.autoSummary) el.autoSummary.classList.add("hidden");
  if (el.manualNote) el.manualNote.classList.add("hidden");
  // A stale single-route result would still show visited buttons - hide it too.
  if (el.results) el.results.classList.add("hidden");
  if (el.orderedList) el.orderedList.innerHTML = "";
}

/* ---------------------------------------------------------------------------
 * Settings readers (city restriction + clustering)
 * ------------------------------------------------------------------------- */

function getCityRestriction() {
  return {
    enabled: el.cityEnabled.checked,
    city: el.cityName.value.trim(),
    country: (el.cityCountry.value.trim() || "IL").toUpperCase(),
    strict: el.cityStrict.checked,
  };
}

function clampInt(value, lo, hi, dflt) {
  const n = parseInt(value, 10);
  return Math.max(lo, Math.min(hi, isNaN(n) ? dflt : n));
}

/** Build a Waze deep link from coordinates. Never trusts a URL from a file
 *  (prevents javascript:/data: injection via imported route files). */
function safeWazeUrl(stop) {
  const lat = Number(stop && stop.lat);
  const lng = Number(stop && stop.lng);
  if (isFinite(lat) && isFinite(lng)) {
    return "https://waze.com/ul?ll=" + lat + "," + lng + "&navigate=yes";
  }
  return "#";
}

/** Read the min/max stops-per-route controls. */
function readMinMax() {
  return {
    useMinMaxStops: el.useMinMax.checked,
    minStopsPerRoute: clampInt(el.minStops.value, 1, 25, 5),
    maxStopsPerRoute: clampInt(el.maxStops.value, 1, 25, 6),
  };
}

/** Attach min/max fields to a clustering config (overriding max only when on). */
function withMinMax(cfg) {
  const mm = readMinMax();
  cfg.useMinMaxStops = mm.useMinMaxStops;
  cfg.minStopsPerRoute = mm.minStopsPerRoute;
  if (mm.useMinMaxStops) cfg.maxStopsPerRoute = mm.maxStopsPerRoute;
  return cfg;
}

function getClusteringConfig() {
  const checked = document.querySelector('input[name="cluster"]:checked');
  const mode = checked ? checked.value : "none";
  if (mode === "spr") {
    return withMinMax({
      enabled: true,
      mode: "stops_per_route",
      stopsPerRoute: clampInt(el.stopsPerRoute.value, 1, 25, 5),
      numberOfRoutes: null,
    });
  }
  if (mode === "nor") {
    return withMinMax({
      enabled: true,
      mode: "number_of_routes",
      stopsPerRoute: null,
      numberOfRoutes: Math.max(1, parseInt(el.numberOfRoutes.value, 10) || 1),
    });
  }
  if (mode === "auto") {
    return withMinMax({
      enabled: true,
      mode: "auto_distance",
      recommendedStopsPerRoute: clampInt(el.autoRecommended.value, 2, 25, 5),
      distanceSensitivity: el.distanceSensitivity.value || "balanced",
      autoCombineSmallRoutes: el.autoCombine.checked,
      maxStopsPerRoute: clampInt(el.autoMaxStops.value, 2, 25, 25),
    });
  }
  return withMinMax({ enabled: false, mode: "none", stopsPerRoute: null, numberOfRoutes: null });
}

/** Validate min/max before optimizing; returns an error string or null. */
function validateMinMaxUI() {
  if (!el.useMinMax.checked) return null;
  const min = clampInt(el.minStops.value, 1, 25, 5);
  const max = clampInt(el.maxStops.value, 1, 25, 6);
  if (min < 1) return "Minimum stops per route must be at least 1.";
  if (max > 25) return "Maximum stops per route cannot exceed 25.";
  if (min > max) return "Minimum stops per route cannot be greater than the maximum.";
  return null;
}

/* ---------------------------------------------------------------------------
 * Load stops from the textarea
 * ------------------------------------------------------------------------- */

function parseStops(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

function loadStops() {
  hideError();
  const addresses = parseStops(el.stopsInput.value);

  if (addresses.length === 0) {
    showError("Please paste at least one stop address.");
    return;
  }
  if (addresses.length > MAX_STOPS) {
    showError("Maximum 50 stops allowed.");
    setCounter(addresses.length); // show the over-limit count in red
    return;
  }

  state.stops = addresses.map((address) => ({
    id: nextId++,
    address,
    status: "not_validated",
    formattedAddress: null,
    lat: null,
    lng: null,
    matchedCity: null,
    message: null,
  }));

  renderStops();
  updateCounter();
  resetGroups();
  markNeedsValidation();
  setStatus("Not validated", "gray");
  scheduleSave();
}

/* ---------------------------------------------------------------------------
 * Render the editable stop list
 * ------------------------------------------------------------------------- */

const BADGE = {
  found: { cls: "badge-green", text: "Found" },
  ambiguous: { cls: "badge-yellow", text: "Ambiguous" },
  city_mismatch: { cls: "badge-orange", text: "City mismatch" },
  not_found: { cls: "badge-red", text: "Not found" },
  not_validated: { cls: "badge-gray", text: "Not validated" },
};

function renderStops() {
  el.stopsList.innerHTML = "";

  state.stops.forEach((stop, index) => {
    const card = document.createElement("div");
    card.className = "stop-card";

    const top = document.createElement("div");
    top.className = "stop-top";

    const num = document.createElement("div");
    num.className = "stop-num";
    num.textContent = index + 1;

    const addr = document.createElement("div");
    addr.className = "stop-address";
    addr.textContent = stop.address;

    const badge = document.createElement("span");
    const b = BADGE[stop.status] || BADGE.not_validated;
    badge.className = "badge " + b.cls;
    badge.textContent = b.text;

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => startEdit(stop.id);

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteStop(stop.id);

    top.append(num, addr, badge, editBtn, delBtn);
    card.appendChild(top);

    // Status-specific note.
    if (stop.status === "city_mismatch") {
      const note = document.createElement("div");
      note.className = "stop-note error";
      note.textContent =
        stop.message ||
        ("City mismatch: matched " + (stop.matchedCity || "another city") + ".");
      card.appendChild(note);
    } else if (stop.status === "ambiguous" && stop.formattedAddress) {
      const note = document.createElement("div");
      note.className = "stop-note warn";
      note.textContent =
        "Google matched this as: " + stop.formattedAddress + ". Check before optimizing.";
      card.appendChild(note);
    } else if (stop.status === "not_found") {
      const note = document.createElement("div");
      note.className = "stop-note error";
      note.textContent = "This address could not be found. Please edit or delete it.";
      card.appendChild(note);
    } else if (stop.status === "found" && stop.formattedAddress) {
      const note = document.createElement("div");
      note.className = "stop-note";
      const where = stop.matchedCity ? " · " + stop.matchedCity : "";
      note.textContent =
        stop.formattedAddress +
        "  (" + stop.lat.toFixed(5) + ", " + stop.lng.toFixed(5) + ")" + where;
      card.appendChild(note);
    }

    el.stopsList.appendChild(card);
  });
}

/** Replace a stop's address text with an inline editable input. */
function startEdit(id) {
  const stop = state.stops.find((s) => s.id === id);
  if (!stop) return;

  renderStops(); // ensure DOM is fresh
  const index = state.stops.findIndex((s) => s.id === id);
  const card = el.stopsList.children[index];
  const top = card.querySelector(".stop-top");
  const addrEl = top.querySelector(".stop-address");

  const input = document.createElement("input");
  input.className = "stop-edit-input";
  input.value = stop.address;
  top.replaceChild(input, addrEl);
  input.focus();
  input.select();

  const commit = () => {
    const value = input.value.trim();
    if (value) stop.address = value;
    // Editing invalidates this stop's previous validation.
    stop.status = "not_validated";
    stop.formattedAddress = null;
    stop.lat = stop.lng = null;
    stop.matchedCity = null;
    stop.message = null;
    resetGroups();
    markNeedsValidation();
    renderStops();
    scheduleSave();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") renderStops();
  });
}

function deleteStop(id) {
  state.stops = state.stops.filter((s) => s.id !== id);
  renderStops();
  updateCounter();
  resetGroups();
  markNeedsValidation();
  scheduleSave();
}

/* ---------------------------------------------------------------------------
 * Validate addresses
 * ------------------------------------------------------------------------- */

async function validateAddresses() {
  hideError();
  state.startAddress = el.start.value.trim();

  if (!state.startAddress) {
    showError("Start address is required.");
    return;
  }
  if (state.stops.length === 0) {
    showError("Load at least one stop before validating.");
    return;
  }
  if (state.stops.length > MAX_STOPS) {
    showError("Maximum 50 stops allowed.");
    return;
  }

  const cityRestriction = getCityRestriction();
  if (cityRestriction.enabled && !cityRestriction.city) {
    showError("Enter a city name, or turn off city restriction.");
    return;
  }

  showLoading("Validating addresses…");
  try {
    const resp = await fetch("/api/validate-addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startAddress: state.startAddress,
        stops: state.stops.map((s) => s.address),
        cityRestriction: cityRestriction,
      }),
    });
    const data = await resp.json();

    if (!data.success) {
      showError(data.error || "Validation failed.");
      return;
    }

    state.startValidation = data.start;

    // Apply per-stop results (order matches what we sent).
    data.stops.forEach((result, i) => {
      const stop = state.stops[i];
      if (!stop) return;
      stop.status = result.status;
      stop.formattedAddress = result.formattedAddress;
      stop.lat = result.lat;
      stop.lng = result.lng;
      stop.matchedCity = result.matchedCity;
      stop.message = result.message;
    });

    renderStops();
    renderValidationWarnings(data);

    state.needsValidation = false;
    state.validated = data.canOptimize;

    if (!data.canOptimize) {
      const hasMismatch = data.stops.some((s) => s.status === "city_mismatch") ||
        (data.start && data.start.status === "city_mismatch");
      if (hasMismatch) {
        setStatus("City mismatch - fix addresses", "orange");
        showError("City mismatch detected. Fix the highlighted addresses, then validate again.");
      } else {
        setStatus("Fix not-found addresses", "red");
        showError("Some addresses were not found. Edit or delete them, then validate again.");
      }
    } else if (data.warnings && data.warnings.length) {
      setStatus("Validated (with warnings)", "yellow");
    } else {
      setStatus("Validated", "green");
    }
    refreshOptimizeButton();
    scheduleSave();
  } catch (err) {
    showError("Network error during validation: " + err.message);
  } finally {
    hideLoading();
  }
}

function renderValidationWarnings(data) {
  const warnings = [];
  if (data.start && data.start.status === "ambiguous") {
    warnings.push("Start is ambiguous: " + data.start.formattedAddress);
  }
  (data.warnings || []).forEach((w) => {
    if (!warnings.includes(w)) warnings.push(w);
  });

  if (warnings.length === 0) {
    el.warnings.classList.add("hidden");
    el.warnings.innerHTML = "";
    return;
  }
  el.warnings.classList.remove("hidden");
  el.warnings.innerHTML =
    "<strong>Warnings</strong><ul>" +
    warnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("") +
    "</ul>";
}

/* ---------------------------------------------------------------------------
 * Optimize route
 * ------------------------------------------------------------------------- */

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "return";
}

async function optimizeRoute() {
  hideError();
  if (!state.validated || state.needsValidation) {
    showError("Validate the addresses first.");
    return;
  }

  const minMaxError = validateMinMaxUI();
  if (minMaxError) {
    showError(minMaxError);
    return;
  }

  const returnToStart = getMode() === "return";
  const cityRestriction = getCityRestriction();

  // After a manual combine/separate, re-optimize the edited groups as "manual".
  let clustering;
  if (state.manualMode && state.groups) {
    clustering = withMinMax({
      enabled: true,
      mode: "manual",
      manualClusters: state.groups.map((g) => g.stops.map((s) => s.originalIndex)),
    });
  } else {
    clustering = getClusteringConfig();
  }

  showLoading(
    clustering.enabled ? "Optimizing route groups…" : "Optimizing route…"
  );
  try {
    const resp = await fetch("/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startAddress: state.startAddress,
        stops: state.stops.map((s) => s.address),
        returnToStart: returnToStart,
        endAnywhere: !returnToStart,
        clustering: clustering,
        cityRestriction: cityRestriction,
      }),
    });
    const data = await resp.json();

    if (!data.success) {
      showError(data.error || "Optimization failed.");
      return;
    }

    state.lastResult = data;
    state.clusterSizeSummary = data.clusterSizeSummary || null;
    if (data.mode === "clustered") {
      // Build the editable group state from the fresh result.
      state.groups = data.clusters.map((c) => ({
        stops: c.orderedStops,
        optimized: true,
        distanceMeters: c.totalDistanceMeters,
        durationSeconds: c.totalDurationSeconds,
        encodedPolylines: c.encodedPolylines || [],
        reason: c.clusterReason || null,
        avgKm: (typeof c.averageDistanceFromClusterCenterKm === "number")
          ? c.averageDistanceFromClusterCenterKm : null,
      }));
      state.optimizeStale = false;
      state.manualMode = false;
      prepareTracking();   // build signature + load saved visited state
      renderGroups();
      drawGroups();
      renderVisitedProgress();
      el.routeGroups.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      state.groups = null;
      prepareTracking();
      renderResults(data);
      drawRoute(data);
      renderVisitedProgress();
      el.results.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    scheduleSave();
  } catch (err) {
    showError("Network error during optimization: " + err.message);
  } finally {
    hideLoading();
  }
}

/* ----- Single (non-clustered) result ----- */

function renderResults(data) {
  el.routeGroups.classList.add("hidden");
  el.results.classList.remove("hidden");

  const km = (data.totalDistanceMeters / 1000).toFixed(1);
  const modeText = data.mode === "approximate" ? "Approximate" : "Exact (Google)";

  el.resultSummary.innerHTML =
    stat("Distance", km + " km") +
    stat("Duration", formatDuration(data.totalDurationSeconds)) +
    stat("Stops", String(data.orderedStops.length)) +
    stat("Mode", modeText);

  if (data.warning) {
    el.warnings.classList.remove("hidden");
    el.warnings.innerHTML = "<strong>Warning</strong><div>" + escapeHtml(data.warning) + "</div>";
  }

  el.orderedList.innerHTML = "";
  // Single route is tracked as cluster 0.
  if (state.trackingActive) {
    const grp = trackGroupByIndex(0);
    if (grp) el.orderedList.appendChild(buildRouteVisitedControls(grp));
  }
  data.orderedStops.forEach((stop) => {
    const key = getStopKey(0, stop);
    if (state.trackingActive && state.hideVisited && isVisited(key)) return;
    el.orderedList.appendChild(orderedItem(stop, stop.optimizedIndex, "#4f8cff", key));
  });
}

/* ----- Clustered result (rendered from editable state.groups) ----- */

function renderGroups() {
  if (!state.groups) return;
  el.results.classList.add("hidden");
  el.routeGroups.classList.remove("hidden");

  // Auto-cluster summary (only for a fresh, unedited auto run).
  const summary = state.lastResult && state.lastResult.autoClusterSummary;
  if (summary && !state.optimizeStale) {
    el.autoSummary.classList.remove("hidden");
    el.autoSummary.innerHTML =
      "<strong>Auto Cluster:</strong> " + escapeHtml(summary.message) +
      " (recommended " + summary.recommendedStopsPerRoute + "/route, " +
      summary.actualRouteCount + " routes for " + summary.totalStops + " stops)";
  } else {
    el.autoSummary.classList.add("hidden");
    el.autoSummary.innerHTML = "";
  }

  // "Needs re-optimize" banner after manual edits.
  el.manualNote.classList.toggle("hidden", !state.optimizeStale);
  if (state.optimizeStale) {
    el.manualNote.textContent =
      "Routes were modified. Click “Optimize Route” to recalculate distances, " +
      "order, and navigation.";
  }

  // Grand totals (only meaningful when everything is optimized).
  const allOptimized = state.groups.every((g) => g.optimized);
  if (allOptimized) {
    const dist = state.groups.reduce((a, g) => a + (g.distanceMeters || 0), 0);
    const dur = state.groups.reduce((a, g) => a + (g.durationSeconds || 0), 0);
    el.grandSummary.innerHTML =
      stat("Total distance", (dist / 1000).toFixed(1) + " km") +
      stat("Total duration", formatDuration(dur)) +
      stat("Route groups", String(state.groups.length)) +
      stat("Mode", "Clustered");
  } else {
    el.grandSummary.innerHTML =
      stat("Route groups", String(state.groups.length)) +
      stat("Status", "Pending re-optimize");
  }

  // Min/max stops-per-route summary.
  const css = state.clusterSizeSummary;
  if (css && css.useMinMaxStops && allOptimized) {
    const ok = css.allClustersWithinMin && css.allClustersWithinMax;
    el.grandSummary.innerHTML +=
      stat("Stops/route", css.minStopsPerRoute + "–" + css.maxStopsPerRoute +
        (ok ? " ✓" : " ⚠"));
  }

  el.groupCards.innerHTML = "";
  state.groups.forEach((group, gi) => {
    const ci = gi + 1;
    const color = CLUSTER_COLORS[(ci - 1) % CLUSTER_COLORS.length];
    const card = document.createElement("div");
    card.className = "group-card";
    card.style.borderLeftColor = color;

    // Header: select checkbox + title + meta.
    const head = document.createElement("div");
    head.className = "group-head";

    const left = document.createElement("label");
    left.className = "group-select";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "select-route";
    check.dataset.group = String(gi);
    const title = document.createElement("h3");
    title.style.color = color;
    title.textContent = "Route " + ci;
    left.append(check, title);

    const meta = document.createElement("span");
    meta.className = "group-meta";
    meta.textContent = group.optimized
      ? group.stops.length + " stops · " +
        ((group.distanceMeters || 0) / 1000).toFixed(1) + " km · " +
        formatDuration(group.durationSeconds || 0)
      : group.stops.length + " stops · pending re-optimize";
    // Min/max size badge when a group falls outside the requested range.
    if (group.optimized && css && css.useMinMaxStops) {
      const n = group.stops.length;
      if (n > css.maxStopsPerRoute) {
        const b = document.createElement("span");
        b.className = "badge badge-red";
        b.textContent = "Above max (" + n + ")";
        head.append(left, meta, b);
      } else if (n < css.minStopsPerRoute) {
        const b = document.createElement("span");
        b.className = "badge badge-orange";
        b.textContent = "Below min (" + n + ")";
        head.append(left, meta, b);
      } else {
        head.append(left, meta);
      }
    } else {
      head.append(left, meta);
    }

    card.append(head);

    // Auto-cluster reason note.
    if (group.optimized && group.reason) {
      const note = document.createElement("div");
      note.className = "group-reason";
      note.textContent = group.reason +
        (group.avgKm != null ? " · avg " + group.avgKm + " km from center" : "");
      card.append(note);
    }

    // Visited progress + per-route visited controls (tracking only).
    let progress = null;
    if (state.trackingActive && group.optimized) {
      const trackGroup = { clusterIndex: ci, title: "Route " + ci, stops: group.stops };
      progress = getRouteGroupProgress(trackGroup);
      if (progress.complete) card.classList.add("completed");
      card.append(buildRouteVisitedControls(trackGroup));
    }

    // Ordered stops.
    const list = document.createElement("ol");
    list.className = "ordered-list";
    group.stops.forEach((stop, si) => {
      const key = getStopKey(ci, stop);
      if (state.trackingActive && state.hideVisited && isVisited(key)) return;
      list.appendChild(orderedItem(stop, ci + "." + (si + 1), color, key));
    });
    card.append(list);

    // Per-route actions.
    const actions = document.createElement("div");
    actions.className = "group-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-ghost";
    copyBtn.textContent = "Copy this route";
    copyBtn.onclick = () => copyText(groupToText(group, gi), copyBtn, "Copy this route");
    const focusBtn = document.createElement("button");
    focusBtn.className = "btn btn-ghost";
    focusBtn.textContent = "Focus on map";
    focusBtn.onclick = () => focusCluster(ci);
    actions.append(copyBtn, focusBtn);
    if (group.stops.length >= 4) {
      const sepBtn = document.createElement("button");
      sepBtn.className = "btn btn-ghost";
      sepBtn.textContent = "Separate this route";
      sepBtn.onclick = () => separateGroup(gi);
      actions.append(sepBtn);
    }
    card.append(actions);

    el.groupCards.appendChild(card);
  });
}

/* ----- Manual combine / separate (operate on state.groups) ----- */

function afterManualEdit() {
  state.optimizeStale = true;
  state.manualMode = true;
  // The route structure changed; visited tracking pauses until re-optimization.
  state.trackingActive = false;
  el.tracker.classList.add("hidden");
  renderGroups();
  drawGroups();
  scheduleSave();
}

function combineSelectedRoutes() {
  if (!state.groups) return;
  const checks = Array.from(document.querySelectorAll(".select-route:checked"));
  if (checks.length < 2) {
    showError("Select at least two routes to combine.");
    return;
  }
  const indices = checks
    .map((c) => parseInt(c.dataset.group, 10))
    .sort((a, b) => a - b);

  const merged = [];
  indices.forEach((i) => merged.push(...state.groups[i].stops));
  if (merged.length > 25) {
    showError("Cannot combine: a single route group cannot exceed 25 stops.");
    return;
  }

  const newGroup = { stops: merged, optimized: false, encodedPolylines: [],
                     reason: null, avgKm: null };
  const remaining = state.groups.filter((g, i) => !indices.includes(i));
  remaining.splice(Math.min(indices[0], remaining.length), 0, newGroup);
  state.groups = remaining;
  hideError();
  afterManualEdit();
}

function separateGroup(groupIndex) {
  if (!state.groups) return;
  const group = state.groups[groupIndex];
  if (!group || group.stops.length < 4) {
    showError("A route needs at least 4 stops to separate.");
    return;
  }
  const [a, b] = splitTwo(group.stops);
  const mk = (stops) => ({ stops, optimized: false, encodedPolylines: [],
                           reason: null, avgKm: null });
  state.groups.splice(groupIndex, 1, mk(a), mk(b));
  afterManualEdit();
}

/** Split a list of stops into two geographic halves (simple 2-means). */
function splitTwo(stops) {
  const hav = (p, q) => {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (q.lat - p.lat) * toR, dLng = (q.lng - p.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(p.lat * toR) * Math.cos(q.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const centroid = (arr) => ({
    lat: arr.reduce((a, s) => a + s.lat, 0) / arr.length,
    lng: arr.reduce((a, s) => a + s.lng, 0) / arr.length,
  });

  // Seed with the two farthest-apart stops.
  let s1 = 0, s2 = 1, maxd = -1;
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const d = hav(stops[i], stops[j]);
      if (d > maxd) { maxd = d; s1 = i; s2 = j; }
    }
  }
  let c1 = { lat: stops[s1].lat, lng: stops[s1].lng };
  let c2 = { lat: stops[s2].lat, lng: stops[s2].lng };
  let a = [], b = [];
  for (let iter = 0; iter < 10; iter++) {
    a = []; b = [];
    stops.forEach((st) => (hav(st, c1) <= hav(st, c2) ? a : b).push(st));
    if (!a.length || !b.length) {
      const mid = Math.ceil(stops.length / 2);
      return [stops.slice(0, mid), stops.slice(mid)];
    }
    c1 = centroid(a);
    c2 = centroid(b);
  }
  return [a, b];
}

/** Build one ordered-list row (used by both single and clustered results).
 *  When `stopKey` is given and tracking is active, the row shows visited state
 *  and a Mark visited / Undo control. */
function orderedItem(stop, label, color, stopKey) {
  const visited = !!(stopKey && state.trackingActive && isVisited(stopKey));

  const li = document.createElement("li");
  li.className = "ordered-item" + (visited ? " visited" : "");

  const num = document.createElement("div");
  num.className = "ordered-num";
  num.style.background = visited ? "#2ea043" : color;
  num.textContent = visited ? "✓" : label;

  const body = document.createElement("div");
  body.className = "ordered-body";
  const addr = document.createElement("div");
  addr.className = "addr";
  addr.textContent = stop.address;
  const orig = document.createElement("div");
  orig.className = "orig";
  const formatted = stop.formattedAddress ? stop.formattedAddress + " · " : "";
  orig.textContent = formatted + "orig #" + (stop.originalIndex + 1);
  body.append(addr, orig);
  if (visited) {
    const when = state.visited[stopKey] && state.visited[stopKey].visitedAt;
    const time = document.createElement("div");
    time.className = "visited-time";
    time.textContent = "Visited" + (when ? " at " + formatVisitedTime(when) : "");
    body.append(time);
  }

  const controls = document.createElement("div");
  controls.className = "stop-controls";

  const waze = document.createElement("a");
  waze.className = "waze-btn";
  waze.href = safeWazeUrl(stop);
  waze.target = "_blank";
  waze.rel = "noopener";
  waze.textContent = "Open in Waze";
  controls.append(waze);

  if (stopKey && state.trackingActive) {
    if (visited) {
      const badge = document.createElement("span");
      badge.className = "badge badge-green";
      badge.textContent = "Visited";
      const undo = document.createElement("button");
      undo.className = "icon-btn";
      undo.textContent = "Undo";
      undo.onclick = () => undoStopVisited(stopKey);
      controls.append(badge, undo);
    } else {
      const mark = document.createElement("button");
      mark.className = "icon-btn mark-btn";
      mark.textContent = "Mark visited";
      mark.onclick = () => markStopVisited(stopKey);
      controls.append(mark);
    }
  }

  li.append(num, body, controls);
  return li;
}

function stat(label, value) {
  return (
    '<div class="stat"><span class="label">' +
    escapeHtml(label) +
    '</span><span class="value">' +
    escapeHtml(value) +
    "</span></div>"
  );
}

function formatDuration(seconds) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

/* ---------------------------------------------------------------------------
 * Copy helpers
 * ------------------------------------------------------------------------- */

function copyText(text, btn, restoreLabel) {
  navigator.clipboard.writeText(text).then(
    () => {
      if (btn) {
        const original = restoreLabel || btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = original), 1500);
      }
    },
    () => showError("Could not copy to clipboard.")
  );
}

function groupToText(group, groupIndex) {
  const lines = ["Route " + (groupIndex + 1), "Start: " + state.startAddress];
  group.stops.forEach((s, i) => lines.push((i + 1) + ". " + s.address));
  return lines.join("\n");
}

/** Copy the optimized order (single-route result). */
function copyOptimizedOrder() {
  if (!state.lastResult || !state.lastResult.orderedStops) {
    showError("Optimize a route first.");
    return;
  }
  const lines = ["Start: " + state.startAddress];
  state.lastResult.orderedStops.forEach((s) =>
    lines.push(s.optimizedIndex + ". " + s.address));
  copyText(lines.join("\n"), el.copyBtn, "Copy Optimized Order");
}

/** Copy every route group (clustered result), from current group state. */
function copyAllRoutes() {
  if (!state.groups || !state.groups.length) {
    showError("Optimize a clustered route first.");
    return;
  }
  const out = [];
  state.groups.forEach((group, i) => out.push(groupToText(group, i), ""));
  copyText(out.join("\n").trim(), el.copyAllBtn, "Copy all route groups");
}

/* ---------------------------------------------------------------------------
 * Clear everything
 * ------------------------------------------------------------------------- */

function clearAll() {
  hideError();
  state.startAddress = "";
  state.startValidation = null;
  state.stops = [];
  state.validated = false;
  state.needsValidation = true;
  state.lastResult = null;
  state.groups = null;
  state.manualMode = false;
  state.optimizeStale = false;
  state.trackGroups = null;
  state.visited = {};
  state.routeSignature = null;
  state.trackingActive = false;
  state.clusterSizeSummary = null;

  el.start.value = "";
  el.stopsInput.value = "";
  el.stopsList.innerHTML = "";
  el.orderedList.innerHTML = "";
  el.groupCards.innerHTML = "";
  el.results.classList.add("hidden");
  el.routeGroups.classList.add("hidden");
  el.autoSummary.classList.add("hidden");
  el.autoSummary.innerHTML = "";
  el.manualNote.classList.add("hidden");
  el.tracker.classList.add("hidden");
  el.warnings.classList.add("hidden");
  el.warnings.innerHTML = "";
  setStatus("Not validated", "gray");
  updateCounter();
  refreshOptimizeButton();
  clearMap();
}

/* ---------------------------------------------------------------------------
 * Google Maps
 * ------------------------------------------------------------------------- */

let map = null;
let mapMarkers = [];
let mapPolylines = [];
let clusterBoundsMap = {}; // clusterIndex -> LatLngBounds (for "Focus on map")
let markerByKey = {};      // stopKey -> { marker, color, label, scale, fontSize }

/** Decode a Google encoded polyline into [{lat, lng}, ...]. */
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Called by the Google Maps script once it loads (see loadGoogleMaps). */
function initMap() {
  if (el.mapMessage) el.mapMessage.classList.add("hidden");
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 31.9288, lng: 34.8667 }, // default: Ramla area
    zoom: 11,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    styles: DARK_MAP_STYLE,
  });
  redrawCurrentRoute(); // restore markers/polylines if a session was loaded first
}
window.initMap = initMap; // Google calls this by name.

/** Redraw the current route (single or clustered) without recomputing. */
function redrawCurrentRoute() {
  if (!map) return;
  if (state.groups) drawGroups();
  else if (state.lastResult && Array.isArray(state.lastResult.orderedStops)) {
    drawRoute(state.lastResult);
  }
}

function clearMap() {
  mapMarkers.forEach((m) => m.setMap(null));
  mapPolylines.forEach((p) => p.setMap(null));
  mapMarkers = [];
  mapPolylines = [];
  clusterBoundsMap = {};
  markerByKey = {};
}

function addMarker(position, label, color, scale, fontSize) {
  const marker = new google.maps.Marker({
    position,
    map,
    label: {
      text: label,
      color: "#0f1419",
      fontSize: fontSize || "11px",
      fontWeight: "700",
    },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: scale || 13,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#0f1419",
      strokeWeight: 2,
    },
  });
  mapMarkers.push(marker);
  return marker;
}

/** Register a stop marker under its stop key so it can be restyled on visit. */
function registerStopMarker(stopKey, marker, color, label, scale, fontSize) {
  markerByKey[stopKey] = { marker, color, label, scale, fontSize };
}

/** Apply visited vs. normal style to one registered marker (no polyline touch). */
function applyMarkerVisited(rec, visited) {
  rec.marker.setIcon({
    path: google.maps.SymbolPath.CIRCLE,
    scale: rec.scale,
    fillColor: visited ? "#2ea043" : rec.color,
    fillOpacity: visited ? 0.95 : 1,
    strokeColor: "#0f1419",
    strokeWeight: 2,
  });
  rec.marker.setLabel({
    text: visited ? "✓" : rec.label,
    color: "#0f1419",
    fontSize: rec.fontSize,
    fontWeight: "700",
  });
}

/** Update a single marker to reflect its current visited state. */
function updateMarkerVisitedState(stopKey) {
  const rec = markerByKey[stopKey];
  if (!rec) return;
  const visited = isVisited(stopKey);
  if (state.hideVisitedMarkers && visited) {
    rec.marker.setMap(null);
  } else {
    rec.marker.setMap(map);
    applyMarkerVisited(rec, visited);
  }
}

/** Restyle all stop markers (used after group/global visited changes). */
function updateAllMarkers() {
  Object.keys(markerByKey).forEach((key) => updateMarkerVisitedState(key));
}

function addPolyline(encoded, color, bounds, clusterBounds) {
  const path = decodePolyline(encoded);
  const line = new google.maps.Polyline({
    path,
    map,
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWeight: 4,
  });
  mapPolylines.push(line);
  path.forEach((p) => {
    bounds.extend(p);
    if (clusterBounds) clusterBounds.extend(p);
  });
}

/** Draw a single (non-clustered) route. */
function drawRoute(data) {
  if (!map) {
    showError("Map is not loaded (check the API key), but the route was computed.");
    return;
  }
  clearMap();
  const bounds = new google.maps.LatLngBounds();

  if (data.start && data.start.lat != null) {
    const startPos = { lat: data.start.lat, lng: data.start.lng };
    addMarker(startPos, "S", "#2ea043");
    bounds.extend(startPos);
  }

  data.orderedStops.forEach((stop) => {
    if (stop.lat == null) return;
    const pos = { lat: stop.lat, lng: stop.lng };
    const labelText = String(stop.optimizedIndex);
    const marker = addMarker(pos, labelText, "#4f8cff", 13, "11px");
    registerStopMarker(getStopKey(0, stop), marker, "#4f8cff", labelText, 13, "11px");
    bounds.extend(pos);
  });

  (data.encodedPolylines || []).forEach((enc) => addPolyline(enc, "#4f8cff", bounds));

  updateAllMarkers(); // apply any restored visited styling
  if (!bounds.isEmpty()) map.fitBounds(bounds);
}

/** Draw all route groups from state.groups, each in its own color.
 *  Markers labeled "route.stop". Polylines drawn only for optimized groups
 *  (after a manual edit, an edited group shows markers but no stale polyline). */
function drawGroups() {
  if (!map) {
    showError("Map is not loaded (check the API key), but the routes were computed.");
    return;
  }
  if (!state.groups) return;
  clearMap();
  const bounds = new google.maps.LatLngBounds();

  let startPos = null;
  const start = state.lastResult && state.lastResult.start;
  if (start && start.lat != null) {
    startPos = { lat: start.lat, lng: start.lng };
    addMarker(startPos, "S", "#2ea043");
    bounds.extend(startPos);
  }

  state.groups.forEach((group, gi) => {
    const ci = gi + 1;
    const color = CLUSTER_COLORS[(ci - 1) % CLUSTER_COLORS.length];
    const clusterBounds = new google.maps.LatLngBounds();
    if (startPos) clusterBounds.extend(startPos);

    group.stops.forEach((stop, si) => {
      if (stop.lat == null) return;
      const pos = { lat: stop.lat, lng: stop.lng };
      const labelText = ci + "." + (si + 1);
      const marker = addMarker(pos, labelText, color, 15, "10px");
      registerStopMarker(getStopKey(ci, stop), marker, color, labelText, 15, "10px");
      bounds.extend(pos);
      clusterBounds.extend(pos);
    });

    if (group.optimized) {
      (group.encodedPolylines || []).forEach((enc) =>
        addPolyline(enc, color, bounds, clusterBounds));
    }

    clusterBoundsMap[ci] = clusterBounds;
  });

  updateAllMarkers(); // apply any restored visited styling
  if (!bounds.isEmpty()) map.fitBounds(bounds);
}

/** Zoom the map to a single route group. */
function focusCluster(clusterIndex) {
  const cb = clusterBoundsMap[clusterIndex];
  if (map && cb && !cb.isEmpty()) {
    map.fitBounds(cb);
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/** Fetch the API key, then load the Google Maps JS script. */
async function loadGoogleMaps() {
  try {
    const resp = await fetch("/api/config");
    const cfg = await resp.json();
    if (!cfg.googleMapsApiKey) {
      el.mapMessage.textContent =
        "No Google Maps API key configured. Add GOOGLE_MAPS_API_KEY to .env to enable the map.";
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js?key=" +
      encodeURIComponent(cfg.googleMapsApiKey) +
      "&callback=initMap";
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      el.mapMessage.textContent = "Failed to load Google Maps. Check the API key / network.";
      el.mapMessage.classList.remove("hidden");
    };
    document.head.appendChild(script);
  } catch (err) {
    el.mapMessage.textContent = "Could not load map config: " + err.message;
  }
}

/* A simple dark map style. */
const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1a212b" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a212b" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa7b4" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3744" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#c0cad4" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1419" }] },
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

/* ---------------------------------------------------------------------------
 * Visited Stops Tracker
 *
 * Pure frontend progress layer over an already-calculated result. It never calls
 * the backend or Google, and never changes the optimized order. Visited state is
 * persisted in localStorage under a per-route signature.
 * ------------------------------------------------------------------------- */

/** djb2-style string hash -> short base36 string (for the storage key). */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
    h |= 0; // keep 32-bit
  }
  return (h >>> 0).toString(36);
}

/** "HH:mm" from an ISO timestamp. */
function formatVisitedTime(iso) {
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  } catch (e) {
    return "";
  }
}

/** Stable key for a stop. clusterIndex 0 = non-clustered (single) route. */
function getStopKey(clusterIndex, stop) {
  return "cluster-" + clusterIndex + "-stop-" + stop.originalIndex;
}

function trackGroupByIndex(clusterIndex) {
  return (state.trackGroups || []).find((g) => g.clusterIndex === clusterIndex);
}

/** Normalize the current result (single or clustered) for tracking. */
function buildTrackGroups() {
  if (state.groups) {
    state.trackGroups = state.groups.map((g, gi) => ({
      clusterIndex: gi + 1,
      title: "Route " + (gi + 1),
      clustered: true,
      stops: g.stops,
    }));
  } else if (state.lastResult && state.lastResult.orderedStops) {
    state.trackGroups = [{
      clusterIndex: 0,
      title: null,
      clustered: false,
      stops: state.lastResult.orderedStops,
    }];
  } else {
    state.trackGroups = null;
  }
}

/** Signature from start + ordered stop addresses + group structure. */
function generateRouteSignature() {
  const parts = [state.startAddress || ""];
  (state.trackGroups || []).forEach((g) => {
    parts.push("g" + g.clusterIndex);
    g.stops.forEach((s) => parts.push(s.originalIndex + ":" + (s.address || "")));
  });
  return "sig_" + hashString(parts.join("|"));
}

function storageKeyFor(signature) {
  return "visitedStops:" + signature;
}

function loadVisitedState(signature) {
  state.routeSignature = signature;
  let visited = {};
  try {
    const raw = localStorage.getItem(storageKeyFor(signature));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.visited) visited = parsed.visited;
    }
  } catch (e) {
    visited = {};
  }
  state.visited = visited;
}

function saveVisitedState() {
  if (!state.routeSignature) return;
  try {
    localStorage.setItem(storageKeyFor(state.routeSignature),
      JSON.stringify({ visited: state.visited }));
  } catch (e) {
    /* storage full / disabled - progress just won't persist */
  }
}

/** Build trackGroups + signature + load saved visited state (no DOM). */
function prepareTracking() {
  buildTrackGroups();
  if (!state.trackGroups) {
    state.trackingActive = false;
    return;
  }
  loadVisitedState(generateRouteSignature());
  state.trackingActive = true;
}

function isVisited(stopKey) {
  return !!(state.visited[stopKey] && state.visited[stopKey].visited);
}

/** Re-render the list + markers + progress after a visited change (no recompute). */
function afterVisitedChange() {
  if (state.groups) renderGroups();
  else if (state.lastResult) renderResults(state.lastResult);
  updateAllMarkers();
  renderVisitedProgress();
  scheduleSave();
}

function markStopVisited(stopKey) {
  state.visited[stopKey] = { visited: true, visitedAt: new Date().toISOString() };
  saveVisitedState();
  afterVisitedChange();
}

function undoStopVisited(stopKey) {
  delete state.visited[stopKey];
  saveVisitedState();
  afterVisitedChange();
}

function markRouteVisited(clusterIndex) {
  const group = trackGroupByIndex(clusterIndex);
  if (!group) return;
  const now = new Date().toISOString();
  group.stops.forEach((s) => {
    state.visited[getStopKey(clusterIndex, s)] = { visited: true, visitedAt: now };
  });
  saveVisitedState();
  afterVisitedChange();
}

function resetRouteProgress(clusterIndex) {
  const group = trackGroupByIndex(clusterIndex);
  if (!group) return;
  group.stops.forEach((s) => delete state.visited[getStopKey(clusterIndex, s)]);
  saveVisitedState();
  afterVisitedChange();
}

/** Clear progress for the current route only (keeps the calculated route). */
function clearProgressForThisRoute() {
  state.visited = {};
  saveVisitedState();
  afterVisitedChange();
}

/** Clear visited progress for every route stored in this browser. */
function clearAllVisitedProgress() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.indexOf("visitedStops:") === 0)
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* ignore */ }
  state.visited = {};
  afterVisitedChange();
}

function getGlobalProgress() {
  let total = 0, visited = 0;
  (state.trackGroups || []).forEach((g) => {
    g.stops.forEach((s) => {
      total++;
      if (isVisited(getStopKey(g.clusterIndex, s))) visited++;
    });
  });
  return { total, visited, remaining: total - visited,
           pct: total ? Math.round((visited / total) * 100) : 0 };
}

function getRouteGroupProgress(group) {
  let visited = 0;
  group.stops.forEach((s) => {
    if (isVisited(getStopKey(group.clusterIndex, s))) visited++;
  });
  const total = group.stops.length;
  return { total, visited, pct: total ? Math.round((visited / total) * 100) : 0,
           complete: total > 0 && visited === total };
}

/** First unvisited stop by route-group order then stop order, or null. */
function getNextUnvisitedStop() {
  for (const g of (state.trackGroups || [])) {
    for (const s of g.stops) {
      const key = getStopKey(g.clusterIndex, s);
      if (!isVisited(key)) {
        return { clusterIndex: g.clusterIndex, title: g.title, stop: s, key };
      }
    }
  }
  return null;
}

function progressBar(pct) {
  return '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
}

/** Per-route progress block + "Mark entire route visited" / "Reset" buttons. */
function buildRouteVisitedControls(group) {
  const p = getRouteGroupProgress(group);
  const wrap = document.createElement("div");
  wrap.className = "route-progress";

  const line = document.createElement("div");
  line.className = "progress-line";
  line.innerHTML = "<span>" + p.visited + " / " + p.total + " visited</span>" +
    (p.complete ? "<span class='done-tag'>Route completed</span>" : "");

  const bar = document.createElement("div");
  bar.innerHTML = progressBar(p.pct);

  const acts = document.createElement("div");
  acts.className = "route-progress-actions";
  const markAll = document.createElement("button");
  markAll.className = "icon-btn";
  markAll.textContent = "Mark entire route visited";
  markAll.onclick = () => markRouteVisited(group.clusterIndex);
  const reset = document.createElement("button");
  reset.className = "icon-btn";
  reset.textContent = "Reset route progress";
  reset.onclick = () => resetRouteProgress(group.clusterIndex);
  acts.append(markAll, reset);

  wrap.append(line, bar.firstChild, acts);
  return wrap;
}

/** Render the global progress summary + Next Stop section. */
function renderVisitedProgress() {
  if (!state.trackingActive || !state.trackGroups) {
    el.tracker.classList.add("hidden");
    return;
  }
  el.tracker.classList.remove("hidden");
  el.hideVisited.checked = state.hideVisited;
  el.hideVisitedMarkers.checked = state.hideVisitedMarkers;

  const gp = getGlobalProgress();
  el.globalProgress.innerHTML =
    '<div class="progress-line"><span>' + gp.visited + " / " + gp.total +
    " stops visited</span><span>" + gp.pct + "% completed</span></div>" +
    progressBar(gp.pct);

  el.nextStop.innerHTML = "";
  const next = getNextUnvisitedStop();
  if (!next) {
    const done = document.createElement("div");
    done.className = "next-done";
    done.textContent = "All stops completed.";
    el.nextStop.append(done);
    return;
  }

  const label = document.createElement("div");
  label.className = "next-label";
  label.textContent = "Next Stop";
  const addr = document.createElement("div");
  addr.className = "next-addr";
  addr.textContent = next.stop.address;
  const meta = document.createElement("div");
  meta.className = "next-meta";
  meta.textContent = next.title ? "in " + next.title : "";

  const acts = document.createElement("div");
  acts.className = "next-actions";
  const waze = document.createElement("a");
  waze.className = "waze-btn";
  waze.href = safeWazeUrl(next.stop);
  waze.target = "_blank";
  waze.rel = "noopener";
  waze.textContent = "Open in Waze";
  const mark = document.createElement("button");
  mark.className = "btn btn-primary";
  mark.textContent = "Mark visited";
  mark.onclick = () => markStopVisited(next.key);
  acts.append(waze, mark);

  el.nextStop.append(label, addr, meta, acts);
}

/* ---------------------------------------------------------------------------
 * Save / restore / export / import (no database; localStorage + JSON files)
 *
 * One serializable shape is used for autosave, named saves, and export files,
 * so restore/import share a single code path. Imported data is treated as data
 * only (validated, rendered via textContent, Waze links rebuilt from coords).
 * ------------------------------------------------------------------------- */

function numOrNull(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function setRadioByName(name, value) {
  const radio = document.querySelector(
    'input[name="' + name + '"][value="' + value + '"]');
  if (radio) radio.checked = true;
}

function clusterModeToRadio(clustering) {
  const map = { stops_per_route: "spr", number_of_routes: "nor",
                auto_distance: "auto" };
  if (!clustering || !clustering.enabled) return "none";
  return map[clustering.mode] || "none";
}

/** Capture all clustering UI controls (for faithful restore). */
function clusteringForSave() {
  const cfg = getClusteringConfig();
  cfg.radioMode = (document.querySelector('input[name="cluster"]:checked') || {}).value || "none";
  cfg.stopsPerRoute = clampInt(el.stopsPerRoute.value, 1, 25, 5);
  cfg.numberOfRoutes = Math.max(1, parseInt(el.numberOfRoutes.value, 10) || 1);
  cfg.recommendedStopsPerRoute = clampInt(el.autoRecommended.value, 2, 25, 5);
  cfg.distanceSensitivity = el.distanceSensitivity.value || "balanced";
  cfg.autoCombineSmallRoutes = el.autoCombine.checked;
  cfg.autoMaxStopsPerRoute = clampInt(el.autoMaxStops.value, 2, 25, 25);
  const mm = readMinMax();
  cfg.useMinMaxStops = mm.useMinMaxStops;
  cfg.minStopsPerRoute = mm.minStopsPerRoute;
  cfg.maxStopsPerRoute = mm.useMinMaxStops ? mm.maxStopsPerRoute : cfg.autoMaxStopsPerRoute;
  return cfg;
}

/** Build the portable session/export object from current state. */
function buildSessionObject() {
  const cr = getCityRestriction();
  const stops = state.stops.map((s, i) => ({
    originalIndex: i,
    input: s.address,
    formattedAddress: s.formattedAddress,
    lat: s.lat,
    lng: s.lng,
    validationStatus: s.status,
    matchedCity: s.matchedCity,
    requestedCity: cr.enabled ? cr.city : null,
  }));
  return {
    appName: "Route Optimizer Lite",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    startAddress: el.start.value.trim(),
    stops: stops,
    routeSettings: { returnToStart: getMode() === "return",
                     endAnywhere: getMode() !== "return" },
    cityRestriction: cr,
    clustering: clusteringForSave(),
    optimizationResult: state.lastResult || null,
    visitedState: { visited: state.visited || {} },
    uiState: { hideVisitedStops: state.hideVisited,
               hideVisitedMarkers: state.hideVisitedMarkers },
    // Extra (non-schema) client fields for exact local restore. Importers that
    // don't have these reconstruct from optimizationResult instead.
    clientState: {
      groups: state.groups,
      validated: state.validated,
      needsValidation: state.needsValidation,
      manualMode: state.manualMode,
      optimizeStale: state.optimizeStale,
      trackingActive: state.trackingActive,
      routeSignature: state.routeSignature,
      clusterSizeSummary: state.clusterSizeSummary,
    },
  };
}

function hasMeaningfulState() {
  return el.start.value.trim() !== "" || state.stops.length > 0 || !!state.lastResult;
}

let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveSession, 400);
}
function saveSession() {
  if (!hasMeaningfulState()) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(buildSessionObject()));
  } catch (e) { /* storage disabled/full */ }
}

function validateImportedObject(obj) {
  if (!obj || typeof obj !== "object") return "Invalid route file.";
  if (obj.appName !== "Route Optimizer Lite") return "Invalid route file.";
  if (typeof obj.schemaVersion !== "number" || obj.schemaVersion > SCHEMA_VERSION) {
    return "Unsupported route file version.";
  }
  if (!Array.isArray(obj.stops)) return "Invalid route file.";
  return null;
}

/** Set up the visited tracker from imported visited data (not localStorage). */
function setupTrackingFromImported(visited) {
  buildTrackGroups();
  if (!state.trackGroups) {
    state.trackingActive = false;
    return;
  }
  state.routeSignature = generateRouteSignature();
  state.visited = visited || {};
  state.trackingActive = true;
  saveVisitedState(); // persist imported progress under this route signature
}

/** Restore the whole app from a session/export object. No Google calls. */
function applySessionObject(obj, successMessage) {
  const err = validateImportedObject(obj);
  if (err) { showError(err); return false; }
  hideError();

  // Form: start + route mode.
  el.start.value = obj.startAddress || "";
  state.startAddress = (obj.startAddress || "").trim();
  const rs = obj.routeSettings || {};
  setRadioByName("mode", rs.returnToStart === false ? "anywhere" : "return");

  // City restriction.
  const cr = obj.cityRestriction || {};
  el.cityEnabled.checked = !!cr.enabled;
  el.cityName.value = cr.city || "";
  el.cityCountry.value = cr.country || "IL";
  el.cityStrict.checked = cr.strict !== false;
  syncCityDisabled();

  // Clustering settings (with safe defaults for older files).
  const cl = obj.clustering || {};
  setRadioByName("cluster", cl.radioMode || clusterModeToRadio(cl));
  if (cl.stopsPerRoute) el.stopsPerRoute.value = cl.stopsPerRoute;
  if (cl.numberOfRoutes) el.numberOfRoutes.value = cl.numberOfRoutes;
  if (cl.recommendedStopsPerRoute) el.autoRecommended.value = cl.recommendedStopsPerRoute;
  if (cl.distanceSensitivity) el.distanceSensitivity.value = cl.distanceSensitivity;
  el.autoCombine.checked = cl.autoCombineSmallRoutes !== false;
  if (cl.autoMaxStopsPerRoute) el.autoMaxStops.value = cl.autoMaxStopsPerRoute;
  else if (cl.maxStopsPerRoute && !cl.useMinMaxStops) el.autoMaxStops.value = cl.maxStopsPerRoute;
  el.useMinMax.checked = !!cl.useMinMaxStops;
  if (cl.minStopsPerRoute) el.minStops.value = cl.minStopsPerRoute;
  if (cl.maxStopsPerRoute) el.maxStops.value = cl.maxStopsPerRoute;
  onClusterModeChange();
  toggleMinMaxFields();

  // Stops (rebuilt with fresh ids; rendered via textContent in renderStops).
  state.stops = (obj.stops || []).map((st) => ({
    id: nextId++,
    address: String(st.input || ""),
    status: typeof st.validationStatus === "string" ? st.validationStatus : "not_validated",
    formattedAddress: st.formattedAddress != null ? String(st.formattedAddress) : null,
    lat: numOrNull(st.lat),
    lng: numOrNull(st.lng),
    matchedCity: st.matchedCity != null ? String(st.matchedCity) : null,
    message: null,
  }));
  renderStops();
  updateCounter();

  // UI flags + visited + result.
  state.hideVisited = !!(obj.uiState && obj.uiState.hideVisitedStops);
  state.hideVisitedMarkers = !!(obj.uiState && obj.uiState.hideVisitedMarkers);
  el.hideVisited.checked = state.hideVisited;
  el.hideVisitedMarkers.checked = state.hideVisitedMarkers;
  const importedVisited = (obj.visitedState && obj.visitedState.visited &&
    typeof obj.visitedState.visited === "object") ? obj.visitedState.visited : {};
  const csState = obj.clientState || {};
  state.lastResult = obj.optimizationResult || null;
  state.clusterSizeSummary = (state.lastResult && state.lastResult.clusterSizeSummary) ||
    csState.clusterSizeSummary || null;

  if (state.lastResult) {
    if (state.lastResult.mode === "clustered" && Array.isArray(state.lastResult.clusters)) {
      if (Array.isArray(csState.groups) && csState.groups.length) {
        state.groups = csState.groups; // exact (preserves any pending manual edit)
      } else {
        state.groups = state.lastResult.clusters.map((c) => ({
          stops: Array.isArray(c.orderedStops) ? c.orderedStops : [],
          optimized: true,
          distanceMeters: c.totalDistanceMeters || 0,
          durationSeconds: c.totalDurationSeconds || 0,
          encodedPolylines: Array.isArray(c.encodedPolylines) ? c.encodedPolylines : [],
          reason: c.clusterReason || null,
          avgKm: (typeof c.averageDistanceFromClusterCenterKm === "number")
            ? c.averageDistanceFromClusterCenterKm : null,
        }));
      }
    } else {
      state.groups = null;
    }
    setupTrackingFromImported(importedVisited);
    state.optimizeStale = !!csState.optimizeStale;
    state.manualMode = !!csState.manualMode;
    state.validated = csState.validated != null ? !!csState.validated : true;
    state.needsValidation = csState.needsValidation != null ? !!csState.needsValidation : false;
    if (state.groups) renderGroups();
    else renderResults(state.lastResult);
    redrawCurrentRoute();
    renderVisitedProgress();
  } else {
    state.groups = null;
    state.trackingActive = false;
    state.visited = {};
    el.tracker.classList.add("hidden");
    el.results.classList.add("hidden");
    el.routeGroups.classList.add("hidden");
    clearMap();
    const inferred = state.stops.length > 0 && state.stops.every((s) =>
      s.status && s.status !== "not_validated" && s.status !== "not_found");
    state.validated = csState.validated != null ? !!csState.validated : inferred;
    state.needsValidation = csState.needsValidation != null
      ? !!csState.needsValidation : !state.validated;
  }

  if (state.validated && !state.needsValidation) setStatus("Validated", "green");
  else if (state.needsValidation && state.stops.length) setStatus("Needs validation", "yellow");
  else setStatus("Not validated", "gray");
  refreshOptimizeButton();

  saveSession();
  if (successMessage) showInfo(successMessage);
  return true;
}

/* ----- Export / import files ----- */

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function exportRouteFile() {
  if (!hasMeaningfulState()) {
    showError("Nothing to export yet. Add stops first.");
    return;
  }
  downloadJSON(buildSessionObject(), "route-optimizer-lite-" + dateStamp() + ".json");
  showInfo("Route file exported successfully.");
}

function importRouteFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let obj;
    try {
      obj = JSON.parse(reader.result);
    } catch (e) {
      showError("Invalid route file.");
      return;
    }
    const msg = (obj && obj.optimizationResult)
      ? "Route file imported and restored."
      : "Route file imported. Click Optimize Route to calculate the route.";
    applySessionObject(obj, msg);
  };
  reader.onerror = () => showError("Could not read the file.");
  reader.readAsText(file);
}

/* ----- Named local saves ----- */

function readSavedRoutes() {
  try {
    const raw = localStorage.getItem(SAVED_ROUTES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeSavedRoutes(arr) {
  try {
    localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function saveRouteLocally() {
  const name = el.saveName.value.trim();
  if (!name) { showError("Enter a name for the saved route."); return; }
  if (!hasMeaningfulState()) { showError("Nothing to save yet."); return; }
  const entry = {
    id: "r" + Date.now(),
    name: name,
    savedAt: new Date().toISOString(),
    stopCount: state.stops.length,
    mode: getMode() === "return" ? "Return to start" : "End anywhere",
    data: buildSessionObject(),
  };
  const arr = readSavedRoutes();
  arr.unshift(entry);
  writeSavedRoutes(arr);
  el.saveName.value = "";
  renderSavedRoutes();
  showInfo("Route saved locally.");
}

function renderSavedRoutes() {
  const arr = readSavedRoutes();
  el.savedRoutes.innerHTML = "";
  if (!arr.length) return;
  const title = document.createElement("div");
  title.className = "saved-title";
  title.textContent = "Saved Routes";
  el.savedRoutes.append(title);

  arr.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "saved-row";

    const info = document.createElement("div");
    info.className = "saved-info";
    const nm = document.createElement("div");
    nm.className = "saved-name";
    nm.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "saved-meta";
    meta.textContent = entry.stopCount + " stops · " + entry.mode + " · " +
      formatSavedDate(entry.savedAt);
    info.append(nm, meta);

    const acts = document.createElement("div");
    acts.className = "saved-actions";
    const load = makeMiniBtn("Load", () => loadSavedRoute(entry.id));
    const exp = makeMiniBtn("Export", () => exportSavedRoute(entry.id));
    const del = makeMiniBtn("Delete", () => deleteSavedRoute(entry.id));
    del.classList.add("danger");
    acts.append(load, exp, del);

    row.append(info, acts);
    el.savedRoutes.append(row);
  });
}

function makeMiniBtn(text, fn) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.textContent = text;
  b.onclick = fn;
  return b;
}

function formatSavedDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return "";
  }
}

function loadSavedRoute(id) {
  const entry = readSavedRoutes().find((x) => x.id === id);
  if (entry) applySessionObject(entry.data, "Saved route loaded.");
}

function deleteSavedRoute(id) {
  writeSavedRoutes(readSavedRoutes().filter((x) => x.id !== id));
  renderSavedRoutes();
}

function exportSavedRoute(id) {
  const entry = readSavedRoutes().find((x) => x.id === id);
  if (entry) {
    downloadJSON(entry.data, "route-optimizer-lite-" + dateStamp() + ".json");
    showInfo("Route file exported successfully.");
  }
}

/* ----- Last-session banner / restore / clear ----- */

function checkSavedSessionBanner() {
  try {
    if (localStorage.getItem(LAST_SESSION_KEY)) {
      el.sessionBanner.classList.remove("hidden");
    }
  } catch (e) { /* ignore */ }
}

function restoreLastSession() {
  let raw;
  try {
    raw = localStorage.getItem(LAST_SESSION_KEY);
  } catch (e) { raw = null; }
  if (!raw) { showError("No saved session found."); return; }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    showError("Saved session is corrupted.");
    return;
  }
  el.sessionBanner.classList.add("hidden");
  applySessionObject(obj, "Last session restored.");
}

function clearSavedSession() {
  try {
    localStorage.removeItem(LAST_SESSION_KEY);
  } catch (e) { /* ignore */ }
  el.sessionBanner.classList.add("hidden");
  showInfo("Saved session cleared.");
}

/* ---------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------- */

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

/* ---------------------------------------------------------------------------
 * Clustering UI: show/hide the relevant input for the selected mode
 * ------------------------------------------------------------------------- */

function onClusterModeChange() {
  const mode = (document.querySelector('input[name="cluster"]:checked') || {}).value;
  el.sprWrap.classList.toggle("hidden", mode !== "spr");
  el.norWrap.classList.toggle("hidden", mode !== "nor");
  el.autoWrap.classList.toggle("hidden", mode !== "auto");
  // Choosing a clustering mode discards any pending manual edits; the next
  // Optimize will use the selected mode (not "manual").
  state.manualMode = false;
}

function syncCityDisabled() {
  const on = el.cityEnabled.checked;
  el.cityFields.classList.toggle("disabled", !on);
  el.cityName.disabled = !on;
  el.cityCountry.disabled = !on;
  el.cityStrict.disabled = !on;
}

function onCityToggle() {
  syncCityDisabled();
  // Changing city restriction requires re-validation.
  if (!state.needsValidation) markNeedsValidation();
}

function toggleMinMaxFields() {
  const on = el.useMinMax.checked;
  el.minMaxFields.classList.toggle("disabled", !on);
  el.minStops.disabled = !on;
  el.maxStops.disabled = !on;
}

/* ---------------------------------------------------------------------------
 * Wire up events
 * ------------------------------------------------------------------------- */

el.loadBtn.addEventListener("click", loadStops);
el.validateBtn.addEventListener("click", validateAddresses);
el.optimizeBtn.addEventListener("click", optimizeRoute);
el.clearBtn.addEventListener("click", clearAll);
el.copyBtn.addEventListener("click", copyOptimizedOrder);
el.copyAllBtn.addEventListener("click", copyAllRoutes);
el.combineBtn.addEventListener("click", combineSelectedRoutes);
el.alertClose.addEventListener("click", hideError);

// Visited Stops Tracker controls.
el.clearRouteProgressBtn.addEventListener("click", clearProgressForThisRoute);
el.clearAllProgressBtn.addEventListener("click", clearAllVisitedProgress);
el.hideVisited.addEventListener("change", () => {
  state.hideVisited = el.hideVisited.checked;
  if (state.groups) renderGroups();
  else if (state.lastResult) renderResults(state.lastResult);
});
el.hideVisitedMarkers.addEventListener("change", () => {
  state.hideVisitedMarkers = el.hideVisitedMarkers.checked;
  updateAllMarkers();
});

// Live preview of how many stops the textarea would load.
el.stopsInput.addEventListener("input", previewCounter);

// Changing the start address invalidates validation.
el.start.addEventListener("input", () => {
  if (!state.needsValidation) markNeedsValidation();
});

// City restriction: any change requires re-validation.
el.cityEnabled.addEventListener("change", onCityToggle);
[el.cityName, el.cityCountry].forEach((node) =>
  node.addEventListener("input", () => {
    if (el.cityEnabled.checked && !state.needsValidation) markNeedsValidation();
  })
);
el.cityStrict.addEventListener("change", () => {
  if (el.cityEnabled.checked && !state.needsValidation) markNeedsValidation();
});

// Clustering mode: toggle inputs. (Clustering changes do NOT require
// re-validation - addresses are unchanged - only re-run Optimize.)
document.querySelectorAll('input[name="cluster"]').forEach((node) =>
  node.addEventListener("change", onClusterModeChange)
);

// Min/max stops per route.
el.useMinMax.addEventListener("change", () => { toggleMinMaxFields(); scheduleSave(); });
[el.minStops, el.maxStops].forEach((n) => n.addEventListener("input", scheduleSave));

// Save & share / sessions.
el.exportBtn.addEventListener("click", exportRouteFile);
el.importInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importRouteFile(file);
  e.target.value = ""; // allow re-importing the same file
});
el.saveLocalBtn.addEventListener("click", saveRouteLocally);
el.restoreLastBtn.addEventListener("click", restoreLastSession);
el.clearSessionBtn.addEventListener("click", clearSavedSession);
el.bannerRestore.addEventListener("click", restoreLastSession);
el.bannerIgnore.addEventListener("click", () => el.sessionBanner.classList.add("hidden"));
el.bannerDelete.addEventListener("click", clearSavedSession);

// Autosave on any meaningful control change (debounced).
[el.start, el.cityName, el.cityCountry, el.stopsPerRoute, el.numberOfRoutes,
 el.autoRecommended, el.distanceSensitivity, el.autoMaxStops].forEach((n) =>
  n && n.addEventListener("input", scheduleSave));
[el.cityEnabled, el.cityStrict, el.autoCombine].forEach((n) =>
  n && n.addEventListener("change", scheduleSave));
document.querySelectorAll('input[name="mode"], input[name="cluster"]').forEach((n) =>
  n.addEventListener("change", scheduleSave));

// Initialize UI state.
onClusterModeChange();
onCityToggle();
toggleMinMaxFields();
updateCounter();
renderSavedRoutes();
checkSavedSessionBanner();

// Load the map on startup.
loadGoogleMaps();
