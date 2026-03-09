const express = require('express');
const initSqlJs = require('sql.js');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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

// Routing proxy — forwards to OSRM public API to avoid CORS issues
app.get('/api/route', async (req, res) => {
  const { coords } = req.query;
  if (!coords) {
    return res.status(400).json({ error: 'Missing coords parameter' });
  }

  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=polyline`;

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'OfflineMapViewer/1.0 (educational project)',
      },
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const message = err.response
      ? 'OSRM returned error ' + status
      : 'Could not reach routing server: ' + err.message;
    res.status(status).json({ error: message });
  }
});

// Initialize SQL.js then start server
initSql().then(() => {
  app.listen(PORT, () => {
    console.log(`Offline map server running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize SQL.js:', err.message);
  process.exit(1);
});
