# Offline Map Viewer — Singapore

A full-stack offline map viewer that pre-downloads map tiles from open-source providers, stores them locally in MBTiles (SQLite) format, and serves an interactive Leaflet.js map UI. Supports both street map and satellite views.

## Prerequisites

- Node.js 18+
- npm

## Setup

```bash
# Install dependencies
npm install
```

## Download Tiles

Download street and satellite tiles for Singapore at zoom level 15:

```bash
# Street tiles
node downloader.js --type street --zoom 15 --bbox 103.6,1.15,104.1,1.50

# Satellite tiles
node downloader.js --type satellite --zoom 15 --bbox 103.6,1.15,104.1,1.50
```

### Downloader Options

| Flag | Description | Default |
|------|-------------|---------|
| `--type` | `street` or `satellite` | `street` |
| `--zoom` | Zoom level (0–18) | `15` |
| `--bbox` | `minLon,minLat,maxLon,maxLat` | `103.6,1.15,104.1,1.50` |

## Start the Server

```bash
node server.js
```

Open your browser at **http://localhost:3000**.

## Features

- Street and satellite tile layers with layer control toggle
- Smooth pan/zoom via mouse and touch
- Status bar showing current zoom level and map centre coordinates
- Transparent placeholder tiles for missing data (no broken images)
- Tiles cached with `Cache-Control: public, max-age=86400`

## Tile Sources

- **Street:** OpenStreetMap (`tile.openstreetmap.org`)
- **Satellite:** Esri World Imagery (`server.arcgisonline.com`)
