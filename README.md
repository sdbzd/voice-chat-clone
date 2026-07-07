# 🎤 语音克隆对话 — Voice Chat Clone

网页语音对话 + 声音克隆。对着麦克风说话，AI 用你的克隆音色回答。

## 架构

```
浏览器 ──→ Cloudflare Worker ──→ Groq (Whisper ASR + LLM)
          → Fish Audio (声音克隆 + TTS)
```

### 服务依赖

| 服务 | 用途 | 免费额度 |
|------|------|----------|
| [Groq](https://groq.com) | 语音识别 (Whisper) + LLM 对话 | 1h 音频/天 + 30 req/min |
| [Fish Audio](https://fish.audio) | 声音克隆 + 文本转语音 | 100 分钟/月 |
| [Cloudflare Workers](https://workers.cloudflare.com) | API 后端 | 10 万请求/天 |

## 部署准备

### 1. 获取 API Key

**Groq** (免费):
1. 访问 [console.groq.com/keys](https://console.groq.com/keys)
2. 创建 API Key
3. 保存为 `GROQ_API_KEY`

**Fish Audio** (免费):
1. 访问 [fish.audio](https://fish.audio) → 注册 → Developer
2. 创建 API Key
3. 保存为 `FISH_API_KEY`

### 2. 配置 Cloudflare Secrets

```bash
# 安装 wrangler
npm install -g wrangler

# 登录
wrangler login

# 注入 secrets
cd worker
echo "gsk_your_groq_key" | wrangler secret put GROQ_API_KEY
echo "your_fish_key" | wrangler secret put FISH_API_KEY
```

### 3. 部署

```bash
# 部署 Worker
cd worker
wrangler deploy

# 部署前端到 Pages
wrangler pages deploy ../frontend --project-name=voice-chat-clone
```

### 4. GitHub Actions (CI/CD)

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|--------|------|
| `CF_API_TOKEN` | Cloudflare API Token (权限: Workers + Pages) |
| `GROQ_API_KEY` | Groq API Key |
| `FISH_API_KEY` | Fish Audio API Key |

推送 `main` 分支自动部署。

## 使用

1. 打开部署后的 URL（或本地直接打开 `frontend/index.html`）
2. 点击 🎤 按钮开始说话
3. 首次说话会自动克隆你的声音
4. 如果克隆效果差，会提示你读校准文本重新克隆
5. 后续对话用你的克隆音色回答

## 本地开发

```bash
# 启动 Worker 开发服务器
cd worker
wrangler dev

# 直接打开前端（无需服务器）
# 前端的 API_BASE 指向部署后的 Worker URL
```

## 项目结构

```
sdbzd/voice-chat-clone/
├── frontend/           # 前端 (Cloudflare Pages)
│   ├── index.html      # 主页面
│   └── app.js          # 应用逻辑
├── worker/             # Cloudflare Worker
│   ├── src/
│   │   └── index.js    # API 后端
│   └── wrangler.toml   # Worker 配置
├── .github/workflows/
│   └── deploy.yml      # CI/CD
└── README.md
```
