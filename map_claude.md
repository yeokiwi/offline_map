# Coding Prompt: Offline Map Viewer for Singapore (Node.js)

---

## Project Overview

Build a **full-stack offline map viewer** using Node.js that pre-downloads map tiles from open-source providers, stores them locally, and serves an interactive map web UI focused on Singapore. The app must support both street map and satellite views, tile caching, and smooth pan/zoom interactions.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Tile Storage | SQLite (MBTiles format) via `better-sqlite3` |
| Tile Downloader | `node-fetch` or `axios` |
| Frontend | Leaflet.js (via HTML served by Express) |
| Tile Sources | OpenStreetMap (street), ESRI WorldImagery (satellite) |

---

## Functional Requirements

### 1. Tile Downloader (`downloader.js`)

Build a CLI script that:

- Accepts parameters: `--type <street|satellite>`, `--zoom <level>`, `--bbox <minLon,minLat,maxLon,maxLat>`
- Uses the following tile sources:
  - **Street map:** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  - **Satellite map:** `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
- Converts the bounding box into a list of `(z, x, y)` tile coordinates using a `latLonToTile(lat, lon, zoom)` utility function
- Downloads tiles concurrently with a **rate limiter** (max 2 concurrent requests, 500ms delay between batches) to respect server policies
- Sets a proper `User-Agent` header in all HTTP requests
- Stores downloaded tiles into an **SQLite MBTiles** database with schema:

```sql
CREATE TABLE tiles (
  zoom_level INTEGER,
  tile_column INTEGER,
  tile_row INTEGER,
  tile_data BLOB,
  PRIMARY KEY (zoom_level, tile_column, tile_row)
);
CREATE TABLE metadata (name TEXT, value TEXT);
```

- Saves street tiles to `./tiles/street.mbtiles` and satellite tiles to `./tiles/satellite.mbtiles`
- Logs progress with a running counter: `Downloaded 145/512 tiles...`
- Gracefully skips tiles that return HTTP 4xx/5xx and logs them to `./tiles/failed.log`

**Default download target:**
- Bounding box for Singapore: `103.6, 1.15, 104.1, 1.50`
- Zoom level: **15**

---

### 2. Tile Server (`server.js`)

Build an Express server that:

- Listens on port `3000`
- Exposes two tile endpoints:
  - `GET /tiles/street/{z}/{x}/{y}.png`
  - `GET /tiles/satellite/{z}/{x}/{y}.png`
- Reads the requested tile from the appropriate `.mbtiles` SQLite file
- Note: MBTiles uses **TMS** tile row convention (Y is flipped). Apply: `tmsY = (2^z - 1) - y` before querying
- Returns the tile blob with the correct `Content-Type` (`image/png` or `image/jpeg`)
- Returns a **256×256 transparent placeholder PNG** (hard-coded base64) if the tile is not found in the database, instead of a 404 error
- Adds cache headers: `Cache-Control: public, max-age=86400`
- Serves the frontend from `./public/index.html` at `GET /`

---

### 3. Frontend Map UI (`public/index.html`)

Build a single-file HTML page that:

- Loads **Leaflet.js** from CDN
- Initialises the map centred on Singapore: `[1.3521, 103.8198]`, zoom `15`
- Defines **two tile layers** pointing to the local tile server:
  - Street: `http://localhost:3000/tiles/street/{z}/{x}/{y}.png`
  - Satellite: `http://localhost:3000/tiles/satellite/{z}/{x}/{y}.png`
- Adds a **Leaflet layer control** (top-right) to toggle between Street and Satellite
- Enables **mouse and touch pan/zoom** interactions (Leaflet default)
- Sets `minZoom: 10`, `maxZoom: 18` on the map; sets `maxNativeZoom: 15` on each tile layer to prevent requesting zoom levels not in the database
- Displays a status bar at the bottom showing current **zoom level** and **lat/lng** of map centre, updating live on `moveend`
- Displays a visible attribution: `© OpenStreetMap contributors | Satellite © Esri`

---

## Project Structure

```
offline-map/
├── downloader.js        # CLI tile downloader
├── server.js            # Express tile + frontend server
├── public/
│   └── index.html       # Leaflet map UI
├── tiles/               # Auto-created by downloader
│   ├── street.mbtiles
│   ├── satellite.mbtiles
│   └── failed.log
├── package.json
└── README.md
```

---

## `package.json` Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "better-sqlite3": "^9.4.3",
    "axios": "^1.6.7"
  }
}
```

---

## Usage Instructions (to include in `README.md`)

```bash
# 1. Install dependencies
npm install

# 2. Download street tiles for Singapore at zoom 15
node downloader.js --type street --zoom 15 --bbox 103.6,1.15,104.1,1.50

# 3. Download satellite tiles for Singapore at zoom 15
node downloader.js --type satellite --zoom 15 --bbox 103.6,1.15,104.1,1.50

# 4. Start the map server
node server.js

# 5. Open browser at http://localhost:3000
```

---

## Edge Cases & Constraints

- **Do not** use any cloud map SDK (Google Maps, Mapbox). Use only open-source tile providers.
- The downloader must handle **network timeouts** gracefully (set a 10s timeout per tile request).
- If `./tiles/` directory does not exist, the downloader should **create it automatically**.
- The server must **not crash** if an `.mbtiles` file is missing — log a warning and return the placeholder tile instead.
- Tile row flipping (TMS ↔ XYZ) must be applied **only in the server**, not in the frontend.
- Zoom level 15 for Singapore's bounding box will produce approximately **400–600 tiles per layer** — ensure the downloader reports the expected total before starting.

---

*This prompt covers the complete architecture. Implement each file independently and test the downloader before starting the server.*
