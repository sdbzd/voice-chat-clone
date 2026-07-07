/**
 * Voice Chat Clone — 前端应用逻辑
 */

// ─── 配置 ─────────────────────────────────────────────────────────────────────
// 生产环境：Worker API 地址
const API_BASE = 'https://voice-chat-clone.sdbzd3.workers.dev';
// 开发时如果同源部署，改为：
// const API_BASE = window.location.origin;

const CALIBRATION_TEXT =
  '今天天气真不错，阳光明媚，微风习习。我正在测试语音克隆的效果，希望这个系统能够准确还原我的声音，让我用自然的方式和AI对话。';

// ─── 状态 ─────────────────────────────────────────────────────────────────────
const state = {
  voiceId: null,           // 克隆的 voice_id
  isRecording: false,
  isSpeaking: false,
  mediaRecorder: null,
  audioChunks: [],
  chatHistory: [
    { role: 'system', content: '你是一个语音对话助手。回复简洁自然，适合语音朗读。使用中文。' },
  ],
  config: null,
  cloneQuality: 0,         // 0=未克隆, 1=差, 2=中, 3=好
  sessionId: Date.now().toString(36),
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const chatArea = $('#chatArea');
const recordBtn = $('#recordBtn');
const uploadBtn = $('#uploadBtn');
const infoText = $('#infoText');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const settingsToggle = $('#settingsToggle');
const settingsPanel = $('#settingsPanel');
const chatModelSelect = $('#chatModelSelect');
const asrModelSelect = $('#asrModelSelect');
const voiceIdDisplay = $('#voiceIdDisplay');
const calibrationModal = $('#calibrationModal');
const calibrationTextEl = $('#calibrationText');
const startCalibrationBtn = $('#startCalibrationBtn');
const uploadCalibrationBtn = $('#uploadCalibrationBtn');
const audioFileInput = $('#audioFileInput');

// ─── 初始化 ────────────────────────────────────────────────────────────────────

async function init() {
  // 获取配置
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    state.config = await res.json();
    setStatus(state.config.fish_available ? 'ready' : 'idle',
      state.config.fish_available ? '就绪' : '无克隆 Key');
    if (!state.config.fish_available) {
      addSystemMsg('⚠️ 未配置 Fish Audio Key，将使用浏览器原生语音（无克隆效果）');
    }
  } catch (e) {
    setStatus('error', '无法连接服务器');
    addSystemMsg(`❌ 连接服务器失败: ${e.message}`);
  }

  // 事件绑定
  recordBtn.addEventListener('mousedown', startRecording);
  recordBtn.addEventListener('mouseup', stopRecording);
  recordBtn.addEventListener('mouseleave', () => { if (state.isRecording) stopRecording(); });
  // 触屏支持
  recordBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
  recordBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });

  uploadBtn.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', handleFileUpload);

  settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('open'));
  chatModelSelect.addEventListener('change', () => {});

  startCalibrationBtn.addEventListener('click', startCalibrationRecording);
  uploadCalibrationBtn.addEventListener('click', () => {
    calibrationModal.classList.remove('open');
    audioFileInput.click();
  });
}

// ─── 录音 ────────────────────────────────────────────────────────────────────

async function startRecording() {
  if (state.isRecording) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4',
    });

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType });
      if (blob.size < 1000) {
        setStatus(state.config?.fish_available ? 'ready' : 'idle', '录音太短');
        return;
      }
      await processAudio(blob);
    };

    state.mediaRecorder.start();
    state.isRecording = true;
    recordBtn.classList.add('recording');
    recordBtn.textContent = '🔴';
    infoText.textContent = '录音中...松开发送';
  } catch (e) {
    addSystemMsg(`❌ 麦克风权限被拒绝: ${e.message}`);
    setStatus('error', '无麦克风权限');
  }
}

function stopRecording() {
  if (!state.isRecording || !state.mediaRecorder) return;
  state.mediaRecorder.stop();
  state.isRecording = false;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '🎤';
  infoText.textContent = '处理中...';
}

// ─── 上传音频 ────────────────────────────────────────────────────────────────

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  // 如果已经有 voice_id，询问是否重新克隆
  if (state.voiceId) {
    addSystemMsg('📤 上传音频 → 重新克隆声音...');
  } else {
    addSystemMsg('📤 上传音频 → 克隆声音...');
  }

  await cloneVoice(file);
  setStatus('ready', `已克隆 ✅`);
}

// ─── 处理音频：ASR → Chat → TTS ──────────────────────────────────────────────

async function processAudio(audioBlob) {
  setStatus('cloning', '识别中...');

  // 1. ASR：语音转文字
  const text = await asr(audioBlob);
  if (!text) {
    setStatus(state.voiceId ? 'ready' : 'idle', '未能识别');
    infoText.textContent = '未能识别，重试';
    return;
  }

  // 显示用户消息
  addMsg('user', '你', text);

  // 2. 如果尚未克隆声音，自动克隆
  if (!state.voiceId && state.config?.fish_available) {
    setStatus('cloning', '克隆声音中...');
    await cloneVoice(audioBlob);
  }

  // 3. 如果已有克隆但质量差（第一次克隆），提示校准
  if (state.voiceId && state.cloneQuality === 1 && state.config?.fish_available) {
    showCalibrationPrompt();
  }

  // 4. Chat：LLM 对话
  setStatus('cloning', '思考中...');
  state.chatHistory.push({ role: 'user', content: text });
  const reply = await chat(state.chatHistory);
  if (!reply) {
    setStatus(state.voiceId ? 'ready' : 'idle', '对话失败');
    return;
  }
  state.chatHistory.push({ role: 'assistant', content: reply });
  const isClone = !!state.voiceId;

  // 5. TTS：生成语音（有克隆音色就用，没有就回退浏览器 TTS）
  setStatus('cloning', '生成语音...');
  if (state.voiceId && state.config?.fish_available) {
    const audioUrl = await tts(reply, state.voiceId);
    if (audioUrl) {
      addMsg('bot', isClone ? '🎙️ 克隆语音' : '🤖 助手', reply, audioUrl, 'clone');
      setStatus('ready', `已克隆 ✅`);
      infoText.textContent = '点击🎤继续对话';
      return;
    }
  }

  // 回退：浏览器原生 TTS + 纯文本
  speakBrowser(reply);
  addMsg('bot', '🤖 助手 (浏览器语音)', reply, null, 'clone');
  setStatus('ready', '就绪');
  infoText.textContent = '点击🎤继续对话';
}

