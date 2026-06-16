# Route Optimizer Lite

A tiny, no-database web app for planning a multi-stop driving route. Paste a
starting address and a list of stops, validate them, optimize the visiting
order, see the route on a Google Map, remove cancelled stops, and re-run.

## 1. What the app does

- Enter a **starting address** and up to **50 stop addresses** (one per line). A
  live **"Stops: X / 50"** counter sits next to the textarea and updates as you
  load, edit, or delete stops.
- **Validate Addresses** — geocodes every address and shows a status badge:
  - 🟢 **Found** — precise match.
  - 🟡 **Ambiguous** — partial / broad match (city, region, postal code). Allowed, but shows the address Google matched.
  - 🟠 **City mismatch** — Google matched a different city than the one you required (see City restriction below). Blocks optimization in strict mode.
  - 🔴 **Not found** — must be fixed or deleted before optimizing.
  - ⚪ **Not validated** — not checked yet.
- **Optimize Route** — computes the best driving order in one of two modes:
  - **Return to start** — origin and destination are the start; all stops are optimized intermediates.
  - **End anywhere** — the app picks the best final stop (see notes below).
- **Split into route groups (clustering)** — divide many stops into several
  geographically-grouped routes, each optimized separately. Modes: *stops per
  route*, *number of routes*, or **auto cluster by distance** (the app decides how
  many groups based on how far apart the stops are). You can then **combine** or
  **separate** groups by hand and re-optimize (see below).
- **Restrict addresses to city** — force validation to a specific city/country so
  a stop typed for one city does not silently match a similar street elsewhere.
- Shows total **distance (km)**, **duration (h/m)**, whether **exact**,
  **approximate**, or **clustered** optimization was used, the **ordered stop
  list(s)**, and a **"Open in Waze"** deep link per stop.
- Draws **markers + the route polyline(s)** on a Google Map and fits the view to
  the route. Clustered routes get distinct colors and `route.stop` marker labels
  (e.g. `2.3` = Route 2, Stop 3).
- **Edit** or **Delete** any stop. After any change, the app requires you to **validate again** before optimizing.
- **Copy Optimized Order** / **Copy this route** / **Copy all route groups** copy the route(s) as text.
- **Visited Stops Tracker** — after optimizing, mark stops as visited while driving
  (per stop, per route group, and globally) without recalculating or calling
  Google; progress is saved in the browser (see below).
- **Save / share without a database** — automatic local autosave + restore,
  **Export / Import** route files (`.json`) for sharing between devices/users
  (including visited progress, no API keys), and an optional named local route
  library.
- **Min/max stops per route** — constrain clustering so each group has between a
  minimum and maximum number of stops (never above 25).

Everything is held in browser memory. There is **no database** and **no login**.

## 2. Enable the Google APIs

