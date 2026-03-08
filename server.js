const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// 1x1 transparent PNG (256x256 would be large; this is a minimal transparent PNG
// that browsers will scale to fill the tile slot)
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAAOSURB' +
  'VHic7cEBDQAAAMKg909tDwcUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAB4GEVAAAErnLMcAAAAAElFTkSuQmCC',
  'base64'
);

// Open database connections lazily
const dbCache = {};

function getDb(type) {
  if (dbCache[type]) return dbCache[type];

  const dbPath = path.join(__dirname, 'tiles', `${type}.mbtiles`);
  if (!fs.existsSync(dbPath)) {
    console.warn(`Warning: ${dbPath} not found. Tiles for "${type}" will return placeholders.`);
    return null;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    dbCache[type] = db;
    return db;
  } catch (err) {
    console.warn(`Warning: Failed to open ${dbPath}: ${err.message}`);
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

  const row = db
    .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
    .get(z, x, tmsY);

  if (row) {
    const contentType = type === 'satellite' ? 'image/jpeg' : 'image/png';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(row.tile_data);
  }

  // Tile not found — return placeholder
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(PLACEHOLDER_PNG);
});

app.listen(PORT, () => {
  console.log(`Offline map server running at http://localhost:${PORT}`);
});
