/**
 * Shared route planning module.
 * Used by both server.js (Express API) and mcp-server.js (MCP tools).
 */

const PathFinder = require('geojson-path-finder').default;
const turf = require('@turf/turf');
const fs = require('fs');
const path = require('path');

// Well-known Singapore locations for geocoding
const KNOWN_PLACES = [
  { name: 'Changi Airport', lat: 1.3644, lng: 103.9915 },
  { name: 'Marina Bay Sands', lat: 1.2834, lng: 103.8607 },
  { name: 'Merlion Park', lat: 1.2868, lng: 103.8545 },
  { name: 'Sentosa', lat: 1.2494, lng: 103.8303 },
  { name: 'Orchard Road', lat: 1.3048, lng: 103.8318 },
  { name: 'Gardens by the Bay', lat: 1.2816, lng: 103.8636 },
  { name: 'Singapore Zoo', lat: 1.4043, lng: 103.7930 },
  { name: 'NUS', lat: 1.2966, lng: 103.7764 },
  { name: 'NTU', lat: 1.3483, lng: 103.6831 },
  { name: 'Raffles Place', lat: 1.2840, lng: 103.8514 },
  { name: 'Clarke Quay', lat: 1.2906, lng: 103.8465 },
  { name: 'Chinatown', lat: 1.2833, lng: 103.8443 },
  { name: 'Little India', lat: 1.3066, lng: 103.8518 },
  { name: 'Bugis', lat: 1.3009, lng: 103.8558 },
  { name: 'Jurong East', lat: 1.3329, lng: 103.7436 },
  { name: 'Tampines', lat: 1.3496, lng: 103.9568 },
  { name: 'Woodlands', lat: 1.4382, lng: 103.7891 },
  { name: 'Punggol', lat: 1.3984, lng: 103.9072 },
  { name: 'HarbourFront', lat: 1.2653, lng: 103.8215 },
  { name: 'Tuas', lat: 1.3200, lng: 103.6400 },
  { name: 'East Coast Park', lat: 1.3008, lng: 103.9122 },
  { name: 'Botanic Gardens', lat: 1.3138, lng: 103.8159 },
  { name: 'Esplanade', lat: 1.2899, lng: 103.8557 },
  { name: 'Vivo City', lat: 1.2644, lng: 103.8223 },
  { name: 'Ion Orchard', lat: 1.3039, lng: 103.8318 },
  { name: 'Jewel Changi', lat: 1.3604, lng: 103.9894 },
  { name: 'Ang Mo Kio', lat: 1.3691, lng: 103.8454 },
  { name: 'Bishan', lat: 1.3526, lng: 103.8352 },
  { name: 'Toa Payoh', lat: 1.3343, lng: 103.8563 },
  { name: 'Bedok', lat: 1.3236, lng: 103.9273 },
];

function createRoutePlanner(dataDir) {
  dataDir = dataDir || path.join(__dirname, 'data');
  let pathFinderInstance = null;
  let roadNetwork = null;
  let ready = false;
  let statusReason = 'Not initialized';

  function init() {
    const roadsPath = path.join(dataDir, 'roads.geojson');
    if (!fs.existsSync(roadsPath)) {
      statusReason = 'data/roads.geojson not found. Run "node road-downloader.js" first.';
      console.warn('Warning: ' + statusReason);
      return false;
    }

    console.log('Loading road network...');
    const raw = fs.readFileSync(roadsPath, 'utf-8');
    roadNetwork = JSON.parse(raw);
    console.log(`Road network: ${roadNetwork.features.length} segments`);

    console.log('Building routing graph (this may take a moment)...');
    pathFinderInstance = new PathFinder(roadNetwork, {
      tolerance: 1e-5,
      weight: function (a, b, props) {
        const dist = turf.distance(turf.point(a), turf.point(b), { units: 'kilometers' });
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
        const time = dist / speed;
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
    ready = true;
    console.log('Routing graph ready.');
    return true;
  }

  function snapToNetwork(lng, lat) {
    if (!roadNetwork) return null;
    const pt = turf.point([lng, lat]);
    let bestDist = Infinity;
    let bestCoord = null;
    for (const feature of roadNetwork.features) {
      const snapped = turf.nearestPointOnLine(feature, pt, { units: 'kilometers' });
      if (snapped.properties.dist < bestDist) {
        bestDist = snapped.properties.dist;
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

  function planRoute(waypoints, speedFactor) {
    if (!ready || !pathFinderInstance) {
      return { error: 'Routing engine not ready. Road data may not be loaded.' };
    }

    speedFactor = speedFactor || 1.0;

    const snappedPoints = waypoints.map((w) => snapToNetwork(w.lng, w.lat));
    for (let i = 0; i < snappedPoints.length; i++) {
      if (!snappedPoints[i]) {
        return { error: `Waypoint ${i + 1} could not be snapped to the road network. Try a location closer to a road.` };
      }
    }

    let totalPath = [];
    let totalWeight = 0;

    for (let i = 0; i < snappedPoints.length - 1; i++) {
      const start = turf.point(snappedPoints[i]);
      const end = turf.point(snappedPoints[i + 1]);
      const result = pathFinderInstance.findPath(start, end);
      if (!result) {
        return { error: `No route found between waypoint ${i + 1} and ${i + 2}. They may be on disconnected road segments.` };
      }
      if (totalPath.length > 0 && result.path.length > 0) {
        totalPath = totalPath.concat(result.path.slice(1));
      } else {
        totalPath = totalPath.concat(result.path);
      }
      totalWeight += result.weight;
    }

    let totalDistance = 0;
    if (totalPath.length >= 2) {
      const line = turf.lineString(totalPath);
      totalDistance = turf.length(line, { units: 'kilometers' });
    }

    const durationSeconds = (totalWeight * 3600) / speedFactor;

    return {
      routes: [
        {
          distance: totalDistance * 1000,
          duration: durationSeconds,
          geometry: totalPath,
        },
      ],
      snappedWaypoints: snappedPoints.map((c) => ({ lng: c[0], lat: c[1] })),
    };
  }

  function geocodePlace(name) {
    const lower = name.toLowerCase();
    const match = KNOWN_PLACES.find((p) =>
      p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase())
    );
    return match || null;
  }

  function listPlaces() {
    return KNOWN_PLACES;
  }

  function getStatus() {
    return {
      ready,
      reason: statusReason,
      segments: roadNetwork ? roadNetwork.features.length : 0,
    };
  }

  // Auto-initialize
  init();

  return { planRoute, geocodePlace, listPlaces, getStatus, snapToNetwork };
}

module.exports = { createRoutePlanner, KNOWN_PLACES };
