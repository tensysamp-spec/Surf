// AI access for the browser's features: the Claude API, or your own server running an
// open model (Ollama or anything else with an OpenAI-compatible /v1/chat/completions).
// Keys/tokens are stored encrypted (safeStorage / macOS Keychain) and never leave the main process.

const { app, ipcMain, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Anthropic } = require('@anthropic-ai/sdk');

const AI_MODEL = 'claude-opus-5-5';
// Server-side fallback: if a request is declined, the API retries it on a suitable model
const AI_BETAS = ['server-side-fallback-2026-07-01'];

// Small open models read far less than Claude; long pages are cut to fit
const SERVER_CHAR_LIMIT = 40000;

module.exports = function setupAi(M) {
  const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');
  const serverFile = () => path.join(app.getPath('userData'), 'ai-server.json');
  const serverTokenFile = () => path.join(app.getPath('userData'), 'ai-server-token.bin');
  let client = null;

  function readSecret(file) {
    try {
      const data = fs.readFileSync(file);
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8');
    } catch {
      return null;
    }
  }

  async function writeSecret(file, value) {
    if (!value) return fs.promises.rm(file, { force: true });
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
    await fs.promises.writeFile(file, data, { mode: 0o600 });
  }

  const readStoredKey = () => readSecret(keyFile());

  // { url, model } of your own AI server, or null to use Claude
  function readServer() {
    try {
      const s = JSON.parse(fs.readFileSync(serverFile(), 'utf8'));
      return s && s.url && s.model ? s : null;
    } catch {
      return null;
    }
  }

  function getClient() {
    if (client) return client;
    const apiKey = readStoredKey();
    // Without a saved key the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    return client;
  }

  function friendlyError(err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in Settings (⌘,).';
    if (err instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to that model.';
    if (err instanceof Anthropic.RateLimitError) return 'Rate limited — try again in a moment.';
    if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your connection.';
    if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}): ${err.message}`;
    if (/auth|api.?key|credential/i.test(String(err && err.message))) return 'No API key set. Add one in Settings (⌘,).';
    return String((err && err.message) || err);
  }

  ipcMain.handle('ai-has-key', () => !!readServer() || !!readStoredKey() || !!process.env.ANTHROPIC_API_KEY);

  ipcMain.handle('ai-set-key', async (_event, key) => {
    await writeSecret(keyFile(), String(key || '').trim());
    client = null;
    return true;
  });

  /* ---------------------------------------------------------------- */
  /* Your own server (OpenAI-compatible chat completions)             */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('ai-get-server', () => {
    const s = readServer();
    return s ? { ...s, hasToken: !!readSecret(serverTokenFile()) } : null;
  });

  // { url, model, token } — token undefined keeps the saved one; null server switches back to Claude
  ipcMain.handle('ai-set-server', async (_event, server) => {
    if (!server) {
      await fs.promises.rm(serverFile(), { force: true });
      await writeSecret(serverTokenFile(), '');
      return true;
    }
    const url = String(server.url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    const model = String(server.model || '').trim();
    if (!/^https?:\/\//i.test(url) || !model) return { error: 'Enter the server address (https://…) and a model name.' };
    await fs.promises.writeFile(serverFile(), JSON.stringify({ url, model }));
    if (server.token !== undefined) await writeSecret(serverTokenFile(), String(server.token || '').trim());
    return true;
  });

  ipcMain.handle('ai-test-server', async () => {
    try {
      const text = await serverChat({ messages: [{ role: 'user', content: 'Reply with just the word: ready' }], maxTokens: 10 });
      return { ok: true, text: text.trim() };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  const flatten = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n'));

  // Anthropic-style system + messages → OpenAI-style messages, trimmed to fit a small model
  function toServerMessages(system, messages) {
    let sys = flatten(system || '');
    const out = messages.map((m) => ({ role: m.role, content: flatten(m.content) }));
    const total = () => sys.length + out.reduce((n, m) => n + m.content.length, 0);
    if (total() > SERVER_CHAR_LIMIT) {
      // Pages live in the system prompt (or the first message); cut the biggest one
      const over = total() - SERVER_CHAR_LIMIT;
      const target = out[0] && out[0].content.length > sys.length ? out[0] : null;
      if (target) target.content = `${target.content.slice(0, Math.max(2000, target.content.length - over))}\n…(cut to fit)`;
      else sys = `${sys.slice(0, Math.max(2000, sys.length - over))}\n…(cut to fit)`;
    }
    return sys ? [{ role: 'system', content: sys }, ...out] : out;
  }

  async function serverRequest(body) {
    const server = readServer();
    const token = readSecret(serverTokenFile());
    let res;
    try {
      res = await net.fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model: server.model, ...body }),
      });
    } catch (err) {
      throw new Error(`Could not reach your AI server (${server.url}). Is it running?`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Your AI server rejected the access token. Check it in Settings (⌘,).');
    if (res.status === 404) throw new Error(`Your AI server doesn’t have the model “${server.model}”. Pull it on the server or fix the name in Settings.`);
    if (!res.ok) throw new Error(`AI server error (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  // Non-streamed reply text
  async function serverChat({ system, messages, maxTokens = 4096, responseFormat }) {
    const res = await serverRequest({
      messages: toServerMessages(system, messages),
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  // Streamed reply: calls onText for each piece of text (server-sent events)
  async function serverStream({ system, messages }, onText) {
    const res = await serverRequest({ messages: toServerMessages(system, messages), max_tokens: 4096, stream: true });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finish = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, '').trim();
        if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
        try {
          const choice = JSON.parse(data).choices[0];
          if (choice.delta && choice.delta.content) onText(choice.delta.content);
          if (choice.finish_reason) finish = choice.finish_reason;
        } catch { /* partial or keep-alive line */ }
      }
    }
    return finish === 'length' ? 'max_tokens' : 'end_turn';
  }

  // Streamed completion; text arrives as 'ai-delta' events, then one 'ai-done'
  ipcMain.on('ai-stream', async (event, { requestId, system, messages, effort }) => {
    const reply = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { requestId, ...payload });
    };
    try {
      if (readServer()) {
        const stopReason = await serverStream({ system, messages }, (text) => reply('ai-delta', { text }));
        reply('ai-done', { stopReason, error: null });
        return;
      }
      const stream = getClient().beta.messages.stream({
        model: AI_MODEL,
        max_tokens: 64000,
        betas: AI_BETAS,
        fallbacks: 'default',
        output_config: { effort: effort || 'medium' },
        system,
        messages,
      });
      stream.on('text', (delta) => reply('ai-delta', { text: delta }));
      const final = await stream.finalMessage();
      reply('ai-done', {
        stopReason: final.stop_reason,
        error: final.stop_reason === 'refusal' ? 'Claude declined to answer this one.' : null,
      });
    } catch (err) {
      reply('ai-done', { error: friendlyError(err) });
    }
  });

  // One-shot structured (JSON schema) request
  ipcMain.handle('ai-json', async (_event, { system, prompt, schema, effort }) => {
    try {
      if (readServer()) {
        const text = await serverChat({
          system: `${flatten(system || '')}\n\nReply with only JSON matching this schema:\n${JSON.stringify(schema)}`,
          messages: [{ role: 'user', content: prompt }],
          responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema } },
        });
        try {
          return { data: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) };
        } catch {
          return { error: 'Your AI server didn’t return valid JSON. Try a larger model.' };
        }
      }
      const response = await getClient().beta.messages.create({
        model: AI_MODEL,
        max_tokens: 16000,
        betas: AI_BETAS,
        fallbacks: 'default',
        output_config: { effort: effort || 'low', format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') return { error: 'Claude declined this request.' };
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { data: JSON.parse(text) };
    } catch (err) {
      return { error: friendlyError(err) };
    }
  });

  // Answers with live web search (server tool); sources are returned separately
  ipcMain.on('ai-ask-web', async (event, { requestId, messages, system }) => {
    const reply = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { requestId, ...payload });
    };
    const sources = new Map();
    const convo = [...messages];
    try {
      // Web search runs on Anthropic's side; your own model answers from what it knows
      if (readServer()) {
        const stopReason = await serverStream({
          system: 'You answer questions for someone using a web browser. You cannot search the web, so answer from what you know and say when something may be out of date. Be concise: lead with the answer, then short supporting points. Use Markdown.',
          messages,
        }, (text) => reply('ai-delta', { text }));
        reply('ai-done', { stopReason, sources: [] });
        return;
      }
      // Server tools can pause long turns; continue a few times if needed
      for (let round = 0; round < 4; round++) {
        const stream = getClient().beta.messages.stream({
          model: AI_MODEL,
          max_tokens: 64000,
          betas: AI_BETAS,
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          system: system || 'You answer questions for someone using a web browser. Search the web when the answer depends on current or specific facts. Be concise: lead with the answer, then short supporting points. Use Markdown for structure. Do not paste URLs into the text; sources are listed separately.',
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
          messages: convo,
        });
        stream.on('text', (delta) => reply('ai-delta', { text: delta }));
        const final = await stream.finalMessage();
        for (const block of final.content) {
          if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            for (const r of block.content) if (r.url && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title || r.url });
          }
        }
        if (final.stop_reason === 'pause_turn') {
          convo.push({ role: 'assistant', content: final.content });
          continue;
        }
        reply('ai-done', {
          stopReason: final.stop_reason,
          sources: [...sources.values()].slice(0, 8),
          error: final.stop_reason === 'refusal' ? 'Claude declined to answer this one.' : null,
        });
        return;
      }
      reply('ai-done', { sources: [...sources.values()].slice(0, 8) });
    } catch (err) {
      reply('ai-done', { error: friendlyError(err) });
    }
  });

  // Readable text of a URL (for link summaries / previews / chatting with unloaded tabs)
  // (with the asking window's cookies, so a private window never sends the normal profile's)
  // (partition: the asking tab's isolated Space, so it gets that Space's logins, not the default ones)
  ipcMain.handle('fetch-page-text', async (event, url, partition) => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return { error: 'Not a web page' };
    try {
      const res = await M.sessionForPartition(event.sender, partition).fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const text = html
        .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      return { title: title.trim(), text };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  // Raw text of a URL (RSS/Atom feeds, JSON APIs for live folders)
  // (in the session of the Space the live folder lives in; a private window's own partition)
  ipcMain.handle('fetch-text', async (event, url, partition) => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return { error: 'Not a web address' };
    try {
      const res = await M.sessionForPartition(event.sender, partition).fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Surf live folders)', Accept: '*/*' } });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { text: await res.text() };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  return { getClient, friendlyError, AI_MODEL, AI_BETAS };
};
