"""
Route Optimizer Lite - Flask backend.

A small, no-database MVP that:
  * Geocodes / validates addresses (Google Geocoding API), with optional
    city restriction to avoid wrong-city matches.
  * Optimizes driving order (Google Routes API - computeRoutes).
  * Splits large stop lists into geographic route groups (clustering).
  * Returns polylines + ordered stops for a map + Waze deep links.

Everything lives in browser memory on the frontend; this server is stateless.

API limit reminder: ComputeRoutes optimizes up to 25 intermediate waypoints
per request. We keep the app cap at 50 stops and never send more than 25
intermediates in a single request (we cluster instead).
"""

import os
import re
import json
import math

import requests
from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv

# Optional: scikit-learn powers DBSCAN distance-based auto-clustering. When it is
# not installed the app falls back to a simple greedy algorithm (with a warning).
try:
    import numpy as np
    from sklearn.cluster import DBSCAN
    SKLEARN_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    SKLEARN_AVAILABLE = False

# Load GOOGLE_MAPS_API_KEY from the .env file (if present).
load_dotenv()
API_KEY = (os.environ.get("GOOGLE_MAPS_API_KEY") or "").strip()

# --- Constants ---------------------------------------------------------------

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

MAX_STOPS = 50              # Hard cap on stops accepted from the user.
EXACT_OPT_LIMIT = 25        # Google optimizes up to 25 intermediate waypoints.
MAX_CLUSTER_SIZE = 25       # Never exceed 25 stops in one cluster (= one request).
SMALL_END_ANYWHERE = 10     # "Try every stop as destination" threshold.
CHUNK_POINTS = 25           # Points per ComputeRoutes call in approximate mode.
EARTH_RADIUS_KM = 6371.0088 # Mean Earth radius (km) for km <-> radians conversion.

# Field mask required by the Routes API to return the data we need.
ROUTES_FIELD_MASK = (
    "routes.duration,"
    "routes.distanceMeters,"
    "routes.polyline.encodedPolyline,"
    "routes.optimizedIntermediateWaypointIndex,"
    "routes.legs"
)

# Geocoding result types that indicate a broad / low-precision match.
BROAD_TYPES = {
    "country", "administrative_area_level_1", "administrative_area_level_2",
    "administrative_area_level_3", "locality", "sublocality", "neighborhood",
    "postal_code", "postal_code_prefix", "route", "political", "colloquial_area",
}
# Types that indicate a precise, specific location.
SPECIFIC_TYPES = {
    "street_address", "premise", "subpremise", "establishment",
    "point_of_interest", "intersection", "plus_code",
}

# Component types we read to figure out which city Google actually matched.
CITY_COMPONENT_TYPES = [
    "locality", "postal_town", "administrative_area_level_2",
    "sublocality", "administrative_area_level_1",
]

# Minimal country code -> name map (used when appending to a geocode query).
COUNTRY_NAMES = {
    "IL": "Israel", "US": "United States", "GB": "United Kingdom",
    "CA": "Canada", "AU": "Australia", "FR": "France", "DE": "Germany",
    "ES": "Spain", "IT": "Italy", "IN": "India",
}

app = Flask(__name__)


# --- Clean error type --------------------------------------------------------

class RouteError(Exception):
    """A user-facing error. Endpoints turn this into clean JSON (no traceback)."""

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def require_api_key():
    """Raise a clean error if the API key was never configured."""
    if not API_KEY:
        raise RouteError(
            "Server is missing GOOGLE_MAPS_API_KEY. Copy .env.example to .env "
            "and add your key.",
            status_code=500,
        )


# --- City normalization / aliases -------------------------------------------

