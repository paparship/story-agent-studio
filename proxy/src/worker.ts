import { DurableObject } from 'cloudflare:workers';
interface Env { DEEPSEEK_API_KEY: string; SESSION_SECRET: string; ALLOWED_ORIGINS: string; MODEL: string; DAILY_MODEL_CALLS: string; QUOTAS: DurableObjectNamespace<QuotaStore> }
interface Operation { created: number; calls: number; busyUntil: number }
interface Ledger { count: number; operations: Record<string, Operation> }
export class QuotaStore extends DurableObject<Env> {
  async increment(key: string, limit: number): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => { const n = await tx.get<number>(key) || 0; if (n >= limit) return false; await tx.put(key, n + 1); return true; });
  }
  async begin(id: string): Promise<string> {
    return this.ctx.storage.transaction(async tx => {
      const ledger = await tx.get<Ledger>('ledger') || { count: 0, operations: {} };
      if (ledger.operations[id]) return Date.now() - ledger.operations[id].created < 1800000 ? 'ok' : 'expired';
      if (ledger.count >= 10) return 'exhausted';
      ledger.count++; ledger.operations[id] = { created: Date.now(), calls: 0, busyUntil: 0 }; await tx.put('ledger', ledger); return 'ok';
    });
  }
  async acquire(id: string): Promise<string> {
    return this.ctx.storage.transaction(async tx => {
      const ledger = await tx.get<Ledger>('ledger'), op = ledger?.operations[id];
      if (!op || Date.now() - op.created > 1800000) return 'expired';
      if (op.calls >= 26) return 'budget'; if (op.busyUntil > Date.now()) return 'busy';
      op.calls++; op.busyUntil = Date.now() + 300000; await tx.put('ledger', ledger!); return 'ok';
    });
  }
  async release(id: string): Promise<void> { await this.ctx.storage.transaction(async tx => { const l = await tx.get<Ledger>('ledger'); if (l?.operations[id]) { l.operations[id].busyUntil = 0; await tx.put('ledger', l); } }); }
}
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function signingKey(secret: string) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sign(payload: string, secret: string) { return b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), enc.encode(payload)))); }
async function visitor(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || ''; if (token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.'); if (!payload || !signature || extra) return null;
  try { if (!await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), unb64(signature), enc.encode(payload))) return null; const data = JSON.parse(new TextDecoder().decode(unb64(payload))); return typeof data.id === 'string' && /^[a-f0-9-]{36}$/.test(data.id) && data.exp > Date.now() ? data.id : null; } catch { return null; }
}
async function readJSON(request: Request): Promise<any> {
  if (Number(request.headers.get('Content-Length') || 0) > 400000 || !request.body) throw Error('body');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 400000) throw Error('body'); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '', allowed = env.ALLOWED_ORIGINS.split(',').map(x => x.trim());
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Operation-Id', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    const reply = (status: number, code: string, data: object = {}) => Response.json({ code, ...data }, { status, headers });
    if (!allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply(405, 'METHOD');
    if (!env.DEEPSEEK_API_KEY || !env.SESSION_SECRET) return reply(503, 'UNCONFIGURED');
    const path = new URL(request.url).pathname;
    if (path === '/session') {
      // Anonymous browser identity; IP issuance throttling limits reset abuse without storing raw IPs.
      const ipHash = await sign(request.headers.get('CF-Connecting-IP') || 'local', env.SESSION_SECRET), bucket = env.QUOTAS.getByName('issuance:' + ipHash);
      if (!await bucket.increment('day:' + new Date().toISOString().slice(0, 10), 3)) return reply(429, 'RATE_LIMIT');
      const payload = b64(enc.encode(JSON.stringify({ id: crypto.randomUUID(), exp: Date.now() + 365 * 86400000 }))); return reply(200, 'OK', { token: payload + '.' + await sign(payload, env.SESSION_SECRET) });
    }
    const user = await visitor(request, env); if (!user) return reply(401, 'SESSION_REQUIRED'); const quota = env.QUOTAS.getByName('visitor:' + user);
    if (path === '/operations') {
      let body; try { body = await readJSON(request); } catch { return reply(400, 'INVALID_BODY'); }
      if (!body || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return reply(400, 'INVALID_OPERATION');
      const result = await quota.begin(body.id); if (result !== 'ok') return reply(result === 'exhausted' ? 429 : 409, result === 'exhausted' ? 'QUOTA_EXHAUSTED' : 'OPERATION_EXPIRED'); return reply(200, 'OK', { id: body.id });
    }
    if (path !== '/chat/completions') return reply(404, 'NOT_FOUND');
    let body; try { body = await readJSON(request); } catch { return reply(400, 'INVALID_BODY'); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40 || body.messages.some((m: any) => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') || body.messages.reduce((n: number, m: any) => n + m.content.length, 0) > 180000) return reply(400, 'INVALID_MESSAGES');
    const op = request.headers.get('X-Operation-Id') || ''; if (!/^[a-f0-9-]{36}$/.test(op)) return reply(400, 'INVALID_OPERATION');
    const acquired = await quota.acquire(op); if (acquired !== 'ok') return reply(acquired === 'busy' ? 409 : 422, 'OPERATION_' + acquired.toUpperCase());
    const globalBudget = env.QUOTAS.getByName('global');
    if (!await globalBudget.increment('day:' + new Date().toISOString().slice(0, 10), Number(env.DAILY_MODEL_CALLS) || 200)) { await quota.release(op); return reply(503, 'SERVICE_BUSY'); }
    try {
      const upstream = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.MODEL || 'deepseek-flash', messages: body.messages.map((m: any) => ({ role: m.role, content: m.content })), stream: true, stream_options: { include_usage: true }, max_tokens: 16000, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(300000) });
      if (!upstream.ok || !upstream.body) { await quota.release(op); return reply(502, 'UPSTREAM_UNAVAILABLE'); }
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) { try { const chunk = await reader.read(); if (chunk.done) { controller.close(); await quota.release(op); } else controller.enqueue(chunk.value); } catch { controller.error(Error('模型连接中断')); await quota.release(op); } },
        async cancel() { await reader.cancel(); await quota.release(op); }
      });
      return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' } });
    } catch { await quota.release(op); return reply(502, 'UPSTREAM_UNAVAILABLE'); }
  }
} satisfies ExportedHandler<Env>;
