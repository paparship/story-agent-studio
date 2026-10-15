export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface Provider { base_url: string; api_key: string; model: string }
export interface Completion { text: string; finishReason: string; usage: unknown }
export interface ModelClient { complete(messages: Message[], delta: (text: string) => void, signal?: AbortSignal): Promise<Completion> }
export function validateProvider(p: Provider): Provider {
  const url = new URL(p.base_url.trim().replace(/\/chat\/completions\/?$/, '').replace(/\/$/, ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('API 地址需使用 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw Error('API 地址格式不正确');
  if (!p.model.trim() || !p.api_key.trim() || /[\r\n]/.test(p.api_key) || p.api_key.length > 4096) throw Error('请填写有效的模型名称和 API Key');
  return { base_url: url.href.replace(/\/$/, ''), api_key: p.api_key.trim(), model: p.model.trim() };
}
export class OpenAIClient implements ModelClient {
  constructor(private endpoint: string, private headers: Record<string, string>, private model: string, private transport: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  static custom(provider: Provider) { const p = validateProvider(provider); return new OpenAIClient(p.base_url + '/chat/completions', { Authorization: 'Bearer ' + p.api_key }, p.model); }
  async complete(messages: Message[], delta: (text: string) => void, signal?: AbortSignal): Promise<Completion> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
    const request = () => this.transport(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers }, body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: 16000, ...(this.model.startsWith('deepseek') ? { thinking: { type: 'disabled' } } : {}) }), signal: requestSignal });
    let r = await request();
    for (let retry = 0; r.status === 409 && retry < 4; retry++) {
      const error = await r.clone().json().catch(() => ({})); if (error.code !== 'OPERATION_BUSY') break;
      await r.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 250 * (retry + 1))); requestSignal.throwIfAborted(); r = await request();
    }
    if (!r.ok) { if (r.status === 429) throw Error('模型服务请求较多，请稍后重试。'); throw Error(`模型服务请求失败（${r.status}）`); }
    if (!r.body) throw Error('模型服务未返回输出流');
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '', text = '', finishReason = '', usage: unknown = null, done = false;
    const consume = (block: string) => {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) return; if (data === '[DONE]') { done = true; return; }
      let value: any; try { value = JSON.parse(data); } catch { throw Error('模型流数据格式错误'); }
      if (value.error) throw Error('模型服务返回错误');
      const choice = value.choices?.[0]; if (choice?.delta?.content) { text += choice.delta.content; delta(choice.delta.content); }
      if (choice?.finish_reason) finishReason = choice.finish_reason; if (value.usage) usage = value.usage;
    };
    try {
      while (!done) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
        let end; while ((end = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
        if (text.length > 300000 || buffer.length > 1000000) throw Error('模型输出超出限制');
      }
      buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
      if ((!done && !finishReason) || !text.trim()) throw Error('模型输出中断，请重试');
      if (finishReason === 'length') throw Error('模型输出达到长度上限，请缩小本次故事范围');
      if (finishReason && finishReason !== 'stop') throw Error('模型输出未正常结束');
      return { text, finishReason, usage };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