In the [Google Cloud Console](https://console.cloud.google.com/), create (or pick)
a project and enable these three APIs:

1. **Maps JavaScript API** — renders the map in the browser.
2. **Routes API** — computes and optimizes the route (`computeRoutes`).
3. **Geocoding API** — converts/validates addresses into coordinates.

Then create an **API key** under *APIs & Services → Credentials*. One key can be
used for all three for local development.

## 3. Create your `.env`

Copy the example and paste your key:

```bash
# Windows (PowerShell)
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Edit `.env`:

```
GOOGLE_MAPS_API_KEY=your_real_key_here
```

## 4. Install

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

## 5. Run

```bash
python app.py
```

## 6. Open

Visit: <http://127.0.0.1:5000>

## 7. The 25-intermediate-waypoint optimization limit

Google Routes API can optimize the order of **up to 25 intermediate waypoints**
per request (origin and destination are always fixed). So:

- **Return to start**: up to **25 stops** are optimized exactly by Google.
- **End anywhere**:
  - **1–10 stops** — the app tries *each* stop as the final destination, optimizes the rest as intermediates, and keeps the route with the lowest duration (distance as a tie-breaker).
  - **11–25 stops** — the app uses a heuristic: the stop **farthest from the start** (straight-line Haversine distance) becomes the destination, and the rest are optimized intermediates.

## 8. 26–50 stops: clustering vs. approximate mode

The app cap is **50 stops**, but ComputeRoutes optimizes at most **25
intermediate waypoints per request**, so a single exact route is impossible
beyond 25 stops. There are two ways to handle a large list:

### Clustering (recommended) — "Split into route groups"

Choose one of:

- **Cluster by stops per route** — you set how many stops each route should
  contain. The backend uses **greedy nearest-neighbor chunking** so each group is
  geographically compact. Example: 47 stops, 5 per route → 10 groups (9 × 5 + 1 × 2).
- **Cluster by number of routes** — you set how many route groups you want. The
  backend uses a **simple, dependency-free k-means** on latitude/longitude.
  Example: 50 stops, 10 groups → ~5 stops each.
- **Auto cluster by distance** — the app decides the number of route groups from
  how far apart the stops are (see below).

Then each cluster is optimized **separately** with ComputeRoutes, all starting
from the same start address, honoring the selected route mode (return to start /
end anywhere). Every cluster is capped at **25 stops**; if one would exceed that,
it is split automatically and the UI warns you.

> Clustering is **approximate geographic grouping**, not perfect multi-vehicle
> logistics optimization (no true VRP). It is fast, deterministic, and good
> enough for splitting a delivery list into sensible daily/driver routes.

### Auto cluster by distance

This mode does **not** ask you for a fixed number of stops or routes. Instead it
looks at the geographic distance between stops and decides how many route groups
make sense:

- **Recommended stops per route** (default 5) is a **soft target**, not a hard
  rule. Geographic closeness comes first; the target only keeps groups from being
  absurdly huge or tiny.
- **Distance sensitivity**: *Compact* (more, smaller groups), *Balanced*
  (default), or *Wide* (lets farther stops stay together).
- **Auto-combine small nearby routes** (default on) merges a lonely single-stop
  group into its nearest group when that still makes route sense.
- **Max stops per route** (default 25) — never exceeded, because of the Google
  limit.

Under the hood it uses **DBSCAN** (from scikit-learn) with the **Haversine**
metric. DBSCAN groups by density/distance and **does not require you to choose the
number of clusters in advance** — that is exactly why it fits "let the app
decide." The search radius (`eps`) is derived from the data (median
nearest-neighbor distance) and the chosen sensitivity, converted to radians
(`eps_radians = eps_km / 6371.0088`), with `min_samples=1` so every stop is
placed. Clusters are then **post-processed**: oversized groups are split with
nearest-neighbor chunking, and tiny groups may be merged — so no group exceeds 25
stops and sizes stay practical.

Example: 5 stops where 3 are in one city and 2 are far away in another → Auto
Cluster creates **2 route groups**, not one route of 5. The response includes a
short `clusterReason` per group and an `autoClusterSummary` explaining the count.

**Fallback:** if scikit-learn is not installed, the app uses a simple greedy
distance-grouping algorithm instead and shows: *"Using fallback auto-clustering
because scikit-learn is unavailable."* (Install it via `requirements.txt` to get
DBSCAN.)

### Adjust groups manually — Combine / Separate

Auto grouping is a starting point. On each route-group card you can:

- **Select route** (checkbox) on two or more cards, then **Combine selected
  routes** to merge them into one group — blocked if the result would exceed 25
  stops.
- **Separate this route** (shown when a group has ≥ 4 stops) to split it into two
  geographically close halves (simple 2-means in the browser).

Combining or separating changes the groups **locally** (no database) and marks the
result as needing re-optimization. Click **Optimize Route** again to recompute the
modified groups — the frontend then sends them to the backend as clustering
`mode: "manual"` with the exact stop groupings.

### Approximate mode (no clustering, > 25 stops)

If you leave clustering off and still have more than 25 stops, the app falls back
to **approximate mode**: nearest-neighbor ordering from the start, then routing in
≤ 25-waypoint chunks, combining totals approximately. The UI warns:

> Approximate mode: Google optimized routing supports up to 25 intermediate stops per request.

Entering more than 50 stops returns: *"Maximum 50 stops allowed."*

## 9. Visited Stops Tracker

After a route (or route groups) is calculated, you can mark stops as **visited**
while driving — a progress layer on top of the existing result.

- **This never recalculates the route and never calls Google.** It does not call
  `/api/optimize` or the Routes/Geocoding APIs. The optimized order stays stable —
  a visited stop is **not** moved to the bottom.
- Each stop row has **Mark visited** / **Undo**, a "Visited" badge, and a
  "Visited at HH:mm" time. Visited rows are faded with a line-through; their map
  marker turns green with a ✓ (unvisited markers keep their normal style; the
  start marker is never marked).
- **Per route group**: a progress bar + "X / Y visited", a "Route completed" tag
  when done, and **Mark entire route visited** / **Reset route progress**.
- **Global**: "12 / 50 stops visited", "24% completed", an overall bar, and a
  **Next Stop** panel (first unvisited stop in route order, with its group, a Waze
  button, and Mark visited) — or "All stops completed."
- **Show/Hide**: *Hide visited stops* collapses visited rows from the list;
  *Hide visited markers* hides them on the map. Default shows everything.

### Persistence (localStorage, no database)

Progress is saved only in the browser under a key derived from a **route
signature** (start address + ordered stop addresses + group structure):
`visitedStops:<signature>`. Because the page keeps no route in memory after a
reload, refresh the page and **re-optimize the same addresses** — the signature
matches and your visited marks are restored. Changing addresses, clustering, or
re-optimizing differently produces a new signature, so old progress is never
applied to a different route. Use **Clear progress for this route** or **Clear all
visited progress** to reset; clearing only affects visited state, not the
calculated route. Clearing browser storage also removes progress.

## 10. Saving, sharing, export & import (no database)

There is **no database** and **no server storage**. Routes are saved two ways,
both entirely in the browser / as files:

### Local autosave (same browser)

As you work, the app automatically saves the whole session to `localStorage`
under `routeOptimizerLite:lastSession` — start address, stops, validation
results, route mode, city restriction, clustering settings (including min/max),
the optimization result, route groups, visited progress, and the show/hide
toggles. On the next visit a banner appears — **"A saved local session was
found."** — with **Restore / Ignore / Delete saved session**. The **Save & share**
section also has **Restore last session** and **Clear saved session**. Restoring
redraws the map, route cards, group cards, progress bars, visited badges, the
Next Stop panel, Waze buttons and copy buttons **without calling Google**, as long
as the saved result includes coordinates and encoded polylines. If the saved data
has no optimization result, the form is restored and you're asked to click
**Optimize Route**. Local saves live only in that browser/device — they are not a
database and don't sync between users.

### Export / import a route file (sharing between devices/users)

- **Export Route File** downloads a JSON file (e.g.
  `route-optimizer-lite-2026-06-16.json`) containing everything needed to restore
  the route — addresses, settings, the optimized order, clusters, polylines,
  totals, **visited progress**, and min/max settings. The whole file is generated
  in the browser; nothing is sent to a server and **no API keys or secrets are
  included**.
- **Import Route File** reads a previously exported `.json` and restores it. The
  file is validated (`appName`, `schemaVersion`, required fields); an invalid file
  shows **"Invalid route file."** A valid file with an optimization result is
  redrawn from its saved data — **no Google calls** — and shows **"Route file
  imported and restored."** A file without a result restores the form and shows
  **"Route file imported. Click Optimize Route to calculate the route."**
- Sharing: one user exports a file and sends it to another, who imports it and
  sees the same addresses, route groups, map lines, Waze links (rebuilt from saved
  coordinates) and visited progress.
- Safety: imported JSON is treated as **data only** — never executed, rendered via
  safe text methods, with Waze links rebuilt from coordinates (never trusted from
  the file). Files from older versions missing min/max fields import fine using
  defaults.

### Save named routes locally (optional library)

In **Save & share**, type a name and click **Save route locally** to keep a route
under `routeOptimizerLite:savedRoutes`. The **Saved Routes** list shows each
route's name, date, stop count and mode, with **Load / Export / Delete**. These
are stored only in this browser.

## 11. Min/max stops per route

Independently of the clustering mode, tick **Use min/max stops per route** and set
**Minimum** and **Maximum**. After the initial clustering, the backend
post-processes the groups so each one falls within `[min, max]` when practical:
oversized groups are split into balanced, geographically-ordered chunks;
under-min groups are merged into the nearest compatible group; and, if needed,
the nearest stops are moved between groups.

Rules: min ≥ 1, max ≤ 25, and min ≤ max — invalid combinations are blocked with a
clear error. No group may ever exceed 25 (Google's intermediate-waypoint limit).
The constraints apply to *stops per route*, *number of routes*, and *auto cluster
by distance*; manual groups are kept as-is but **warn** if outside the range.

Examples (min = 5, max = 6): 50 → groups of 6 and 5; 23 → 6, 6, 6, 5; 12 → 6, 6;
11 → 6, 5. When the total makes it impossible (e.g. 9 stops → 5, 4) the app keeps
the best practical result and warns: *"Could not satisfy minimum stops for every
route because of the total number of stops."* A route card shows a **Below min** /
**Above max** badge when a group is out of range, and the response includes a
`clusterSizeSummary` (`allClustersWithinMin` / `allClustersWithinMax`). Export and
import preserve the min/max settings and the summary.

## 12. City restriction (avoid wrong-city matches)

Sometimes a street name exists in several cities (e.g. an address typed for
**Ramla** can match a similar street in **Rosh HaAyin**). Enable **"Restrict
results to a specific city"**, type the city and a country code (default `IL`):

- Before geocoding, the city/country are appended to each query when missing
  (e.g. `Ben Gurion 5` → `Ben Gurion 5, Ramla, Israel`), and a
  `components=country:XX` filter is applied.
- After geocoding, the **matched city** is read from Google's
  `address_components` (`locality` / `postal_town` / `administrative_area_level_2`,
  with fallbacks) and compared to the requested city. Comparison is
  normalized (lowercase, punctuation stripped) and uses a small Hebrew/English
  **alias table** (Ramla/רמלה, Tel Aviv/תל אביב/Tel Aviv-Yafo, Jerusalem/ירושלים,
  Rishon LeZion, Petah Tikva, Rosh HaAyin, …).
- On mismatch the address is marked **`city_mismatch`** with a message like:
  *"Requested city: Ramla. Google matched: Rosh HaAyin."*

**Strict city match** (on by default) blocks optimization until every mismatch is
fixed. Turn strict off to allow optimization with a visible warning instead.

## 13. Re-validation rules

Validation is marked **stale** (and Optimize is disabled) whenever you change the
**start address**, any **stop**, or the **city restriction** — anything that
affects geocoding. Changing **clustering settings**, the **route mode**, or using
**Combine / Separate** does **not** require re-validation (addresses are
unchanged); it only marks the *optimization* as stale — just press **Optimize
Route** again to recalculate.

## 14. No database — data resets on reload

There is no database, no accounts, and no server-side storage. All addresses and
results live in the browser tab. Reloading clears the in-memory working state, but
the app keeps three things in `localStorage` (this browser only): the autosaved
session (`routeOptimizerLite:lastSession`), named saved routes
(`routeOptimizerLite:savedRoutes`), and Visited Stops Tracker progress
(`visitedStops:<routeSignature>`). On reload, restore via the banner / **Restore
last session**, or import a route file. Clearing browser storage removes all of
these.

## 15. Restrict your API keys before deploying publicly

This MVP exposes the Maps JavaScript key to the browser via `/api/config`, which
is fine for **local** use. Before any public deployment:

- Restrict the **browser key** by **HTTP referrer** (your domain) and to only the
  *Maps JavaScript API*.
- Use a **separate server key** for Geocoding / Routes, restricted by **API**
  (and IP if possible), and keep it server-side only.
- Add **billing alerts / quotas** to avoid surprise usage.

## API assumptions

- Geocoding "ambiguous" is inferred from Google's `partial_match` flag or when the
  best result is only a broad type (country, region, locality, postal code, route)
  with no precise type (street address, premise, establishment, etc.).
- "City mismatch" compares the matched `locality`/`postal_town`/admin-area against
  the requested city using a normalized comparison + a small alias table. It is a
  best-effort guard, not a guarantee — keep an eye on ambiguous results too.
- Stop coordinates for markers/Waze come from a backend geocode during `/api/optimize`
  (reused across every cluster, so the optimizer geocodes each stop once per run).
  Exact duplicate stop lines (case-insensitive) and empty lines are removed.
- Clustering uses straight-line (Haversine) distance for grouping only; the actual
  per-route distances/durations come from real ComputeRoutes calls.
- scikit-learn + numpy are **optional**. With them, Auto Cluster uses DBSCAN;
  without them it uses the built-in greedy fallback (and warns).
- `routingPreference: TRAFFIC_AWARE` is used; durations reflect typical traffic.

### `/api/optimize` request — `clustering` shapes

```jsonc
// stops per route
"clustering": { "enabled": true, "mode": "stops_per_route", "stopsPerRoute": 5 }

// number of routes
"clustering": { "enabled": true, "mode": "number_of_routes", "numberOfRoutes": 10 }

// auto cluster by distance
"clustering": { "enabled": true, "mode": "auto_distance",
                "recommendedStopsPerRoute": 5, "distanceSensitivity": "balanced",
                "autoCombineSmallRoutes": true, "maxStopsPerRoute": 25 }

// manual (after Combine/Separate) — arrays of original stop indexes
"clustering": { "enabled": true, "mode": "manual",
                "manualClusters": [[0, 2, 4], [1, 3]] }
```

A clustered response has `mode: "clustered"`, `clusterMode` (the mode used), a
`clusters` array (each with `clusterIndex`, `title`, `stopCount`, totals,
`encodedPolylines`, `orderedStops`; auto mode adds `clusterReason` and
`averageDistanceFromClusterCenterKm`), `grandTotal*` fields, a `warnings` array,
and — for auto mode — an `autoClusterSummary`. Non-clustered runs keep the original
single-route shape (`orderedStops` + totals at the top level), so both are
supported. Manual clusters are validated: every stop index must appear exactly
once and no group may exceed 25 stops.

## Project structure

```
.
├── app.py               # Flask backend + Google API helpers
├── requirements.txt     # flask, requests, python-dotenv, scikit-learn, numpy
├── .env.example         # copy to .env and add your key
├── templates/
│   └── index.html       # single-page UI
├── static/
│   ├── styles.css       # dark theme
│   └── app.js           # all frontend logic (state, validation, map)
└── README.md
```
