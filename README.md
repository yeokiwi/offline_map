# Offline Map Viewer & AI Route Planner — Singapore

A full-stack offline map viewer built with Node.js that serves pre-downloaded map tiles and provides AI-powered route planning for Singapore. The app supports street and satellite views, offline routing, and a natural-language chat interface powered by OpenAI that can plan routes through a Model Context Protocol (MCP) server.

## Features

- **Offline Map Tiles** — Pre-download street (OpenStreetMap) and satellite (ESRI) tiles for Singapore, stored in SQLite MBTiles format
- **Interactive Map** — Leaflet.js-based UI with pan, zoom, layer switching, and waypoint placement
- **Offline Routing** — Point-to-point navigation using `geojson-path-finder` with road-type speed profiles and oneway street support
- **AI Chat Interface** — Natural-language route planning via OpenAI API (GPT-4o-mini) with function calling
- **MCP Server** — Model Context Protocol server exposing route planning tools for integration with LLM clients (Claude Desktop, etc.)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser (index.html)               │
│  ┌──────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Leaflet  │  │  Navigation │  │  AI Chat      │  │
│  │ Map      │  │  Panel      │  │  Panel        │  │
│  └────┬─────┘  └──────┬──────┘  └───────┬───────┘  │
│       │               │                 │           │
└───────┼───────────────┼─────────────────┼───────────┘
        │               │                 │
   /tiles/*        /api/route        /api/chat
        │               │                 │
┌───────┼───────────────┼─────────────────┼───────────┐
│       │          server.js              │           │
│  ┌────┴─────┐  ┌──────┴──────┐  ┌──────┴────────┐  │
│  │ Tile     │  │ Route       │  │ OpenAI API    │  │
│  │ Server   │  │ Planner     │  │ + Function    │  │
│  │ (SQLite) │  │ (shared)    │  │   Calling     │  │
│  └──────────┘  └─────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   mcp-server.js                      │
│  MCP Server (stdio transport)                        │
│  Tools: plan_route, geocode_place, list_places,      │
│         routing_status                               │
│  Uses the same route-planner.js module               │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- **Node.js** >= 18
- **npm** (comes with Node.js)
- **Internet** for initial tile and road data download (not needed after setup)
- **OpenAI API key** (for AI chat feature only)

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd offline-map

# 2. Install dependencies
npm install
```

## Setup — Download Offline Data

### Map Tiles

Download street and satellite tiles for Singapore at zoom level 15:

```bash
# Street tiles (~500 tiles, takes a few minutes due to rate limiting)
node downloader.js --type street --zoom 15 --bbox 103.6,1.15,104.1,1.50

# Satellite tiles
node downloader.js --type satellite --zoom 15 --bbox 103.6,1.15,104.1,1.50
```

Tiles are saved to `./tiles/street.mbtiles` and `./tiles/satellite.mbtiles`.

#### Downloader Options

| Flag | Description | Default |
|------|-------------|---------|
| `--type` | `street` or `satellite` | `street` |
| `--zoom` | Zoom level (0-18) | `15` |
| `--bbox` | `minLon,minLat,maxLon,maxLat` | `103.6,1.15,104.1,1.50` |

### Road Network (for routing)

Download Singapore's road network from the Overpass API:

```bash
node road-downloader.js
```

This creates `./data/roads.geojson` (~20-40 MB). Only needed once.

## Usage

### Start the Map Server

```bash
node server.js
```

Open your browser at **http://localhost:3000**.

### Map Navigation

- Use the **layer control** (top-right) to switch between Street and Satellite views
- Click **"Add Waypoints"** in the Navigation panel, then click the map to place waypoints
- Click **"Get Route"** to compute and display a driving route
- Drag waypoint markers to adjust positions

### AI Chat Route Planner

1. Click the **purple chat button** (top-right) to open the AI Chat panel
2. Enter your **OpenAI API key** (stored locally in your browser)
3. Type natural-language requests:
   - *"Plan a route from Changi Airport to Marina Bay Sands"*
   - *"How far is NUS to NTU?"*
   - *"Route from Orchard Road to Sentosa via Clarke Quay"*
4. The AI will look up locations, compute the route, and display it on the map

### MCP Server (for LLM Integration)

The MCP server runs as a separate process and communicates over stdio, making it compatible with Claude Desktop and other MCP clients.

```bash
node mcp-server.js
```

#### Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "singapore-router": {
      "command": "node",
      "args": ["/absolute/path/to/offline-map/mcp-server.js"]
    }
  }
}
```

#### MCP Tools Available

| Tool | Description |
|------|-------------|
| `plan_route` | Compute a driving route between waypoints. Accepts `waypoints` (array of `{lat, lng, name?}`) and optional `speed_factor`. Returns distance, duration, and route geometry. |
| `geocode_place` | Look up coordinates for well-known Singapore places by name. |
| `list_places` | List all known Singapore locations available for geocoding. |
| `routing_status` | Check if the routing engine is ready and has road data loaded. |

## Project Structure

```
offline-map/
├── server.js              # Express server: tiles, routing API, chat API
├── mcp-server.js          # MCP server (stdio transport) for LLM integration
├── route-planner.js       # Shared routing logic (used by server.js & mcp-server.js)
├── downloader.js          # CLI tile downloader
├── road-downloader.js     # Road network downloader (Overpass API)
├── public/
│   └── index.html         # Leaflet map UI + AI chat panel
├── tiles/                 # Auto-created by downloader
│   ├── street.mbtiles
│   ├── satellite.mbtiles
│   └── failed.log
├── data/                  # Auto-created by road-downloader
│   └── roads.geojson
├── package.json
└── README.md
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and API endpoints |
| `sql.js` | SQLite for reading MBTiles tile databases |
| `axios` | HTTP client for tile and road data downloads |
| `geojson-path-finder` | Dijkstra pathfinding on GeoJSON road networks |
| `@turf/turf` | Geospatial utilities (distance, snapping, line length) |
| `@modelcontextprotocol/sdk` | MCP server SDK for LLM tool integration |
| `openai` | OpenAI API client for chat completions with function calling |

## How It Works

### Routing Engine

The routing engine loads Singapore's road network (GeoJSON LineStrings) and builds a graph using `geojson-path-finder`. Each road segment is weighted by estimated travel time based on road type:

| Road Type | Speed (km/h) |
|-----------|--------------|
| Motorway | 90 |
| Trunk | 70 |
| Primary | 60 |
| Secondary | 50 |
| Tertiary | 40 |
| Residential | 30 |
| Service | 15 |

Oneway streets are handled by setting infinite weight in the reverse direction.

### AI Chat Flow

1. User sends a natural-language message
2. Backend forwards it to OpenAI with function definitions (`plan_route`, `geocode_place`, `list_places`)
3. OpenAI calls the appropriate functions (e.g., geocode places first, then plan route)
4. Backend executes function calls against the local routing engine
5. OpenAI generates a human-readable response with route details
6. Route geometry is sent back to the frontend and displayed on the map

### MCP Integration

The MCP server exposes the same routing tools via the Model Context Protocol (stdio transport). This allows any MCP-compatible LLM client to use the Singapore route planner as a tool.

## Tile Sources

- **Street:** OpenStreetMap (`tile.openstreetmap.org`)
- **Satellite:** Esri World Imagery (`server.arcgisonline.com`)
