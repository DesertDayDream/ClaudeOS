// Only the backend's private parent IPC channel can control the desktop shell.
// Nothing from this module is exposed to the page or preview frames.
export const IS_DESKTOP = process.env.CLAUDEOS_DESKTOP === '1' && typeof process.send === 'function';
let sequence = 0;
const requests = new Map();
export function desktopEvent(type, value = {}) {
  if (IS_DESKTOP && process.connected) process.send({ type, value }, () => {});
}
export function desktopRequest(type, value = {}) {
  if (!IS_DESKTOP || !process.connected) return Promise.resolve({ error: 'Desktop shell is unavailable.' });
  return new Promise(resolve => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); resolve({ error: 'Desktop shell did not respond.' }); }, 10000);
    requests.set(id, result => { clearTimeout(timer); resolve(result); });
    process.send({ type, value, id }, error => {
      if (!error) return;
      requests.get(id)?.({ error: error.message }); requests.delete(id);
    });
  });
}
if (IS_DESKTOP) process.on('message', message => {
  if (message?.type !== 'desktop-reply') return;
  requests.get(message.id)?.(message.value); requests.delete(message.id);
});
