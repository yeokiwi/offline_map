#!/usr/bin/env node

const axios = require('axios');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// --- Tile coordinate utilities ---

function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function getTileRange(bbox, zoom) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const topLeft = latLonToTile(maxLat, minLon, zoom);
  const bottomRight = latLonToTile(minLat, maxLon, zoom);
  const tiles = [];
  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

// --- Argument parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    type: 'street',
    zoom: 15,
    bbox: [103.6, 1.15, 104.1, 1.50],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
        params.type = args[++i];
        break;
      case '--zoom':
        params.zoom = parseInt(args[++i], 10);
        break;
      case '--bbox':
        params.bbox = args[++i].split(',').map(Number);
        break;
    }
  }

  if (!['street', 'satellite'].includes(params.type)) {
    console.error('Error: --type must be "street" or "satellite"');
    process.exit(1);
  }

  return params;
}

// --- Tile URL builders ---

function getTileUrl(type, z, x, y) {
  if (type === 'street') {
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }
  // Satellite: ESRI uses {z}/{y}/{x}
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

// --- Database setup ---

async function initDatabase(dbPath) {
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS tiles (
      zoom_level INTEGER,
      tile_column INTEGER,
      tile_row INTEGER,
      tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  db.run('CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);');

  return db;
}

function saveDatabase(db, dbPath) {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// --- Download logic ---

async function downloadTile(type, z, x, y) {
  const url = getTileUrl(type, z, x, y);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: {
      'User-Agent': 'OfflineMapViewer/1.0 (Node.js tile downloader)',
    },
  });
  return Buffer.from(response.data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadAll(type, tiles, db, dbPath, failedLogPath) {
  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
  );

  const total = tiles.length;
  let downloaded = 0;
  let failed = 0;
  const concurrency = 2;
  const saveInterval = 50; // Save to disk every 50 tiles

  const failedStream = fs.createWriteStream(failedLogPath, { flags: 'a' });

  for (let i = 0; i < tiles.length; i += concurrency) {
    const batch = tiles.slice(i, i + concurrency);
    const promises = batch.map(async (tile) => {
      try {
        const data = await downloadTile(type, tile.z, tile.x, tile.y);
        insertStmt.bind([tile.z, tile.x, tile.y, data]);
        insertStmt.step();
        insertStmt.reset();
        downloaded++;
      } catch (err) {
        failed++;
        const status = err.response ? err.response.status : err.code || 'UNKNOWN';
        const msg = `[${new Date().toISOString()}] FAILED ${type} z=${tile.z} x=${tile.x} y=${tile.y} status=${status}\n`;
        failedStream.write(msg);
      }
      process.stdout.write(`\rDownloaded ${downloaded}/${total} tiles... (${failed} failed)`);
    });

    await Promise.all(promises);

    // Periodically save to disk
    if (downloaded % saveInterval < concurrency) {
      saveDatabase(db, dbPath);
    }

    if (i + concurrency < tiles.length) {
      await sleep(500);
    }
  }

  insertStmt.free();
  failedStream.end();
  console.log('');
  return { downloaded, failed };
}

// --- Main ---

async function main() {
  const params = parseArgs();
  const tilesDir = path.join(__dirname, 'tiles');

  if (!fs.existsSync(tilesDir)) {
    fs.mkdirSync(tilesDir, { recursive: true });
  }

  const dbPath = path.join(tilesDir, `${params.type}.mbtiles`);
  const failedLogPath = path.join(tilesDir, 'failed.log');

  console.log(`Tile type: ${params.type}`);
  console.log(`Zoom level: ${params.zoom}`);
  console.log(`Bounding box: ${params.bbox.join(', ')}`);

  const tiles = getTileRange(params.bbox, params.zoom);
  console.log(`Total tiles to download: ${tiles.length}`);

  const db = await initDatabase(dbPath);

  console.log(`Saving to: ${dbPath}`);
  console.log('Starting download...\n');

  const { downloaded, failed } = await downloadAll(params.type, tiles, db, dbPath, failedLogPath);

  // Final save
  saveDatabase(db, dbPath);
  db.close();

  console.log(`\nDone! ${downloaded} tiles downloaded, ${failed} failed.`);
  if (failed > 0) {
    console.log(`See ${failedLogPath} for details.`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