// ─── API 调用 ────────────────────────────────────────────────────────────────

async function asr(audioBlob) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  // 优先用 HF Whisper（走 API Proxy Hub），否则回退 Groq
  if (state.config?.proxy_available) {
    formData.append('backend', 'hf_whisper');
  }

  const res = await fetch(`${API_BASE}/api/asr`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) { addSystemMsg(`❌ 语音识别失败: ${data.error}`); return ''; }
  return data.text;
}

async function chat(messages) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: chatModelSelect.value,
    }),
  });
  const data = await res.json();
  if (!res.ok) { addSystemMsg(`❌ 对话失败: ${data.error}`); return ''; }
  return data.text;
}

async function cloneVoice(audioBlob) {
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.wav');
    formData.append('name', `user_${state.sessionId}`);

    const res = await fetch(`${API_BASE}/api/clone`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      addSystemMsg(`❌ 克隆失败: ${err.error}`);
      state.cloneQuality = 0;
      return;
    }
    const data = await res.json();
    state.voiceId = data.voice_id;
    voiceIdDisplay.value = data.voice_id ? data.voice_id.substring(0, 16) + '...' : '?';
    state.cloneQuality = 2; // 初始克隆，质量待评估
    addSystemMsg(`✅ 声音已克隆${data.name ? ' (' + data.name + ')' : ''}`);
  } catch (e) {
    addSystemMsg(`❌ 克隆异常: ${e.message}`);
  }
}

async function tts(text, voiceId) {
  try {
    const res = await fetch(`${API_BASE}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voiceId }),
    });
    if (!res.ok) {
      const err = await res.json();
      addSystemMsg(`❌ TTS 失败: ${err.error}`);
      return null;
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    addSystemMsg(`❌ TTS 异常: ${e.message}`);
    return null;
  }
}

// ─── 浏览器原生 TTS 回退 ─────────────────────────────────────────────────────

function speakBrowser(text) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

// ─── 校准提示 ─────────────────────────────────────────────────────────────────

function showCalibrationPrompt() {
  calibrationTextEl.textContent = CALIBRATION_TEXT;
  calibrationModal.classList.add('open');
}

async function startCalibrationRecording() {
  calibrationModal.classList.remove('open');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4',
    });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      addSystemMsg('📝 收到校准录音，重新克隆...');
      setStatus('cloning', '校准克隆...');
      await cloneVoice(blob);
      state.cloneQuality = 3; // 校准后质量好
      setStatus('ready', '校准完成 ✅');
    };
    startCalibrationBtn.disabled = true;
    startCalibrationBtn.textContent = '🔴 朗读中...';
    recorder.start();
    // 5秒后自动停止（足够读完校准文本）
    setTimeout(() => {
      recorder.stop();
      startCalibrationBtn.disabled = false;
      startCalibrationBtn.textContent = '🎙️ 开始朗读';
    }, 6000);
  } catch (e) {
    addSystemMsg(`❌ 校准录音失败: ${e.message}`);
    startCalibrationBtn.disabled = false;
    startCalibrationBtn.textContent = '🎙️ 开始朗读';
  }
}

// ─── UI 辅助函数 ──────────────────────────────────────────────────────────────

function addMsg(type, sender, content, audioUrl, extraClass) {
  const div = document.createElement('div');
  div.className = `msg ${type} ${extraClass || ''}`;

  const senderEl = document.createElement('div');
  senderEl.className = 'sender';
  senderEl.textContent = sender;
  div.appendChild(senderEl);

  const textEl = document.createElement('div');
  textEl.textContent = content;
  div.appendChild(textEl);

  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = new Date().toLocaleTimeString();
  div.appendChild(timeEl);

  if (audioUrl) {
    const playBtn = document.createElement('button');
    playBtn.className = 'audio-play';
    playBtn.innerHTML = '🔊 播放';
    playBtn.onclick = () => {
      const audio = new Audio(audioUrl);
      audio.play();
      playBtn.classList.add('playing');
      playBtn.innerHTML = '🔊 播放中...';
      audio.onended = () => {
        playBtn.classList.remove('playing');
        playBtn.innerHTML = '🔊 播放';
      };
    };
    div.appendChild(playBtn);
  }

  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.style.cssText = 'max-width:90%;';
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = '💬 系统';
  div.appendChild(sender);
  const el = document.createElement('div');
  el.textContent = text;
  el.style.fontSize = '13px';
  div.appendChild(el);
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function setStatus(type, text) {
  statusDot.className = 'dot ' + type;
  statusText.textContent = text;
  infoText.textContent = text;
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────
init();
