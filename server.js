const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const PathFinder = require('geojson-path-finder').default;
const turf = require('@turf/turf');

const app = express();
const PORT = 3000;

// 1x1 transparent PNG (minimal; browsers scale to fill the tile slot)
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

// Database cache
const dbCache = {};
let SQL = null;

async function initSql() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

function getDb(type) {
  if (dbCache[type] !== undefined) return dbCache[type];

  const dbPath = path.join(__dirname, 'tiles', `${type}.mbtiles`);
  if (!fs.existsSync(dbPath)) {
    console.warn(`Warning: ${dbPath} not found. Tiles for "${type}" will return placeholders.`);
    dbCache[type] = null;
    return null;
  }

  try {
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);
    dbCache[type] = db;
    return db;
  } catch (err) {
    console.warn(`Warning: Failed to open ${dbPath}: ${err.message}`);
    dbCache[type] = null;
    return null;
  }
}

// --- Offline routing setup ---
let pathFinderInstance = null;
let roadNetwork = null;

function initRouting() {
  const roadsPath = path.join(__dirname, 'data', 'roads.geojson');
  if (!fs.existsSync(roadsPath)) {
    console.warn('Warning: data/roads.geojson not found. Run "node road-downloader.js" first.');
    console.warn('Routing will be unavailable.');
    return;
  }

  console.log('Loading road network...');
  const raw = fs.readFileSync(roadsPath, 'utf-8');
  roadNetwork = JSON.parse(raw);
  console.log(`Road network: ${roadNetwork.features.length} segments`);

  console.log('Building routing graph (this may take a moment)...');
  pathFinderInstance = new PathFinder(roadNetwork, {
    tolerance: 1e-5,
    weight: function (a, b, props) {
      // Distance in km
      const dist = turf.distance(turf.point(a), turf.point(b), { units: 'kilometers' });

      // Speed estimates by road type (km/h)
      const speeds = {
        motorway: 90, motorway_link: 60,
        trunk: 70, trunk_link: 50,
        primary: 60, primary_link: 40,
        secondary: 50, secondary_link: 35,
        tertiary: 40, tertiary_link: 30,
        residential: 30,
        unclassified: 30,
        living_street: 20,
        service: 15,
      };

      const speed = speeds[props.highway] || 30;
      const time = dist / speed; // hours

      // Handle oneway streets
      if (props.oneway === 'yes' || props.oneway === '1') {
        return { forward: time, backward: Infinity };
      }
      if (props.oneway === '-1') {
        return { forward: Infinity, backward: time };
      }

      return time;
    },
    edgeDataReducer: function (seed, props) {
      return { highway: props.highway, name: props.name || '' };
    },
    edgeDataSeed: function () {
      return {};
    },
  });
  console.log('Routing graph ready.');
}

/**
 * Snap a [lng, lat] coordinate to the nearest vertex in the road network.
 * Uses turf.nearestPointOnLine to find the closest road, then snaps to
 * the nearest vertex of that road segment.
 */
function snapToNetwork(lng, lat) {
  if (!roadNetwork) return null;

  const pt = turf.point([lng, lat]);
  let bestDist = Infinity;
  let bestCoord = null;

  // Find nearest road segment
  for (const feature of roadNetwork.features) {
    const snapped = turf.nearestPointOnLine(feature, pt, { units: 'kilometers' });
    if (snapped.properties.dist < bestDist) {
      bestDist = snapped.properties.dist;
      // Snap to the nearest actual vertex of this line (not interpolated point)
      const coords = feature.geometry.coordinates;
      let vertexBestDist = Infinity;
      for (const c of coords) {
        const d = turf.distance(pt, turf.point(c), { units: 'kilometers' });
        if (d < vertexBestDist) {
          vertexBestDist = d;
          bestCoord = c;
        }
      }
    }
  }

  return bestCoord;
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Tile endpoint
app.get('/tiles/:type/:z/:x/:y.png', (req, res) => {
  const { type } = req.params;
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);

  if (!['street', 'satellite'].includes(type)) {
    return res.status(400).send('Invalid tile type');
  }

  const db = getDb(type);
  if (!db) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(PLACEHOLDER_PNG);
  }

  // Tiles are stored with XYZ convention (same as downloaded), so query directly
  const stmt = db.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
  );
  stmt.bind([z, x, y]);

  if (stmt.step()) {
    const row = stmt.get();
    stmt.free();
    const tileData = Buffer.from(row[0]);
    const contentType = type === 'satellite' ? 'image/jpeg' : 'image/png';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(tileData);
  }

  stmt.free();

  // Tile not found — return placeholder
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(PLACEHOLDER_PNG);
});

// Offline routing endpoint
app.get('/api/route', (req, res) => {
  if (!pathFinderInstance) {
    return res.status(503).json({
      error: 'Routing unavailable. Run "node road-downloader.js" to download road data first.',
    });
  }

  const { coords } = req.query;
  if (!coords) {
    return res.status(400).json({ error: 'Missing coords parameter' });
  }

  // Parse coords: "lng,lat;lng,lat;..."
  const points = coords.split(';').map((pair) => {
    const [lng, lat] = pair.split(',').map(Number);
    return { lng, lat };
  });

  if (points.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 waypoints' });
  }

  // Snap all points to the road network
  const snappedPoints = points.map((p) => snapToNetwork(p.lng, p.lat));
  for (let i = 0; i < snappedPoints.length; i++) {
    if (!snappedPoints[i]) {
      return res.status(400).json({
        error: `Waypoint ${i + 1} could not be snapped to the road network. Try clicking closer to a road.`,
      });
    }
  }

  // Compute route between consecutive waypoint pairs
  let totalPath = [];
  let totalDistance = 0;
  let totalWeight = 0;

  for (let i = 0; i < snappedPoints.length - 1; i++) {
    const start = turf.point(snappedPoints[i]);
    const end = turf.point(snappedPoints[i + 1]);

    const result = pathFinderInstance.findPath(start, end);
    if (!result) {
      return res.status(400).json({
        error: `No route found between waypoint ${i + 1} and ${i + 2}. The points may be on disconnected road segments.`,
      });
    }

    // Append path coordinates (avoid duplicating junction point)
    if (totalPath.length > 0 && result.path.length > 0) {
      totalPath = totalPath.concat(result.path.slice(1));
    } else {
      totalPath = totalPath.concat(result.path);
    }

    totalWeight += result.weight;
  }

  // Calculate actual distance along the path
  if (totalPath.length >= 2) {
    const line = turf.lineString(totalPath);
    totalDistance = turf.length(line, { units: 'kilometers' });
  }

  // Estimated duration (weight is in hours based on speed)
  const durationSeconds = totalWeight * 3600;

  res.json({
    routes: [
      {
        distance: totalDistance * 1000, // meters
        duration: durationSeconds,
        geometry: totalPath, // array of [lng, lat] coordinates
      },
    ],
    snappedWaypoints: snappedPoints.map((c) => ({ lng: c[0], lat: c[1] })),
  });
});

// Initialize SQL.js then start server
initSql().then(() => {
  initRouting();
  app.listen(PORT, () => {
    console.log(`Offline map server running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize SQL.js:', err.message);
  process.exit(1);
});
