// ClaudeOS's memory MCP server: the official one (@modelcontextprotocol/server-memory, same tools and the same
// memory.jsonl), with a lean search. The official search_nodes returns every matching entry with all of its
// notes, so one large entry can put tens of thousands of tokens into a chat for a one-word query. Here a search
// returns, for each matching entry, only the notes that match (newest first, at most SEARCH_NOTES), and says how
// many more it has; open_nodes still returns an entry in full when the agent needs all of it.
import { KnowledgeGraphManager, main } from '@modelcontextprotocol/server-memory/dist/index.js';

export const SEARCH_NOTES = 8;

// self-contained (only its arguments), so the Harbor benchmark can write it into a container as it is
export function trimSearch(graph, query, limit = 8) {
  const q = String(query || '').toLowerCase();
  const entities = graph.entities.map(e => {
    const named = e.name.toLowerCase().includes(q) || e.entityType.toLowerCase().includes(q);
    // the notes that mention the query; an entry found by its name shows its newest notes instead
    const hits = e.observations.filter(o => o.toLowerCase().includes(q));
    const pool = hits.length ? hits : named ? e.observations : [];
    const shown = pool.slice(-limit);
    const more = e.observations.length - shown.length;
    return { ...e, observations: more > 0 ? [...shown, `(${more} more note${more === 1 ? '' : 's'} on this entry; open_nodes with its name shows them all)`] : shown };
  });
  return { entities, relations: graph.relations };
}

const original = KnowledgeGraphManager.prototype.searchNodes;
KnowledgeGraphManager.prototype.searchNodes = async function (query) { return trimSearch(await original.call(this, query), query, SEARCH_NOTES); };

export const start = () => main();
// `node memory-mcp.mjs` (development); the packaged app calls start() from exe-main.mjs
if (/memory-mcp\.mjs$/.test(process.argv[1] || '')) start();
