// Run from an external network; credentials never leave the proxy.
const base = process.env.VITE_PROXY_URL;
if (!base) throw Error('VITE_PROXY_URL is required');
const headers = { Origin: 'https://paparship.github.io', 'Content-Type': 'application/json' };
const session = await fetch(base + '/session', { method: 'POST', headers });
if (!session.ok) throw Error('Session: ' + session.status);
headers.Authorization = 'Bearer ' + (await session.json()).token;
const operation = crypto.randomUUID();
const begin = await fetch(base + '/operations', { method: 'POST', headers, body: JSON.stringify({ id: operation }) });
if (!begin.ok) throw Error('Operation: ' + begin.status);
const stream = await fetch(base + '/chat/completions', { method: 'POST', headers: { ...headers, 'X-Operation-Id': operation }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply exactly OK.' }] }), signal: AbortSignal.timeout(120000) });
if (!stream.ok) throw Error('Completion: ' + stream.status);
const text = await stream.text();
if (!text.includes('[DONE]') || !text.includes('OK')) throw Error('Incomplete streaming response');
console.log('PASS: public session, operation and DeepSeek streaming completion');
