const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { createRoutePlanner, KNOWN_PLACES } = require('./route-planner.js');

const app = express();
const PORT = 3000;

app.use(express.json());

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

// --- Shared route planner ---
let planner = null;

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
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(PLACEHOLDER_PNG);
});

// Offline routing endpoint (used by the map UI directly)
app.get('/api/route', (req, res) => {
  if (!planner || !planner.getStatus().ready) {
    return res.status(503).json({
      error: 'Routing unavailable. Run "node road-downloader.js" to download road data first.',
    });
  }

  const { coords } = req.query;
  if (!coords) {
    return res.status(400).json({ error: 'Missing coords parameter' });
  }

  const points = coords.split(';').map((pair) => {
    const [lng, lat] = pair.split(',').map(Number);
    return { lng, lat };
  });

  if (points.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 waypoints' });
  }

  const result = planner.planRoute(points);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});

// --- Deepseek Chat endpoint with function calling ---

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'plan_route',
      description: 'Plan a driving route between two or more waypoints in Singapore. Returns distance, estimated duration, and route geometry.',
      parameters: {
        type: 'object',
        properties: {
          waypoints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lat: { type: 'number', description: 'Latitude' },
                lng: { type: 'number', description: 'Longitude' },
                name: { type: 'string', description: 'Optional place name' },
              },
              required: ['lat', 'lng'],
            },
            minItems: 2,
            description: 'Ordered list of waypoints. First is origin, last is destination.',
          },
          speed_factor: {
            type: 'number',
            description: 'Speed multiplier (0.1-3.0). <1 for traffic/slow, >1 for optimistic.',
            default: 1.0,
          },
        },
        required: ['waypoints'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'geocode_place',
      description: 'Look up coordinates for well-known places in Singapore by name.',
      parameters: {
        type: 'object',
        properties: {
          place_name: {
            type: 'string',
            description: 'Name of a place in Singapore (e.g. "Changi Airport", "Marina Bay Sands")',
          },
        },
        required: ['place_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_places',
      description: 'List all well-known Singapore places available for route planning.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful route planning assistant for Singapore. You help users plan driving routes between locations in Singapore.

You have access to these tools:
- plan_route: Compute driving routes between waypoints. Returns distance and estimated duration.
- geocode_place: Look up coordinates for well-known Singapore locations.
- list_places: Show all known places you can route between.

When a user asks to plan a route:
1. First use geocode_place to look up any place names they mention
2. Then use plan_route with the coordinates to compute the route
3. Present the results clearly with distance and time

If the user mentions places you don't recognize, suggest using list_places to see available locations.
Always respond concisely and include the key route information (distance, duration).`;

function executeToolCall(name, args) {
  switch (name) {
    case 'plan_route': {
      const result = planner.planRoute(args.waypoints, args.speed_factor || 1.0);
      if (result.error) return JSON.stringify({ error: result.error });
      const route = result.routes[0];
      return JSON.stringify({
        distance_km: (route.distance / 1000).toFixed(2),
        distance_m: route.distance,
        duration_minutes: Math.round(route.duration / 60),
        duration_seconds: route.duration,
        waypoints_snapped: result.snappedWaypoints,
        route_points: route.geometry.length,
        geometry: route.geometry,
      });
    }
    case 'geocode_place': {
      const result = planner.geocodePlace(args.place_name);
      if (!result) return JSON.stringify({ error: `Place "${args.place_name}" not found. Use list_places to see available locations.` });
      return JSON.stringify(result);
    }
    case 'list_places': {
      return JSON.stringify(planner.listPlaces().map((p) => ({ name: p.name, lat: p.lat, lng: p.lng })));
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

app.post('/api/chat', async (req, res) => {
  const { messages, apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'Deepseek API key is required. Enter it in the chat settings.' });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!planner || !planner.getStatus().ready) {
    return res.status(503).json({ error: 'Routing engine not ready. Run "node road-downloader.js" first.' });
  }

  const openai = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });

  const chatMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];

  try {
    // Loop to handle multiple rounds of tool calls
    let maxIterations = 10;
    while (maxIterations-- > 0) {
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: chatMessages,
        tools: CHAT_TOOLS,
        tool_choice: 'auto',
      });

      const choice = completion.choices[0];
      const assistantMessage = choice.message;
      chatMessages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // No more tool calls — return the final response
        // Extract route geometry if present in any tool results
        let routeGeometry = null;
        for (const msg of chatMessages) {
          if (msg.role === 'tool') {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.geometry) {
                routeGeometry = parsed.geometry;
              }
            } catch (e) { /* ignore */ }
          }
        }

        return res.json({
          reply: assistantMessage.content,
          route: routeGeometry,
        });
      }

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = executeToolCall(toolCall.function.name, args);
        chatMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    return res.status(500).json({ error: 'Too many tool call iterations' });
  } catch (err) {
    console.error('Chat API error:', err.message);
    if (err.status === 401) {
      return res.status(401).json({ error: 'Invalid Deepseek API key.' });
    }
    return res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

// Initialize SQL.js then start server
initSql().then(() => {
  planner = createRoutePlanner();
  app.listen(PORT, () => {
    console.log(`Offline map server running at http://localhost:${PORT}`);
    console.log(`MCP server available via: node mcp-server.js (stdio transport)`);
  });
}).catch((err) => {
  console.error('Failed to initialize SQL.js:', err.message);
  process.exit(1);
});
