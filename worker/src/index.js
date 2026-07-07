/**
 * Voice Chat Clone — Cloudflare Worker
 *
 * API 路由:
 *   POST /api/asr    语音识别 (Groq Whisper)
 *   POST /api/chat   LLM 对话 (Groq / via API Proxy Hub)
 *   POST /api/clone  声音克隆 (Fish Audio)
 *   POST /api/tts    克隆音色 TTS (Fish Audio)
 *   GET  /api/config 客户端配置
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/api/asr':    return handleASR(request, env);
        case '/api/chat':   return handleChat(request, env);
        case '/api/clone':  return handleClone(request, env);
        case '/api/tts':    return handleTTS(request, env);
        case '/api/config': return handleConfig(env);
        default:            return json({ error: 'Not Found' }, 404);
      }
    } catch (e) {
      return json({ error: e.message || 'Internal Error' }, 500);
    }
  },
};

// ─── 配置 ─────────────────────────────────────────────────────────────────────

async function handleConfig(env) {
  return json({
    groq_models: [
      'whisper-large-v3',
      'whisper-large-v3-turbo',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3-32b',
      'gemma2-9b-it',
      'mixtral-8x7b-32768',
    ],
    default_asr_model: 'whisper-large-v3-turbo',
    default_chat_model: env.DEFAULT_CHAT_MODEL || 'llama-3.3-70b-versatile',
    fish_available: !!env.FISH_API_KEY,
    proxy_available: !!env.API_PROXY_KEY,
  });
}

// ─── ASR: 语音 → 文字 (Groq Whisper) ──────────────────────────────────────────

async function handleASR(request, env) {
  const formData = await request.formData();
  const audio = formData.get('audio');
  const model = formData.get('model') || 'whisper-large-v3-turbo';

  if (!audio) return json({ error: '缺少 audio 文件' }, 400);

  const body = new FormData();
  body.append('file', audio, audio.name || 'recording.webm');
  body.append('model', model);
  body.append('language', 'zh');
  body.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Groq ASR 失败: ${err}` }, res.status);
  }

  const result = await res.json();
  return json({ text: result.text.trim() });
}

// ─── CHAT: LLM 对话 ───────────────────────────────────────────────────────────

async function handleChat(request, env) {
  const { messages, model } = await request.json();
  const chatModel = model || env.DEFAULT_CHAT_MODEL || 'llama-3.3-70b-versatile';

  // 优先走 API Proxy Hub（经你已有的网关）
  if (env.API_PROXY_KEY) {
    return proxyChat(messages, chatModel, env.API_PROXY_KEY);
  }

  // 默认走 Groq
  return groqChat(messages, chatModel, env.GROQ_API_KEY);
}

async function groqChat(messages, model, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Groq Chat 失败: ${err}` }, res.status);
  }

  const data = await res.json();
  return json({ text: data.choices[0].message.content });
}

async function proxyChat(messages, model, proxyKey) {
  // 通过 API Proxy Hub 走你已有的 LLM 线路
  const res = await fetch('https://api-proxy-hub.sdbzd3.workers.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': proxyKey,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Proxy Chat 失败: ${err}` }, res.status);
  }

  const data = await res.json();
  return json({ text: data.choices[0].message.content });
}

// ─── CLONE: 上传音频 → 克隆声音 → 获得 voice_id (Fish Audio) ─────────────────

async function handleClone(request, env) {
  if (!env.FISH_API_KEY) {
    return json({ error: '未配置 FISH_API_KEY' }, 400);
  }

  const formData = await request.formData();
  const audio = formData.get('audio');

  if (!audio) return json({ error: '缺少 audio 文件' }, 400);

  const name = formData.get('name') || `voice_${Date.now()}`;

  const body = new FormData();
  body.append('audio', audio, audio.name || 'voice.wav');
  body.append('name', name);
  body.append('mode', 'fast'); // 快速克隆

  const res = await fetch('https://api.fish.audio/v1/voices', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.FISH_API_KEY}` },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Fish Audio 克隆失败: ${err}` }, res.status);
  }

  const result = await res.json();
  return json({
    voice_id: result.voice_id || result.id,
    name: result.name || name,
  });
}

// ─── TTS: 文本 → 语音 (带克隆音色 via Fish Audio) ─────────────────────────────

async function handleTTS(request, env) {
  if (!env.FISH_API_KEY) {
    return json({ error: '未配置 FISH_API_KEY，前端可回退到浏览器原生 TTS' }, 400);
  }

  const { text, voice_id } = await request.json();
  if (!text || !voice_id) {
    return json({ error: '缺少 text 或 voice_id' }, 400);
  }

  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.FISH_API_KEY}`,
    },
    body: JSON.stringify({
      text,
      voice_id,
      format: 'mp3',
      speed: 1.0,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Fish Audio TTS 失败: ${err}` }, res.status);
  }

  return new Response(res.body, {
    headers: {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
