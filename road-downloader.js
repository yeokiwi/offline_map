#!/usr/bin/env node

/**
 * Downloads the road network for Singapore from the Overpass API
 * and saves it as a GeoJSON file for offline routing.
 *
 * Usage: node road-downloader.js [--bbox minLon,minLat,maxLon,maxLat]
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DEFAULT_BBOX = [103.6, 1.15, 104.1, 1.50]; // Singapore

function parseArgs() {
  const args = process.argv.slice(2);
  const params = { bbox: DEFAULT_BBOX };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bbox') {
      params.bbox = args[++i].split(',').map(Number);
    }
  }
  return params;
}

function buildOverpassQuery(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  // Overpass uses (south,west,north,east) format
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`;

  // Query all highway types suitable for driving/walking
  return `
[out:json][timeout:120];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service)$"](${bboxStr});
);
out body;
>;
out skel qt;
`.trim();
}

function osmToGeoJSON(osmData) {
  // Build node lookup
  const nodes = {};
  for (const el of osmData.elements) {
    if (el.type === 'node') {
      nodes[el.id] = [el.lon, el.lat];
    }
  }

  const features = [];

  for (const el of osmData.elements) {
    if (el.type !== 'way') continue;

    // Convert node IDs to coordinates
    const coordinates = [];
    for (const nodeId of el.nodes) {
      if (nodes[nodeId]) {
        coordinates.push(nodes[nodeId]);
      }
    }

    if (coordinates.length < 2) continue;

    const properties = {};
    if (el.tags) {
      if (el.tags.highway) properties.highway = el.tags.highway;
      if (el.tags.name) properties.name = el.tags.name;
      if (el.tags.oneway) properties.oneway = el.tags.oneway;
      if (el.tags.maxspeed) properties.maxspeed = el.tags.maxspeed;
    }

    features.push({
      type: 'Feature',
      properties: properties,
      geometry: {
        type: 'LineString',
        coordinates: coordinates,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features: features,
  };
}

async function main() {
  const params = parseArgs();
  const dataDir = path.join(__dirname, 'data');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  console.log(`Bounding box: ${params.bbox.join(', ')}`);
  console.log('Querying Overpass API for road network...');

  const query = buildOverpassQuery(params.bbox);

  try {
    const response = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      {
        timeout: 180000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'OfflineMapViewer/1.0 (educational project)',
        },
        maxContentLength: 500 * 1024 * 1024,
      }
    );

    const osmData = response.data;
    const nodeCount = osmData.elements.filter((e) => e.type === 'node').length;
    const wayCount = osmData.elements.filter((e) => e.type === 'way').length;
    console.log(`Received ${nodeCount} nodes and ${wayCount} ways`);

    console.log('Converting to GeoJSON...');
    const geojson = osmToGeoJSON(osmData);
    console.log(`Created ${geojson.features.length} road segments`);

    const outputPath = path.join(dataDir, 'roads.geojson');
    fs.writeFileSync(outputPath, JSON.stringify(geojson));
    console.log(`Saved to: ${outputPath}`);

    const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
    console.log(`File size: ${sizeMB} MB`);

  } catch (err) {
    if (err.response) {
      console.error(`Overpass API error: HTTP ${err.response.status}`);
      if (err.response.data) {
        console.error(typeof err.response.data === 'string'
          ? err.response.data.substring(0, 500)
          : JSON.stringify(err.response.data).substring(0, 500));
      }
    } else {
      console.error(`Request failed: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
