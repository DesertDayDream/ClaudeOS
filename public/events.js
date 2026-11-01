// One shared live connection to the ClaudeOS server for every part of the page
// (browsers only keep a handful of connections per site open at once).
export const events = new EventSource('/api/events');
