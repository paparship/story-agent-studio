import { expect, it } from 'vitest';
import { OpenAIClient, validateProvider } from '../src/llm/client';
const response = (text: string) => new Response(new ReadableStream({ start(c) { for (const byte of new TextEncoder().encode(text)) c.enqueue(new Uint8Array([byte])); c.close(); } }));
it('decodes Chinese SSE split at arbitrary byte boundaries', async () => {
  const content = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'; let streamed = '';
  const c = new OpenAIClient('https://example.com/chat/completions', {}, 'model', async () => response(content)); expect((await c.complete([], x => streamed += x)).text).toBe('你好'); expect(streamed).toBe('你好');
});
it('rejects interrupted output instead of presenting partial DSL as complete', async () => {
  const c = new OpenAIClient('https://example.com', {}, 'model', async () => response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); await expect(c.complete([], () => {})).rejects.toThrow('中断');
});
it('does not add vendor-specific thinking options to generic providers', async () => {
  const c = new OpenAIClient('https://example.com', {}, 'generic', async (_url, init) => { expect(JSON.parse(init!.body as string)).not.toHaveProperty('thinking'); return response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'); }); await c.complete([], () => {});
});
it('rejects API URLs containing credentials or insecure remote HTTP', () => {
  for (const base_url of ['http://example.com', 'https://secret@example.com', 'https://example.com?key=secret']) expect(() => validateProvider({ base_url, api_key: 'test', model: 'model' })).toThrow();
});