def normalize_city(name):
    """Lowercase, strip punctuation, collapse whitespace. Keeps Hebrew letters."""
    text = (name or "").lower().strip()
    # Remove anything that is not a word char (incl. Hebrew via \w/unicode),
    # the Hebrew block, or whitespace.
    text = re.sub(r"[^\w֐-׿\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# Raw alias spellings -> canonical key. Hebrew + English variants.
_RAW_CITY_ALIASES = {
    "Ramla": "ramla", "Ramle": "ramla", "רמלה": "ramla",
    "Tel Aviv": "tel_aviv", "Tel Aviv-Yafo": "tel_aviv", "Tel Aviv Yafo": "tel_aviv",
    "תל אביב": "tel_aviv", "תל אביב-יפו": "tel_aviv", "תל אביב יפו": "tel_aviv",
    "Jerusalem": "jerusalem", "ירושלים": "jerusalem",
    "Rishon LeZion": "rishon", "Rishon Le Zion": "rishon", "ראשון לציון": "rishon",
    "Petah Tikva": "petah_tikva", "Petach Tikva": "petah_tikva",
    "פתח תקווה": "petah_tikva",
    "Rosh HaAyin": "rosh_haayin", "Rosh Ha'Ayin": "rosh_haayin",
    "Rosh Ha Ayin": "rosh_haayin", "ראש העין": "rosh_haayin",
}
# Normalized-spelling -> canonical key.
CITY_ALIASES = {normalize_city(k): v for k, v in _RAW_CITY_ALIASES.items()}
# Canonical key -> list of known normalized spellings (for fallback matching).
CANONICAL_TO_NAMES = {}
for _norm, _canon in CITY_ALIASES.items():
    CANONICAL_TO_NAMES.setdefault(_canon, []).append(_norm)


def canonical_city(name):
    """Map a city name to a canonical key (via alias table or its normalized form)."""
    norm = normalize_city(name)
    return CITY_ALIASES.get(norm, norm)


def extract_city(address_components):
    """Pull the best 'city' value from Google address_components."""
    by_type = {}
    for comp in address_components or []:
        for type_name in comp.get("types", []):
            by_type.setdefault(type_name, comp.get("long_name"))
    for type_name in CITY_COMPONENT_TYPES:
        if by_type.get(type_name):
            return by_type[type_name]
    return None


def cities_match(requested_city, matched_city, formatted_address):
    """
    True when the matched city equals the requested city.
    Falls back to scanning the formatted address when no city component exists.
    """
    requested_canon = canonical_city(requested_city)

    if matched_city:
        return canonical_city(matched_city) == requested_canon

    # No city component returned -> check the formatted address text.
    haystack = normalize_city(formatted_address)
    names = CANONICAL_TO_NAMES.get(requested_canon, [])
    names = set(names) | {normalize_city(requested_city)}
    return any(name and name in haystack for name in names)


# --- Small utilities ---------------------------------------------------------

def haversine_distance(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points in meters."""
    radius = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = (math.sin(d_phi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2)
    return 2 * radius * math.asin(math.sqrt(a))


def _hav(a, b):
    """Haversine helper for {lat,lng} dicts."""
    return haversine_distance(a["lat"], a["lng"], b["lat"], b["lng"])


def build_waze_url(lat, lng):
    """Build a Waze deep link that starts navigation to the given coordinates."""
    if lat is None or lng is None:
        return None
    return f"https://waze.com/ul?ll={lat},{lng}&navigate=yes"


def parse_google_duration(duration):
    """Convert a Routes API duration (e.g. '1800s') into integer seconds."""
    if duration is None:
        return 0
    if isinstance(duration, (int, float)):
        return int(duration)
    text = str(duration).strip()
    if text.endswith("s"):
        text = text[:-1]
    try:
        return int(float(text))
    except ValueError:
        return 0


def dedupe(items):
    """Remove exact (case-insensitive) duplicates while preserving order."""
    seen, out = set(), []
    for item in items:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


# --- Geocoding / validation --------------------------------------------------

def _build_geocode_query(address, city, country):
    """
    Build the address string sent to the Geocoding API. When a city is given
    and not already present in the address, append ", City[, Country]".
    """
    if not city:
        return address
    base = address
    if normalize_city(city) not in normalize_city(address):
        base = f"{address}, {city}"
    if country:
        country_name = COUNTRY_NAMES.get(country.upper(), country)
        if normalize_city(country_name) not in normalize_city(base):
            base = f"{base}, {country_name}"
    return base


def _geo(status, input_addr, query_used, formatted, lat, lng,
         requested_city, matched_city, message):
    """Keep geocode result shape consistent across all return paths."""
    return {
        "status": status,
        "input": input_addr,
        "queryUsed": query_used,
        "formattedAddress": formatted,
        "lat": lat,
        "lng": lng,
        "requestedCity": requested_city,
        "matchedCity": matched_city,
        "message": message,
    }


def geocode_address(address, city=None, country=None):
    """
    Geocode one address (optionally restricted to a city/country).
    Returns a normalized dict (see _geo). status is one of:
        found / ambiguous / not_found / city_mismatch
    Never raises for a "bad address" - only for hard API/network failures.
    """
    require_api_key()
    address = (address or "").strip()
    requested_city = city or None

    if not address:
        return _geo("not_found", address, address, None, None, None,
                    requested_city, None, "Empty address.")

    query_used = _build_geocode_query(address, city, country)
    params = {"address": query_used, "key": API_KEY}
    if country:
        params["components"] = f"country:{country.upper()}"

    try:
        resp = requests.get(GEOCODE_URL, params=params, timeout=15)
        data = resp.json()
    except requests.RequestException as exc:
        raise RouteError(f"Network error contacting Geocoding API: {exc}", 502)
    except ValueError:
        raise RouteError("Invalid response from Geocoding API.", 502)

    status = data.get("status")

    if status == "ZERO_RESULTS":
        return _geo("not_found", address, query_used, None, None, None,
                    requested_city, None,
                    "This address could not be found. Please edit or delete it.")

    if status == "OK" and data.get("results"):
        result = data["results"][0]
        location = result["geometry"]["location"]
        formatted = result.get("formatted_address")
        types = set(result.get("types", []))
        partial = bool(result.get("partial_match", False))
        matched_city = extract_city(result.get("address_components", []))

        # City restriction check takes priority over the ambiguity check.
        if requested_city and not cities_match(requested_city, matched_city, formatted):
            return _geo("city_mismatch", address, query_used, formatted,
                        location["lat"], location["lng"], requested_city,
                        matched_city,
                        f"Requested city: {requested_city}. "
                        f"Google matched: {matched_city or 'unknown'}.")

        # Ambiguous when Google flags a partial match, or when the result is
        # only a broad area (city/region/postal) with no precise type.
        is_broad = bool(types & BROAD_TYPES) and not (types & SPECIFIC_TYPES)
        if partial or is_broad:
            return _geo("ambiguous", address, query_used, formatted,
                        location["lat"], location["lng"], requested_city,
                        matched_city,
                        f"Google matched this as: {formatted}. Check before optimizing.")

        return _geo("found", address, query_used, formatted,
                    location["lat"], location["lng"], requested_city,
                    matched_city, None)

    # Hard API errors (denied key, quota, invalid request) -> clean error.
    message = data.get("error_message") or status or "Unknown geocoding error."
    if status in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST"):
        raise RouteError(f"Geocoding API error: {message}", 502)

    # Anything else: treat as not found rather than crashing.
    return _geo("not_found", address, query_used, None, None, None,
                requested_city, None, f"Could not geocode: {message}")


def validate_address(address, city=None, country=None):
    """Validate a single address (thin wrapper around geocode_address)."""
    return geocode_address(address, city, country)


def validate_addresses(start_address, stops, city_restriction):
    """
    Validate the start address and every stop. Honors city restriction.
    Returns the full payload for /api/validate-addresses.
    """
    city = city_restriction["city"]
    country = city_restriction["country"]
    strict = city_restriction["strict"]

    def to_out(result, index=None):
        out = {
            "input": result["input"],
            "queryUsed": result["queryUsed"],
            "status": result["status"],
            "formattedAddress": result["formattedAddress"],
            "lat": result["lat"],
            "lng": result["lng"],
            "requestedCity": result["requestedCity"],
            "matchedCity": result["matchedCity"],
            "message": result["message"],
        }
        if index is not None:
            out = {"index": index, **out}
        return out

    start = validate_address(start_address, city, country)
    start_out = to_out(start)

    stops_out, warnings = [], []
    blocked = False

    if start["status"] == "not_found":
        blocked = True
    elif start["status"] == "city_mismatch":
        if strict:
            blocked = True
        warnings.append(f"Start city mismatch: requested {start['requestedCity']}, "
                        f"matched {start['matchedCity'] or 'unknown'}.")
    elif start["status"] == "ambiguous":
        warnings.append(f"Start is ambiguous: {start['formattedAddress']}")

    for index, stop in enumerate(stops):
        result = validate_address(stop, city, country)
        stops_out.append(to_out(result, index))
        if result["status"] == "not_found":
            blocked = True
        elif result["status"] == "city_mismatch":
            if strict:
                blocked = True
            warnings.append(f"Stop {index + 1} city mismatch: requested "
                            f"{result['requestedCity']}, matched "
                            f"{result['matchedCity'] or 'unknown'}.")
        elif result["status"] == "ambiguous":
            warnings.append(f"Stop {index + 1} is ambiguous: {result['formattedAddress']}")

    return {
        "success": True,
        "start": start_out,
        "stops": stops_out,
        "canOptimize": not blocked,
        "warnings": warnings,
    }


# --- Routes API --------------------------------------------------------------

def _waypoint(value):
    """
    Build a Routes API waypoint. Accepts either an address string or a
    {lat, lng} dict (we use coordinates to avoid re-geocoding).
    """
    if isinstance(value, dict) and value.get("lat") is not None:
        return {"location": {"latLng": {
            "latitude": value["lat"], "longitude": value["lng"]}}}
    return {"address": str(value)}


def compute_route(origin, destination, intermediates=None, optimize=True):
    """
    Call Routes API computeRoutes. Returns a normalized dict:
        { duration, distanceMeters, encodedPolyline, optimizedIndex, legs }
    """
    require_api_key()
    intermediates = intermediates or []

    body = {
        "origin": _waypoint(origin),
        "destination": _waypoint(destination),
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "polylineQuality": "HIGH_QUALITY",
    }
    if intermediates:
        body["intermediates"] = [_waypoint(x) for x in intermediates]
        body["optimizeWaypointOrder"] = bool(optimize)

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    }

    try:
        resp = requests.post(ROUTES_URL, headers=headers,
                             data=json.dumps(body), timeout=30)
        data = resp.json()
    except requests.RequestException as exc:
        raise RouteError(f"Network error contacting Routes API: {exc}", 502)
    except ValueError:
        raise RouteError("Invalid response from Routes API.", 502)

    if resp.status_code != 200:
        message = None
        if isinstance(data, dict):
            message = (data.get("error") or {}).get("message")
        raise RouteError(f"Routes API error: {message or resp.status_code}", 502)

    routes = data.get("routes") or []
    if not routes:
        raise RouteError("No route could be computed for these addresses.", 400)

    route = routes[0]
    return {
        "duration": parse_google_duration(route.get("duration")),
        "distanceMeters": route.get("distanceMeters", 0) or 0,
        "encodedPolyline": (route.get("polyline") or {}).get("encodedPolyline"),
        "optimizedIndex": route.get("optimizedIntermediateWaypointIndex"),
        "legs": route.get("legs", []),
    }


# --- Optimization core (works on geocoded stop objects) ----------------------
#
# A "stop object" looks like:
#   { "originalIndex": int, "address": str, "formattedAddress": str|None,
#     "lat": float, "lng": float }

def _geocode_point(address, city=None, country=None):
    """Geocode an address that MUST resolve (used to get coords)."""
    result = geocode_address(address, city, country)
    if result["lat"] is None:
        raise RouteError(f"Could not geocode address: {address}", 400)
    return result


def _coord(obj):
    """Return a {lat,lng} waypoint dict from a stop/start object."""
    return {"lat": obj["lat"], "lng": obj["lng"]}


def _build_ordered(order, stop_objs):
    """Build the orderedStops list from an order of indices into stop_objs."""
    ordered = []
    for position, idx in enumerate(order):
        obj = stop_objs[idx]
        ordered.append({
            "originalIndex": obj["originalIndex"],
            "optimizedIndex": position + 1,
            "address": obj["address"],
            "formattedAddress": obj.get("formattedAddress"),
            "lat": obj["lat"],
            "lng": obj["lng"],
            "wazeUrl": build_waze_url(obj["lat"], obj["lng"]),
        })
    return ordered


def _core(ordered, distance, duration, polylines):
    """Shared shape for one optimized route (cluster or single)."""
    return {
        "orderedStops": ordered,
        "totalDistanceMeters": distance,
        "totalDurationSeconds": duration,
        "encodedPolylines": [p for p in polylines if p],
    }


def _optimize_points(start_point, stop_objs, return_to_start):
    """
    Optimize a single route over already-geocoded stop objects (<= 25 stops).
    Uses coordinates as waypoints (no re-geocoding). Returns a _core() dict.
    """
    start_coord = _coord(start_point)
    count = len(stop_objs)

    # Mode A: return to start - all stops are optimized intermediates.
    if return_to_start:
        intermediates = [_coord(o) for o in stop_objs]
        route = compute_route(start_coord, start_coord, intermediates, optimize=True)
        order = route["optimizedIndex"] or list(range(count))
        return _core(_build_ordered(order, stop_objs),
                     route["distanceMeters"], route["duration"],
                     [route["encodedPolyline"]])

    # Mode B: end anywhere.
    if count == 1:
        route = compute_route(start_coord, _coord(stop_objs[0]), [], optimize=False)
        return _core(_build_ordered([0], stop_objs),
                     route["distanceMeters"], route["duration"],
                     [route["encodedPolyline"]])

    if count <= SMALL_END_ANYWHERE:
        # Try each stop as the final destination; keep the cheapest route.
        best = None
        for candidate in range(count):
            inter_idx = [i for i in range(count) if i != candidate]
            inter = [_coord(stop_objs[i]) for i in inter_idx]
            route = compute_route(start_coord, _coord(stop_objs[candidate]),
                                  inter, optimize=True)
            key = (route["duration"], route["distanceMeters"])  # duration, tie->distance
            if best is None or key < best["key"]:
                best = {"key": key, "route": route,
                        "candidate": candidate, "inter_idx": inter_idx}
        return _finish_end_anywhere(best["route"], best["candidate"],
                                    best["inter_idx"], stop_objs)

    # 11-25 stops: heuristic - farthest stop (Haversine) becomes destination.
    distances = [_hav(start_point, o) for o in stop_objs]
    candidate = max(range(count), key=lambda i: distances[i])
    inter_idx = [i for i in range(count) if i != candidate]
    inter = [_coord(stop_objs[i]) for i in inter_idx]
    route = compute_route(start_coord, _coord(stop_objs[candidate]),
                          inter, optimize=True)
    return _finish_end_anywhere(route, candidate, inter_idx, stop_objs)


def _finish_end_anywhere(route, candidate, inter_idx, stop_objs):
    """Reconstruct the visiting order for an end-anywhere route + build _core()."""
    optimized = route["optimizedIndex"] or list(range(len(inter_idx)))
    order = [inter_idx[i] for i in optimized] + [candidate]
    return _core(_build_ordered(order, stop_objs),
                 route["distanceMeters"], route["duration"],
                 [route["encodedPolyline"]])


def optimize_cluster(start_point, cluster_stops, return_to_start, end_anywhere=None):
    """
    Optimize one cluster (<= 25 stops). `end_anywhere` is accepted for clarity
    but the behavior is driven by `return_to_start`. Returns a _core() dict.
    """
    return _optimize_points(start_point, cluster_stops, return_to_start)


def approximate_large_route(start_point, start_address, stop_objs, return_to_start):
    """
    Non-clustered fallback for > 25 stops: nearest-neighbor order, then route
    chunks (<= 25 waypoints each). Not guaranteed optimal - the UI warns.
    """
    count = len(stop_objs)

    # Nearest-neighbor ordering from the start point.
    unvisited = set(range(count))
    order = []
    cur = start_point
    while unvisited:
        nxt = min(unvisited, key=lambda i: _hav(cur, stop_objs[i]))
        order.append(nxt)
        unvisited.discard(nxt)
        cur = stop_objs[nxt]

    # Full coordinate path (reuse geocoded coords -> no extra geocoding).
    points = [_coord(start_point)] + [_coord(stop_objs[i]) for i in order]
    if return_to_start:
        points.append(_coord(start_point))

    total_distance, total_duration, polylines = 0, 0, []
    i = 0
    while i < len(points) - 1:
        chunk = points[i:i + CHUNK_POINTS]
        if len(chunk) < 2:
            break
        route = compute_route(chunk[0], chunk[-1], chunk[1:-1], optimize=False)
        total_distance += route["distanceMeters"]
        total_duration += route["duration"]
        if route["encodedPolyline"]:
            polylines.append(route["encodedPolyline"])
        i += CHUNK_POINTS - 1  # overlap by one point so segments connect

    warning = ("Approximate mode: Google optimized routing supports up to 25 "
               "intermediate stops per request. For better results with this "
               "many stops, use 'Split into route groups' (clustering).")
    return {
        "mode": "approximate",
        "warning": warning,
        "start": {"address": start_address,
                  "lat": start_point["lat"], "lng": start_point["lng"]},
        **_core(_build_ordered(order, stop_objs),
                total_distance, total_duration, polylines),
    }


# --- Clustering --------------------------------------------------------------

def greedy_nearest_neighbor_groups(stops, group_size):
    """
    Greedy nearest-neighbor chunking into groups of at most `group_size`.
    Deterministic: seeds from the west-most remaining stop each time.
    """
    group_size = max(1, int(group_size))
    remaining = sorted(stops, key=lambda s: (s["lng"], s["lat"]))
    groups = []
    while remaining:
        seed = remaining.pop(0)
        group = [seed]
        cur = seed
        while len(group) < group_size and remaining:
            nxt = min(remaining, key=lambda s: _hav(cur, s))
            remaining.remove(nxt)
            group.append(nxt)
            cur = nxt
        groups.append(group)
    return groups


def simple_kmeans_clusters(stops, k, max_iter=50):
    """
    Simple, dependency-free k-means on lat/lng using Haversine distance.
    Deterministic seeding (evenly spaced along longitude). Drops empty clusters.
    """
    n = len(stops)
    k = max(1, min(int(k), n))

    ordered = sorted(stops, key=lambda s: (s["lng"], s["lat"]))
    centroids = []
    for i in range(k):
        idx = round(i * (n - 1) / (k - 1)) if k > 1 else 0
        centroids.append({"lat": ordered[idx]["lat"], "lng": ordered[idx]["lng"]})

    assignments = [None] * n
    clusters = [[] for _ in range(k)]
    for _ in range(max_iter):
        changed = False
        clusters = [[] for _ in range(k)]
        for i, stop in enumerate(stops):
            ci = min(range(k), key=lambda c: _hav(centroids[c], stop))
            clusters[ci].append(stop)
            if assignments[i] != ci:
                assignments[i] = ci
                changed = True
        for c in range(k):
            if clusters[c]:
                centroids[c] = {
                    "lat": sum(s["lat"] for s in clusters[c]) / len(clusters[c]),
                    "lng": sum(s["lng"] for s in clusters[c]) / len(clusters[c]),
                }
        if not changed:
            break

    return [c for c in clusters if c]


def cluster_by_stops_per_route(stops, stops_per_route):
    """Group stops so each route has about `stops_per_route` nearby stops."""
    size = max(1, min(int(stops_per_route), MAX_CLUSTER_SIZE))
    return greedy_nearest_neighbor_groups(stops, size)


def cluster_by_number_of_routes(stops, number_of_routes):
    """Split stops into `number_of_routes` geographic groups (k-means)."""
    return simple_kmeans_clusters(stops, max(1, int(number_of_routes)))


def _enforce_cluster_limit(clusters):
    """Split any cluster larger than 25 stops; report whether a split happened."""
    final, split_happened = [], False
    for cluster in clusters:
        if len(cluster) > MAX_CLUSTER_SIZE:
            split_happened = True
            final.extend(greedy_nearest_neighbor_groups(cluster, MAX_CLUSTER_SIZE))
        else:
            final.append(cluster)
    return final, split_happened


# --- Auto cluster by distance (DBSCAN + post-processing) ---------------------

def cluster_center(cluster):
    """Mean {lat, lng} of a cluster of stops."""
    n = max(1, len(cluster))
    return {
        "lat": sum(s["lat"] for s in cluster) / n,
        "lng": sum(s["lng"] for s in cluster) / n,
    }


def cluster_center_distance_km(cluster_a, cluster_b):
    """Distance (km) between the centers of two clusters."""
    a, b = cluster_center(cluster_a), cluster_center(cluster_b)
    return haversine_distance(a["lat"], a["lng"], b["lat"], b["lng"]) / 1000.0


def _cluster_spread_km(cluster):
    """Average distance (km) of stops from their cluster center (compactness)."""
    if len(cluster) <= 1:
        return 0.0
    center = cluster_center(cluster)
    total = sum(
        haversine_distance(center["lat"], center["lng"], s["lat"], s["lng"]) / 1000.0
        for s in cluster
    )
    return total / len(cluster)


def nearest_neighbor_chunk(cluster, chunk_size):
    """Split a cluster into nearest-neighbor chunks of at most `chunk_size`."""
    return greedy_nearest_neighbor_groups(cluster, chunk_size)


def calculate_auto_eps_km(stops, recommended_stops_per_route, distance_sensitivity):
    """
    Pick a DBSCAN radius (in km) from the data + the chosen sensitivity.

    Steps:
      1. Find each stop's nearest-neighbor distance.
      2. Use the median nearest-neighbor distance as a base scale.
      3. Multiply by a sensitivity factor (compact < balanced < wide).
      4. Nudge slightly by the recommended stops-per-route target.
      5. Clamp to [0.5, 25] km.
    """
    n = len(stops)
    if n <= 1:
        return 1.0

    # 1) nearest-neighbor distance per stop (km)
    nearest = []
    for i, s in enumerate(stops):
        best = None
        for j, t in enumerate(stops):
            if i == j:
                continue
            d = haversine_distance(s["lat"], s["lng"], t["lat"], t["lng"]) / 1000.0
            if best is None or d < best:
                best = d
        nearest.append(best if best is not None else 0.5)

    # 2) median nearest-neighbor distance
    nearest.sort()
    median_nn = nearest[len(nearest) // 2]
    base = median_nn if median_nn > 0 else 0.5

    # 3) sensitivity factor
    factor = {"compact": 1.0, "balanced": 1.8, "wide": 3.0}.get(
        (distance_sensitivity or "balanced").lower(), 1.8)
    eps = base * factor

    # 4) gentle nudge toward the recommended target (default 5):
    #    larger targets -> slightly larger radius (fewer, bigger groups).
    recommended = max(2, min(int(recommended_stops_per_route or 5), 25))
    eps *= 1.0 + (recommended - 5) * 0.05

    # 5) clamp
    return max(0.5, min(eps, 25.0))


def run_dbscan_clustering(stops, eps_km):
    """Cluster stops with DBSCAN (Haversine). Requires scikit-learn + numpy."""
    coords = np.radians([[s["lat"], s["lng"]] for s in stops])
    eps_radians = eps_km / EARTH_RADIUS_KM
    labels = DBSCAN(eps=eps_radians, min_samples=1,
                    metric="haversine").fit_predict(coords)
    groups = {}
    for stop, label in zip(stops, labels):
        groups.setdefault(int(label), []).append(stop)
    return [groups[key] for key in sorted(groups)]


def _fallback_distance_clusters(stops, eps_km, recommended, max_stops):
    """
    Greedy distance-based clustering used when scikit-learn is unavailable.
    Grow a group with nearby stops while staying near the recommended size,
    but keep adding very-close stops even past the target.
    """
    remaining = sorted(stops, key=lambda s: (s["lng"], s["lat"]))
    clusters = []
    while remaining:
        seed = remaining.pop(0)
        group = [seed]
        cur = seed
        while remaining and len(group) < max_stops:
            nxt = min(remaining, key=lambda s: _hav(cur, s))
            d_km = _hav(cur, nxt) / 1000.0
            close_enough = d_km <= eps_km
            very_close = d_km <= eps_km * 0.5
            # Add while near; past the recommended size only keep very-close stops.
            if close_enough and (len(group) < recommended or very_close):
                group.append(nxt)
                remaining.remove(nxt)
                cur = nxt
            else:
                break
        clusters.append(group)
    return clusters


def split_large_clusters(clusters, max_stops_per_route, recommended_stops_per_route):
    """
    Split clusters that are too big to be practical:
      * always split anything over max_stops_per_route (Google's hard limit), and
      * split anything much larger than the recommended target (> 2x) unless the
        stops are extremely tight together.
    """
    chunk = max(2, min(int(recommended_stops_per_route), int(max_stops_per_route)))
    soft_limit = recommended_stops_per_route * 2
    out = []
    for cluster in clusters:
        too_big = len(cluster) > max_stops_per_route
        much_bigger = len(cluster) > soft_limit and _cluster_spread_km(cluster) > 1.0
        if too_big or much_bigger:
            out.extend(nearest_neighbor_chunk(cluster, chunk))
        else:
            out.append(cluster)
    return out


def combine_small_nearby_clusters(clusters, max_stops_per_route, distance_sensitivity):
    """
    Merge tiny (single-stop) clusters into their nearest neighbor cluster when
    that is still sensible: within a sensitivity-based radius and under the cap.
    """
    merge_radius_km = {"compact": 2.0, "balanced": 5.0, "wide": 10.0}.get(
        (distance_sensitivity or "balanced").lower(), 5.0)
    clusters = [list(c) for c in clusters]

    changed = True
    while changed:
        changed = False
        for i, cluster in enumerate(clusters):
            if len(cluster) != 1:
                continue  # only auto-merge isolated single stops
            best_j, best_d = None, None
            for j, other in enumerate(clusters):
                if j == i:
                    continue
                d = cluster_center_distance_km(cluster, other)
                if best_d is None or d < best_d:
                    best_d, best_j = d, j
            if (best_j is not None and best_d <= merge_radius_km
                    and len(clusters[best_j]) + 1 <= max_stops_per_route):
                clusters[best_j].extend(cluster)
                clusters.pop(i)
                changed = True
                break
    return clusters


def auto_cluster_by_distance(stops, recommended_stops_per_route=5,
                             distance_sensitivity="balanced",
                             auto_combine_small_routes=True,
                             max_stops_per_route=25):
    """
    Decide the number of route groups automatically from geographic distance.
    Uses DBSCAN when available, otherwise a greedy fallback, then post-processes
    to respect the recommended size and the hard 25-stop limit.
    Returns (clusters, warnings).
    """
    warnings = []
    recommended = max(2, min(int(recommended_stops_per_route or 5), 25))
    max_stops = max(2, min(int(max_stops_per_route or 25), MAX_CLUSTER_SIZE))

    if len(stops) == 0:
        return [], warnings
    if len(stops) == 1:
        return [list(stops)], warnings

    eps_km = calculate_auto_eps_km(stops, recommended, distance_sensitivity)

    if SKLEARN_AVAILABLE:
        clusters = run_dbscan_clustering(stops, eps_km)
    else:
        warnings.append("Using fallback auto-clustering because scikit-learn is unavailable.")
        clusters = _fallback_distance_clusters(stops, eps_km, recommended, max_stops)

    # Post-process: split oversized groups, then optionally merge tiny ones.
    clusters = split_large_clusters(clusters, max_stops, recommended)
    if auto_combine_small_routes:
        clusters = combine_small_nearby_clusters(clusters, max_stops, distance_sensitivity)
        # Merging could re-create an oversized group; split once more to be safe.
        clusters = split_large_clusters(clusters, max_stops, recommended)

    # Hard safety net at the Google limit.
    clusters, split_happened = _enforce_cluster_limit(clusters)
    if split_happened:
        warnings.append("A route group exceeded 25 stops and was split automatically.")

    return clusters, warnings


def explain_auto_clusters(clusters, recommended_stops_per_route):
    """
    Build human-readable metadata: a per-cluster reason + average spread, and a
    top-level summary explaining why this many groups were created.
    """
    total = sum(len(c) for c in clusters)
    count = len(clusters)
    recommended = max(2, min(int(recommended_stops_per_route or 5), 25))
    expected = max(1, math.ceil(total / recommended)) if total else 0

    reasons, avg_distances = [], []
    for cluster in clusters:
        spread = round(_cluster_spread_km(cluster), 2)
        avg_distances.append(spread)
        if len(cluster) == 1:
            reasons.append("A stop far from the others was kept as its own route.")
        elif spread < 2.0:
            reasons.append("Nearby stops grouped within the same area")
        else:
            reasons.append("Stops grouped by geographic proximity")

    if count <= 1:
        message = "All stops are close together, so a single route group was created."
    elif count > expected:
        message = (f"Created {count} route groups because the stops naturally split "
                   "into separate geographic areas.")
    elif count < expected:
        message = (f"Created {count} route groups; nearby stops were combined into "
                   "larger practical routes.")
    else:
        message = f"Created {count} route groups based on the distance between stops."

    summary = {
        "totalStops": total,
        "recommendedStopsPerRoute": recommended,
        "actualRouteCount": count,
        "message": message,
    }
    return {"summary": summary, "reasons": reasons, "avgDistances": avg_distances}


def _build_manual_clusters(stop_objs, manual_clusters):
    """Validate frontend-supplied manual clusters (lists of original indexes)."""
    if not isinstance(manual_clusters, list) or not manual_clusters:
        raise RouteError("Manual clustering requires a non-empty 'manualClusters' list.")

    n = len(stop_objs)
    seen = set()
    clusters = []
    for group in manual_clusters:
        if not isinstance(group, list) or not group:
            raise RouteError("Each manual route group must be a non-empty list of stop indexes.")
        cluster = []
        for idx in group:
            if not isinstance(idx, int) or idx < 0 or idx >= n:
                raise RouteError(f"Invalid stop index in manual clusters: {idx}.")
            if idx in seen:
                raise RouteError(f"Duplicate stop index in manual clusters: {idx}.")
            seen.add(idx)
            cluster.append(stop_objs[idx])
        if len(cluster) > MAX_CLUSTER_SIZE:
            raise RouteError("A single route group cannot exceed 25 stops.")
        clusters.append(cluster)

    if len(seen) != n:
        missing = sorted(set(range(n)) - seen)
        raise RouteError(f"Manual clusters are missing stop indexes: {missing}.")
    return clusters


def optimize_clustered_routes(start_point, start_address, stop_objs,
                              clustering, return_to_start):
    """
    Cluster the stops geographically, then optimize each cluster as its own
    route from the same start. Returns the clustered /api/optimize response.
    """
    mode = clustering.get("mode")
    warnings = []
    cluster_mode = mode
    recommended = max(2, min(int(clustering.get("recommendedStopsPerRoute") or 5), 25))

    if mode == "stops_per_route":
        per_route = clustering.get("stopsPerRoute") or 5
        if int(per_route) > MAX_CLUSTER_SIZE:
            warnings.append(f"Stops per route capped at {MAX_CLUSTER_SIZE} "
                            "(Google's intermediate-waypoint limit).")
        clusters = cluster_by_stops_per_route(stop_objs, per_route)
    elif mode == "number_of_routes":
        requested = max(1, int(clustering.get("numberOfRoutes") or 1))
        clusters = cluster_by_number_of_routes(stop_objs, requested)
        if len(clusters) < requested:
            warnings.append(f"Requested {requested} route groups but produced "
                            f"{len(clusters)} (some would have been empty).")
    elif mode == "auto_distance":
        clusters, auto_warnings = auto_cluster_by_distance(
            stop_objs,
            clustering.get("recommendedStopsPerRoute", 5),
            clustering.get("distanceSensitivity", "balanced"),
            clustering.get("autoCombineSmallRoutes", True),
            clustering.get("maxStopsPerRoute", MAX_CLUSTER_SIZE),
        )
        warnings.extend(auto_warnings)
    elif mode == "manual":
        clusters = _build_manual_clusters(stop_objs, clustering.get("manualClusters"))
    else:
        raise RouteError("Unknown clustering mode.")

    clusters, split_happened = _enforce_cluster_limit(clusters)
    if split_happened:
        warnings.append("A route group exceeded 25 stops and was split automatically.")

    # Per-cluster explanations for auto mode (computed on the final clusters).
    reasons, avg_distances, auto_summary = None, None, None
    if cluster_mode == "auto_distance":
        explained = explain_auto_clusters(clusters, recommended)
        auto_summary = explained["summary"]
        reasons = explained["reasons"]
        avg_distances = explained["avgDistances"]

    cluster_results = []
    grand_distance, grand_duration = 0, 0
    for index, cluster in enumerate(clusters, start=1):
        core = optimize_cluster(start_point, cluster, return_to_start)
        entry = {
            "clusterIndex": index,
            "title": f"Route {index}",
            "stopCount": len(cluster),
            "totalDistanceMeters": core["totalDistanceMeters"],
            "totalDurationSeconds": core["totalDurationSeconds"],
            "encodedPolylines": core["encodedPolylines"],
            "orderedStops": core["orderedStops"],
        }
        if cluster_mode == "auto_distance":
            entry["clusterReason"] = reasons[index - 1] if reasons else "Grouped by proximity"
            entry["averageDistanceFromClusterCenterKm"] = (
                avg_distances[index - 1] if avg_distances else 0.0)
        cluster_results.append(entry)
        grand_distance += core["totalDistanceMeters"]
        grand_duration += core["totalDurationSeconds"]

    result = {
        "mode": "clustered",
        "clusterMode": cluster_mode,
        "warning": " ".join(warnings) if warnings else None,
        "warnings": warnings,
        "start": {"address": start_address,
                  "lat": start_point["lat"], "lng": start_point["lng"]},
        "clusters": cluster_results,
        "grandTotalDistanceMeters": grand_distance,
        "grandTotalDurationSeconds": grand_duration,
    }
    if auto_summary is not None:
        auto_summary["actualRouteCount"] = len(cluster_results)
        result["autoClusterSummary"] = auto_summary
    return result


# --- Request parsing helpers -------------------------------------------------

def _read_request():
    """Parse and lightly clean the common request body for both endpoints."""
    body = request.get_json(force=True, silent=True) or {}
    start_address = (body.get("startAddress") or "").strip()
    raw_stops = body.get("stops") or []
    # Strip, drop empties, then dedupe exact duplicates.
    stops = dedupe([s.strip() for s in raw_stops if s and s.strip()])

    if not start_address:
        raise RouteError("Start address is required.")
    if not stops:
        raise RouteError("At least one stop is required.")
    if len(stops) > MAX_STOPS:
        raise RouteError("Maximum 50 stops allowed.")
    return body, start_address, stops


def _parse_city_restriction(body):
    """Normalize the cityRestriction block from a request body."""
    cr = body.get("cityRestriction") or {}
    enabled = bool(cr.get("enabled"))
    city = (cr.get("city") or "").strip()
    country = (cr.get("country") or "").strip().upper() or None
    strict = bool(cr.get("strict", True))
    if enabled and not city:
        enabled = False  # nothing meaningful to restrict to
    return {
        "enabled": enabled,
        "city": city if enabled else None,
        "country": country if enabled else None,
        "strict": strict,
    }


def _geocode_all(start_address, stops, city_restriction):
    """
    Geocode the start + every stop (honoring city restriction). Returns
    (start_point, stop_objs). Raises a clean error on hard failures and on
    strict city mismatches.
    """
    city = city_restriction["city"]
    country = city_restriction["country"]
    strict = city_restriction["strict"]

    start = _geocode_point(start_address, city, country)
    if city_restriction["enabled"] and strict and start["status"] == "city_mismatch":
        raise RouteError(
            f"Start city mismatch: requested {start['requestedCity']}, matched "
            f"{start['matchedCity'] or 'unknown'}. Re-validate before optimizing.")

    stop_objs = []
    for index, address in enumerate(stops):
        result = _geocode_point(address, city, country)
        if city_restriction["enabled"] and strict and result["status"] == "city_mismatch":
            raise RouteError(
                f"City mismatch for stop {index + 1} ('{address}'): requested "
                f"{result['requestedCity']}, matched "
                f"{result['matchedCity'] or 'unknown'}. Re-validate before optimizing.")
        stop_objs.append({
            "originalIndex": index,
            "address": address,
            "formattedAddress": result["formattedAddress"],
            "lat": result["lat"],
            "lng": result["lng"],
        })
    return start, stop_objs


# --- HTTP endpoints ----------------------------------------------------------

@app.route("/")
def index():
    """Serve the single-page app."""
    return render_template("index.html")


@app.route("/api/config")
def api_config():
    """Expose the Maps JS key so the frontend can load the map.

    For a local MVP this is acceptable. In production, restrict this browser
    key by HTTP referrer in the Google Cloud Console.
    """
    return jsonify({"googleMapsApiKey": API_KEY})


@app.route("/api/validate-addresses", methods=["POST"])
def api_validate_addresses():
    """Geocode + validate the start address and every stop (city-aware)."""
    try:
        require_api_key()
        body, start_address, stops = _read_request()
        city_restriction = _parse_city_restriction(body)
        return jsonify(validate_addresses(start_address, stops, city_restriction))
    except RouteError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code
    except Exception as exc:  # never leak a raw traceback
        return jsonify({"success": False,
                        "error": f"Unexpected server error: {exc}"}), 500


@app.route("/api/optimize", methods=["POST"])
def api_optimize():
    """Optimize the route(s) and return ordered stops + polylines.

    Supports both the classic single-route response and the clustered response.
    """
    try:
        require_api_key()
        body, start_address, stops = _read_request()
        return_to_start = bool(body.get("returnToStart", True))
        city_restriction = _parse_city_restriction(body)
        clustering = body.get("clustering") or {}
        clustering_enabled = bool(clustering.get("enabled")) \
            and clustering.get("mode") in ("stops_per_route", "number_of_routes",
                                           "auto_distance", "manual")

        # Geocode once (coords are reused by every route, and the city
        # restriction is enforced as a safety net).
        start_point, stop_objs = _geocode_all(start_address, stops, city_restriction)

        if clustering_enabled:
            result = optimize_clustered_routes(
                start_point, start_address, stop_objs, clustering, return_to_start)
        elif len(stop_objs) <= EXACT_OPT_LIMIT:
            core = _optimize_points(start_point, stop_objs, return_to_start)
            result = {
                "mode": "exact",
                "warning": None,
                "start": {"address": start_address,
                          "lat": start_point["lat"], "lng": start_point["lng"]},
                **core,
            }
        else:
            result = approximate_large_route(
                start_point, start_address, stop_objs, return_to_start)

        result["success"] = True
        return jsonify(result)
    except RouteError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code
    except Exception as exc:  # never leak a raw traceback
        return jsonify({"success": False,
                        "error": f"Unexpected server error: {exc}"}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
