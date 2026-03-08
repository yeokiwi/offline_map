const express = require('express');
const initSqlJs = require('sql.js');
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

  // TMS Y-flip: MBTiles uses TMS convention
  const tmsY = Math.pow(2, z) - 1 - y;

  const db = getDb(type);
  if (!db) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(PLACEHOLDER_PNG);
  }

  const stmt = db.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
  );
  stmt.bind([z, x, tmsY]);

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

// Initialize SQL.js then start server
initSql().then(() => {
  app.listen(PORT, () => {
    console.log(`Offline map server running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize SQL.js:', err.message);
  process.exit(1);
});
