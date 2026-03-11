#!/usr/bin/env node

/**
 * MCP Server for offline route planning in Singapore.
 *
 * Exposes tools:
 *   - plan_route: Compute a route between waypoints
 *   - geocode_place: Look up well-known Singapore locations
 *
 * Transports:
 *   - stdio  (default): for CLI-based MCP clients
 *   - sse:   launched from server.js for browser-based access
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createRoutePlanner } = require('./route-planner.js');

async function main() {
  const planner = createRoutePlanner();

  const server = new McpServer({
    name: 'offline-map-router',
    version: '1.0.0',
  });

  // --- Tool: plan_route ---
  server.tool(
    'plan_route',
    'Plan a driving route between two or more waypoints in Singapore. Returns distance, estimated duration, and the route geometry. Coordinates are in [latitude, longitude] format.',
    {
      waypoints: z.array(
        z.object({
          lat: z.number().describe('Latitude of the waypoint'),
          lng: z.number().describe('Longitude of the waypoint'),
          name: z.string().optional().describe('Optional name/label for the waypoint'),
        })
      ).min(2).describe('Ordered list of waypoints (at least 2). First is origin, last is destination.'),
      speed_factor: z.number().min(0.1).max(3.0).default(1.0).optional()
        .describe('Speed multiplier (0.1-3.0). Use <1 for slower estimates (e.g. traffic), >1 for faster.'),
    },
    async ({ waypoints, speed_factor }) => {
      const result = planner.planRoute(waypoints, speed_factor || 1.0);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      const route = result.routes[0];
      const distKm = (route.distance / 1000).toFixed(2);
      const durMin = Math.round(route.duration / 60);

      const waypointDesc = waypoints
        .map((w, i) => `  ${i + 1}. ${w.name || `Waypoint ${i + 1}`} (${w.lat.toFixed(5)}, ${w.lng.toFixed(5)})`)
        .join('\n');

      const text = [
        `Route planned successfully!`,
        ``,
        `Waypoints:`,
        waypointDesc,
        ``,
        `Total distance: ${distKm} km`,
        `Estimated duration: ~${durMin} minutes`,
        `Speed factor: ${speed_factor || 1.0}x`,
        `Route points: ${route.geometry.length} coordinates`,
      ].join('\n');

      return {
        content: [
          { type: 'text', text },
          {
            type: 'text',
            text: JSON.stringify({
              distance_m: route.distance,
              distance_km: parseFloat(distKm),
              duration_seconds: route.duration,
              duration_minutes: durMin,
              waypoints: result.snappedWaypoints,
              geometry: route.geometry,
            }),
          },
        ],
      };
    }
  );

  // --- Tool: geocode_place ---
  server.tool(
    'geocode_place',
    'Look up coordinates for well-known places in Singapore. Use this to convert place names to coordinates before planning a route.',
    {
      place_name: z.string().describe('Name of a place in Singapore (e.g. "Changi Airport", "Marina Bay Sands", "NUS")'),
    },
    async ({ place_name }) => {
      const result = planner.geocodePlace(place_name);
      if (!result) {
        return {
          content: [{ type: 'text', text: `Could not find "${place_name}". Try a more specific name or provide coordinates directly.` }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `${result.name}: latitude ${result.lat}, longitude ${result.lng}`,
        }],
      };
    }
  );

  // --- Tool: list_places ---
  server.tool(
    'list_places',
    'List all well-known Singapore places available for geocoding.',
    {},
    async () => {
      const places = planner.listPlaces();
      const text = places.map((p) => `- ${p.name} (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`).join('\n');
      return {
        content: [{ type: 'text', text: `Known places in Singapore:\n${text}` }],
      };
    }
  );

  // --- Tool: routing_status ---
  server.tool(
    'routing_status',
    'Check if the offline routing engine is ready and has road data loaded.',
    {},
    async () => {
      const status = planner.getStatus();
      return {
        content: [{
          type: 'text',
          text: status.ready
            ? `Routing engine is ready. ${status.segments} road segments loaded.`
            : `Routing engine is NOT ready. ${status.reason}`,
        }],
      };
    }
  );

  // Start with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
