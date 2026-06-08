const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_PROJECTS_DIR = path.join(ROOT, "projects");
const LOCAL_DIR = path.join(DEFAULT_PROJECTS_DIR, ".local");
const SETTINGS_FILE = path.join(LOCAL_DIR, "settings.json");
const PROMPT_POLICY_FILE = path.join(ROOT, "prompt_policy.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const ENABLED_PLATFORMS = new Set(["lovart", "jimeng_cli"]);
const PYTHON = process.env.PYTHON || DEFAULT_PYTHON;
const DREAMINA = process.env.DREAMINA || "dreamina";
const DREAMINA_SUBMIT_TIMEOUT_MS = 180000;
const DREAMINA_QUERY_TIMEOUT_MS = 120000;
const DIRECT_NETWORK_ENV = {
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
  NO_PROXY: "*",
  no_proxy: "*",
};
const lovartProjectLocks = new Map();
const activeJobSubmissions = new Set();
const HOMEBREW_FFMPEG = "/opt/homebrew/bin/ffmpeg";
const HOMEBREW_FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = process.env.FFMPEG || (fs.existsSync(HOMEBREW_FFMPEG) ? HOMEBREW_FFMPEG : "ffmpeg");
const FFPROBE = process.env.FFPROBE || (fs.existsSync(HOMEBREW_FFPROBE) ? HOMEBREW_FFPROBE : "ffprobe");
const XLSX_PARSER = path.join(ROOT, "scripts", "parse_shots_xlsx.py");
const DEFAULT_LOVART_SKILL =
  process.platform === "win32"
    ? path.join(os.homedir(), ".codex", "skills", "lovart-skill", "agent_skill.py")
    : path.join(os.homedir(), ".codex", "skills", "lovart-skill", "agent_skill.py");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadSettings() {
  const settings = readJson(SETTINGS_FILE, {});
  const projectRoot = process.env.AI_VIDEO_PROJECTS_DIR || settings.project_root || DEFAULT_PROJECTS_DIR;
  const deepseek = settings.deepseek || {};
  return {
    lovart_access_key: process.env.LOVART_ACCESS_KEY || settings.lovart_access_key || "",
    lovart_secret_key: process.env.LOVART_SECRET_KEY || settings.lovart_secret_key || "",
    project_root: path.resolve(projectRoot),
    lovart_skill_path: process.env.LOVART_SKILL || settings.lovart_skill_path || DEFAULT_LOVART_SKILL,
    deepseek: {
      enabled: Boolean(deepseek.enabled),
      apiKey: process.env.DEEPSEEK_API_KEY || deepseek.apiKey || "",
      baseUrl: normalizeDeepSeekBaseUrl(process.env.DEEPSEEK_BASE_URL || deepseek.baseUrl || "https://api.deepseek.com"),
      model: process.env.DEEPSEEK_MODEL || deepseek.model || "deepseek-chat",
    },
  };
}

function saveSettings(next) {
  ensureDir(LOCAL_DIR);
  const current = loadSettings();
  const currentDeepSeek = current.deepseek || {};
  const incomingDeepSeek = next.deepseek || {};
  const settings = {
    lovart_access_key: next.lovart_access_key ?? current.lovart_access_key ?? "",
    lovart_secret_key: next.lovart_secret_key ?? current.lovart_secret_key ?? "",
    project_root: path.resolve(next.project_root || current.project_root || DEFAULT_PROJECTS_DIR),
    lovart_skill_path: String(next.lovart_skill_path ?? current.lovart_skill_path ?? DEFAULT_LOVART_SKILL).trim() || DEFAULT_LOVART_SKILL,
    deepseek: {
      enabled: incomingDeepSeek.enabled == null ? Boolean(currentDeepSeek.enabled) : Boolean(incomingDeepSeek.enabled),
      apiKey: incomingDeepSeek.apiKey == null ? (currentDeepSeek.apiKey || "") : String(incomingDeepSeek.apiKey || "").trim(),
      baseUrl: normalizeDeepSeekBaseUrl(incomingDeepSeek.baseUrl ?? currentDeepSeek.baseUrl ?? "https://api.deepseek.com"),
      model: String(incomingDeepSeek.model ?? currentDeepSeek.model ?? "deepseek-chat").trim() || "deepseek-chat",
    },
  };
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

function lovartSkillPath() {
  return loadSettings().lovart_skill_path;
}

function safeName(name) {
  return String(name || "project")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "project";
}

function uniquePath(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let candidate = path.join(dir, baseName);
  let count = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${count}${ext}`);
    count += 1;
  }
  return candidate;
}

function extensionFromMime(mime = "", fallback = ".bin") {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
  };
  return map[String(mime || "").toLowerCase()] || fallback;
}

function assetKindFromFile(file, fallback = "image") {
  const ext = path.extname(String(file || "")).toLowerCase();
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".m4a", ".aac"].includes(ext)) return "audio";
  return fallback;
}

function renameFileForAsset(projectId, asset, nextName) {
  const cleanName = safeName(nextName);
  if (!cleanName || !asset.file_path || !fs.existsSync(asset.file_path)) {
    asset.name = cleanName || asset.name;
    return asset;
  }
  const ext = path.extname(asset.file_path);
  const dir = path.dirname(asset.file_path);
  const current = asset.file_path;
  const targetBase = `${cleanName}${ext}`;
  const currentBase = path.basename(current);
  const dest = currentBase === targetBase ? current : uniquePath(dir, targetBase);
  if (dest !== current) {
    fs.renameSync(current, dest);
    asset.file_path = dest;
    if (asset.thumbnail_path === current) asset.thumbnail_path = dest;
    asset.url = publicAssetUrl(projectId, dest);
  }
  asset.name = path.basename(asset.file_path, path.extname(asset.file_path));
  return asset;
}

function fileSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function imageQualityToFfmpegQscale(quality) {
  const normalized = Math.max(45, Math.min(92, Number(quality || 82)));
  return Math.max(2, Math.min(18, Math.round(22 - ((normalized - 45) / 47) * 16)));
}

async function convertImageToJpeg(source, dest, options = {}) {
  const maxEdge = Math.max(512, Math.min(4096, Number(options.maxEdge || 2048)));
  const quality = Math.max(45, Math.min(92, Number(options.quality || 82)));
  const logFile = options.logFile;
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) {
    return runCommand("/usr/bin/sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(quality),
      "-Z", String(maxEdge),
      source,
      "--out", dest,
    ], logFile, {}, { timeoutMs: options.timeoutMs || 30000 });
  }
  const scale = `scale=trunc(iw*min(1\\,${maxEdge}/max(iw\\,ih))/2)*2:trunc(ih*min(1\\,${maxEdge}/max(iw\\,ih))/2)*2`;
  return runCommand(FFMPEG, [
    "-y",
    "-i", source,
    "-vf", scale,
    "-q:v", String(imageQualityToFfmpegQscale(quality)),
    dest,
  ], logFile, {}, { timeoutMs: options.timeoutMs || 60000 });
}

async function compressImageAsset(projectId, asset, options = {}) {
  if (!asset || asset.kind !== "image") throw new Error("只能压缩图片素材。");
  if (!asset.file_path || !fs.existsSync(asset.file_path)) throw new Error("这个图片还没有本地文件，不能直接压缩。");
  const projectRoot = projectDir(projectId);
  const source = path.resolve(asset.file_path);
  if (!source.startsWith(path.resolve(projectRoot) + path.sep)) {
    throw new Error("只能压缩当前项目目录里的图片。");
  }
  const maxEdge = Math.max(512, Math.min(4096, Number(options.max_edge || 2048)));
  const quality = Math.max(45, Math.min(92, Number(options.quality || 82)));
  const targetBytes = Math.max(1, Number(options.target_mb || 20)) * 1024 * 1024;
  const dir = path.dirname(source);
  const base = safeName(path.basename(source, path.extname(source)) || asset.name || "image");
  const dest = uniquePath(dir, `${base}_compressed.jpg`);
  const logDir = path.join(projectRoot, "logs");
  ensureDir(logDir);
  const logFile = path.join(logDir, `compress_image_${Date.now()}.log`);
  const result = await convertImageToJpeg(source, dest, {
    maxEdge,
    quality,
    logFile,
    timeoutMs: 60000,
  });
  if (!result.ok || !fs.existsSync(dest)) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    throw new Error(result.error || "图片压缩失败。");
  }
  const beforeBytes = fileSizeBytes(source);
  const afterBytes = fileSizeBytes(dest);
  if (afterBytes && beforeBytes && afterBytes >= beforeBytes) {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error("压缩后没有变小，已保留原图。");
  }
  asset.original_file_path = asset.original_file_path || source;
  asset.compressed_from = source;
  asset.compressed_at = now();
  asset.file_path = dest;
  asset.thumbnail_path = dest;
  asset.url = publicAssetUrl(projectId, dest);
  asset.name = path.basename(dest, path.extname(dest));
  asset.kind = "image";
  asset.compression = {
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    target_bytes: targetBytes,
    max_edge: maxEdge,
    quality,
    under_target: afterBytes <= targetBytes,
  };
  return asset;
}

function projectDir(projectId) {
  return path.join(loadSettings().project_root, safeName(projectId));
}

function loadProject(projectId) {
  const dir = projectDir(projectId);
  const data = {
    project: readJson(path.join(dir, "project.json"), null),
    canvas: readJson(path.join(dir, "canvas.json"), { nodes: [], edges: [], assets: [] }),
    shots: readJson(path.join(dir, "shots.json"), []),
    tags: readJson(path.join(dir, "tags.json"), []),
    jobs: readJson(path.join(dir, "jobs.json"), []),
    archives: readJson(path.join(dir, "archives.json"), []),
    prompt_context: loadPromptContext(projectId),
    script: loadScript(projectId),
    asset_library: readJson(path.join(dir, "asset_library.json"), { global_rules: "", templates: [], image_model: "agent-auto" }),
  };
  migrateLovartMeta(projectId, data);
  repairAssetKindsFromFiles(projectId, data);
  reconcileDownloadedJobAssets(projectId, data);
  return data;
}

function saveProjectPart(projectId, fileName, value) {
  const dir = projectDir(projectId);
  ensureDir(dir);
  writeJson(path.join(dir, fileName), value);
}

function mergeCanvasForSave(projectId, incomingCanvas = {}) {
  const current = readJson(path.join(projectDir(projectId), "canvas.json"), { nodes: [], edges: [], assets: [] });
  const next = {
    nodes: Array.isArray(incomingCanvas.nodes) ? incomingCanvas.nodes : [],
    edges: Array.isArray(incomingCanvas.edges) ? incomingCanvas.edges : [],
    assets: Array.isArray(incomingCanvas.assets) ? incomingCanvas.assets : [],
  };
  const nextAssetIds = new Set(next.assets.map((asset) => asset.asset_id).filter(Boolean));
  const preservedAssets = (current.assets || []).filter((asset) => {
    if (!asset.asset_id || nextAssetIds.has(asset.asset_id)) return false;
    return asset.source === "generated" || asset.source_job_id || asset.asset_template_id;
  });
  next.assets.push(...preservedAssets);

  const nextNodeIds = new Set(next.nodes.map((node) => node.id).filter(Boolean));
  const preservedAssetIds = new Set(preservedAssets.map((asset) => asset.asset_id).filter(Boolean));
  const preservedNodes = (current.nodes || []).filter((node) => {
    if (!node.id || nextNodeIds.has(node.id)) return false;
    return node.data?.source_job_id || preservedAssetIds.has(node.data?.asset_id);
  });
  next.nodes.push(...preservedNodes);
  preservedNodes.forEach((node) => nextNodeIds.add(node.id));
  const preservedNodeIds = new Set(preservedNodes.map((node) => node.id).filter(Boolean));

  const edgeKey = (edge) => `${edge.source || ""}->${edge.target || ""}`;
  const nextEdgeKeys = new Set(next.edges.map(edgeKey));
  for (const edge of current.edges || []) {
    if (!edge.source || !edge.target) continue;
    if (!nextNodeIds.has(edge.source) || !nextNodeIds.has(edge.target)) continue;
    if (!preservedNodeIds.has(edge.source) && !preservedNodeIds.has(edge.target)) continue;
    const key = edgeKey(edge);
    if (nextEdgeKeys.has(key)) continue;
    next.edges.push(edge);
    nextEdgeKeys.add(key);
  }
  return next;
}

function saveProjectMeta(projectId, patch) {
  const dir = projectDir(projectId);
  const project = readJson(path.join(dir, "project.json"), {});
  const next = { ...project, ...patch, updated_at: now() };
  writeJson(path.join(dir, "project.json"), next);
  return next;
}

function setQueuePaused(projectId, paused) {
  const isPaused = Boolean(paused);
  return saveProjectMeta(projectId, {
    queue_paused: isPaused,
    queue_paused_at: isPaused ? now() : "",
  });
}

function parseLovartMetaFromLog(projectId, jobId) {
  const file = path.join(projectDir(projectId), "logs", `${jobId}.log`);
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  return {
    lovart_project_id: text.match(/"project_id":\s*"([^"]+)"/)?.[1] || "",
    lovart_thread_id: text.match(/"thread_id":\s*"([^"]+)"/)?.[1] || "",
  };
}

function migrateLovartMeta(projectId, data) {
  if (!data.project) return;
  let projectChanged = false;
  let jobsChanged = false;
  for (const job of data.jobs || []) {
    if (job.platform === "jimeng_cli" && (job.rate_limit_handled || /已在 Lovart 平台处理|并发限制已在 Lovart 平台处理|并发限制已标记为处理完成/.test(String(job.failure_reason || "")))) {
      job.status = "rate_limited";
      job.rate_limit_handled = false;
      job.failure_reason = "即梦当前还有任务在生成，平台限制了并发。等上一条完成后再提交。";
      jobsChanged = true;
      continue;
    }
    if (job.rate_limit_handled || /已在 Lovart 平台处理|并发限制已在 Lovart 平台处理/.test(String(job.failure_reason || ""))) {
      if (job.status === "rate_limited") {
        job.status = "failed";
        jobsChanged = true;
      }
      if (!job.rate_limit_handled) {
        job.rate_limit_handled = true;
        jobsChanged = true;
      }
      if (/已在 Lovart 平台处理|并发限制已在 Lovart 平台处理/.test(String(job.failure_reason || ""))) {
        job.failure_reason = rateLimitHandledReason(job);
        jobsChanged = true;
      }
    }
    if (!job.rate_limit_handled && job.status === "failed" && isConcurrentLimit(job.failure_reason)) {
      job.status = "rate_limited";
      jobsChanged = true;
    }
    if (job.platform === "lovart" && job.lovart_thread_id && job.status === "failed" && isLovartInteractionPrompt(job.failure_reason)) {
      job.status = "needs_input";
      jobsChanged = true;
    }
    if (job.status === "pending_confirmation" && /已确认，Lovart 正在继续生成/.test(String(job.failure_reason || ""))) {
      job.status = "running";
      jobsChanged = true;
    }
    if (
      job.status === "running"
      && !job.lovart_thread_id
      && !job.jimeng_submit_id
      && !activeJobSubmissions.has(job.job_id)
      && Date.now() - new Date(job.updated_at || job.created_at || 0).getTime() > 10 * 60 * 1000
    ) {
      job.status = "failed";
      job.failure_reason = "本地提交中断：没有拿到平台会话 ID，无法继续查询结果。请重新提交。";
      job.updated_at = now();
      updateAssetLibraryAfterJob(projectId, job, { status: "failed", failure_reason: job.failure_reason });
      jobsChanged = true;
      continue;
    }
    if (job.lovart_project_id && job.lovart_thread_id) continue;
    const meta = parseLovartMetaFromLog(projectId, job.job_id);
    if (meta.lovart_project_id && !job.lovart_project_id) {
      job.lovart_project_id = meta.lovart_project_id;
      jobsChanged = true;
    }
    if (meta.lovart_thread_id && !job.lovart_thread_id) {
      job.lovart_thread_id = meta.lovart_thread_id;
      jobsChanged = true;
    }
  }
  const existingLovartProject = data.jobs.find((job) => job.lovart_project_id)?.lovart_project_id;
  if (existingLovartProject && !data.project.lovart_project_id) {
    data.project.lovart_project_id = existingLovartProject;
    projectChanged = true;
  }
  if (projectChanged) writeJson(path.join(projectDir(projectId), "project.json"), data.project);
  if (jobsChanged) writeJson(path.join(projectDir(projectId), "jobs.json"), data.jobs);
}

function repairAssetKindsFromFiles(projectId, data) {
  if (!data?.canvas) return false;
  data.canvas.assets = Array.isArray(data.canvas.assets) ? data.canvas.assets : [];
  data.canvas.nodes = Array.isArray(data.canvas.nodes) ? data.canvas.nodes : [];
  let changed = false;
  const assetKindById = new Map();
  for (const asset of data.canvas.assets) {
    if (!asset.file_path && !asset.url) continue;
    const nextKind = assetKindFromFile(asset.file_path || asset.url, asset.kind || "image");
    if (nextKind && asset.kind !== nextKind) {
      asset.kind = nextKind;
      if (nextKind === "image") asset.thumbnail_path = asset.file_path || asset.thumbnail_path;
      if (nextKind !== "image" && asset.thumbnail_path === asset.file_path) asset.thumbnail_path = undefined;
      changed = true;
    }
    if (asset.asset_id) assetKindById.set(asset.asset_id, asset.kind);
  }
  for (const node of data.canvas.nodes) {
    const assetKind = assetKindById.get(node.data?.asset_id);
    if (assetKind && ["image", "video", "audio"].includes(node.type) && node.type !== assetKind) {
      node.type = assetKind;
      changed = true;
    }
  }
  if (changed) saveProjectPart(projectId, "canvas.json", data.canvas);
  return changed;
}

function defaultPromptPolicy() {
  return {
    version: "2026-05-19-v1",
    summary: "AI 视频无限画布提示词优化工具级规则快照。v1 只做文本优化建议，不看图、不看视频、不自动提交生成。",
    rules: [
      "优化功能只改写文本建议，不直接提交 Lovart 或即梦任务。",
      "优化结果必须先展示差异，用户确认后才写回当前分镜或节点。",
      "Seedance 提示词必须保留 @ 资产锚点。",
      "Kling 视频提示词不要直接使用 @ 资产锚点，需要改写成自然语言。",
      "Lovart 角色资产提交时必须保留 URL 参考规则。",
      "即梦单图、多图提交继续使用本地已导入资产。",
      "角色资产强调稳定身份特征，不写动作变体。",
      "场景和道具资产保持无人称、无角色召唤。",
      "spoken lines 默认使用口语英文，除非用户明确要求其他语言。",
    ],
    response_contract: {
      required_json_fields: ["revised_image_prompt", "revised_video_prompt", "change_summary", "project_learning_suggestions", "warnings"],
    },
  };
}

function loadPromptPolicy() {
  return readJson(PROMPT_POLICY_FILE, defaultPromptPolicy());
}

function defaultPromptContext(policyVersion = loadPromptPolicy().version) {
  return {
    policy_version: policyVersion,
    project_context: {
      style: "",
      asset_summary: "",
      model_preferences: "",
      overrides: [],
    },
    learnings: [],
    feedback_presets: defaultPromptFeedbackPresets(),
    revisions: [],
    updated_at: now(),
  };
}

function defaultPromptFeedbackPresets() {
  return [
    "人物不像",
    "动作太多",
    "镜头不稳",
    "不要新增人物",
    "更电影感",
    "保留 @ 标签",
    "减少肢体变形",
    "保持上一镜连续性",
  ];
}

function sanitizeStringArray(value, limit = 50) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit)
    : [];
}

function sanitizePromptContext(raw = {}) {
  const fallback = defaultPromptContext(raw.policy_version || loadPromptPolicy().version);
  const projectContext = raw.project_context && typeof raw.project_context === "object" ? raw.project_context : {};
  return {
    policy_version: String(raw.policy_version || fallback.policy_version || "").trim(),
    project_context: {
      style: String(projectContext.style || "").trim(),
      asset_summary: String(projectContext.asset_summary || "").trim(),
      model_preferences: String(projectContext.model_preferences || "").trim(),
      overrides: sanitizeStringArray(projectContext.overrides, 30),
    },
    learnings: sanitizeStringArray(raw.learnings, 100),
    feedback_presets: raw.feedback_presets == null
      ? fallback.feedback_presets
      : sanitizeStringArray(raw.feedback_presets, 30),
    revisions: Array.isArray(raw.revisions)
      ? raw.revisions.slice(-80).map((item) => ({
          revision_id: String(item.revision_id || id("promptrev")),
          created_at: String(item.created_at || now()),
          shot_id: String(item.shot_id || ""),
          node_id: String(item.node_id || ""),
          feedback: String(item.feedback || ""),
          original_image_prompt: String(item.original_image_prompt || ""),
          revised_image_prompt: String(item.revised_image_prompt || ""),
          original_video_prompt: String(item.original_video_prompt || ""),
          revised_video_prompt: String(item.revised_video_prompt || ""),
          change_summary: String(item.change_summary || ""),
          warnings: sanitizeStringArray(item.warnings, 20),
          applied_fields: sanitizeStringArray(item.applied_fields, 5),
          target_label: String(item.target_label || ""),
          script_segment_title: String(item.script_segment_title || ""),
          script_segment_text: String(item.script_segment_text || ""),
        }))
      : [],
    updated_at: String(raw.updated_at || now()),
  };
}

function loadPromptContext(projectId) {
  const file = path.join(projectDir(projectId), "prompt_context.json");
  return sanitizePromptContext(readJson(file, defaultPromptContext()));
}

function savePromptContext(projectId, context) {
  const next = sanitizePromptContext({ ...context, updated_at: now() });
  saveProjectPart(projectId, "prompt_context.json", next);
  return next;
}

function defaultScript() {
  return {
    source_text: "",
    segments: [],
    bindings: [],
    updated_at: now(),
  };
}

function sanitizeScript(raw = {}) {
  return {
    source_text: String(raw.source_text || ""),
    segments: Array.isArray(raw.segments)
      ? raw.segments.slice(-500).map((segment) => ({
          segment_id: String(segment.segment_id || id("scriptseg")),
          title: String(segment.title || "").trim(),
          text: String(segment.text || "").trim(),
          created_at: String(segment.created_at || now()),
          updated_at: String(segment.updated_at || segment.created_at || now()),
        })).filter((segment) => segment.text)
      : [],
    bindings: Array.isArray(raw.bindings)
      ? raw.bindings.map((binding) => ({
          shot_id: String(binding.shot_id || "").trim(),
          segment_id: String(binding.segment_id || "").trim(),
          updated_at: String(binding.updated_at || now()),
        })).filter((binding) => binding.shot_id && binding.segment_id)
      : [],
    updated_at: String(raw.updated_at || now()),
  };
}

function loadScript(projectId) {
  const file = path.join(projectDir(projectId), "script.json");
  return sanitizeScript(readJson(file, defaultScript()));
}

function saveScript(projectId, script) {
  const next = sanitizeScript({ ...script, updated_at: now() });
  saveProjectPart(projectId, "script.json", next);
  return next;
}

function createProject(name) {
  ensureDir(loadSettings().project_root);
  const projectId = safeName(name || "AI视频项目");
  const dir = projectDir(projectId);
  ensureDir(dir);
  for (const child of ["input", "images", "videos", "thumbnails", "logs"]) {
    ensureDir(path.join(dir, child));
  }

  const project = {
    project_id: projectId,
    name: projectId,
    version: 1,
    created_at: now(),
    updated_at: now(),
  };

  if (!fs.existsSync(path.join(dir, "project.json"))) writeJson(path.join(dir, "project.json"), project);
  if (!fs.existsSync(path.join(dir, "canvas.json"))) writeJson(path.join(dir, "canvas.json"), { nodes: [], edges: [], assets: [] });
  if (!fs.existsSync(path.join(dir, "shots.json"))) writeJson(path.join(dir, "shots.json"), []);
  if (!fs.existsSync(path.join(dir, "tags.json"))) writeJson(path.join(dir, "tags.json"), []);
  if (!fs.existsSync(path.join(dir, "jobs.json"))) writeJson(path.join(dir, "jobs.json"), []);
  if (!fs.existsSync(path.join(dir, "archives.json"))) writeJson(path.join(dir, "archives.json"), []);
  if (!fs.existsSync(path.join(dir, "prompt_context.json"))) writeJson(path.join(dir, "prompt_context.json"), defaultPromptContext());
  if (!fs.existsSync(path.join(dir, "script.json"))) writeJson(path.join(dir, "script.json"), defaultScript());
  if (!fs.existsSync(path.join(dir, "asset_library.json"))) writeJson(path.join(dir, "asset_library.json"), defaultAssetLibrary());
  return loadProject(projectId);
}

function listProjects() {
  const root = loadSettings().project_root;
  ensureDir(root);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".local")
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const projectFile = path.join(dir, "project.json");
      if (!fs.existsSync(projectFile)) return null;
      const project = readJson(projectFile, { project_id: entry.name, name: entry.name, updated_at: "" });
      const stat = fs.statSync(projectFile);
      return {
        project_id: project.project_id || entry.name,
        name: project.name || project.project_id || entry.name,
        updated_at: project.updated_at || stat.mtime.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return { project_root: root, projects: entries };
}

function uniqueProjectId(baseName) {
  const root = loadSettings().project_root;
  ensureDir(root);
  const base = safeName(baseName || "复用项目");
  let candidate = base;
  let count = 2;
  while (fs.existsSync(path.join(root, candidate, "project.json"))) {
    candidate = `${base}_${count}`;
    count += 1;
  }
  return candidate;
}

function resolveProjectFile(projectId, filePath = "") {
  if (!filePath) return "";
  const root = path.resolve(projectDir(projectId));
  const abs = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
  if (!abs.startsWith(root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return "";
  return abs;
}

function assetPortableFile(projectId, asset = {}) {
  return resolveProjectFile(projectId, asset.file_path)
    || resolveProjectFile(projectId, asset.thumbnail_path);
}

function exportProjectReusePackage(projectId) {
  const data = loadProject(projectId);
  const boundAssetIds = new Set((data.tags || []).flatMap((tag) => tag.bound_asset_ids || []));
  const reusableAssets = (data.canvas.assets || []).filter((asset) => (
    boundAssetIds.has(asset.asset_id)
    || asset.is_library_asset
    || ["character", "scene", "prop"].includes(String(asset.asset_category || ""))
  ));
  const reusableAssetIds = new Set(reusableAssets.map((asset) => asset.asset_id).filter(Boolean));
  const tags = (data.tags || []).map((tag) => ({
    ...tag,
    bound_asset_ids: (tag.bound_asset_ids || []).filter((assetId) => reusableAssetIds.has(assetId)),
  }));
  const files = [];
  const missing_files = [];
  const assets = reusableAssets.map((asset) => {
    const file = assetPortableFile(projectId, asset);
    const fileName = file ? path.basename(file) : "";
    if (file) {
      files.push({
        asset_id: asset.asset_id,
        file_name: fileName,
        kind: asset.kind || assetKindFromFile(file),
        mime: MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        base64: fs.readFileSync(file).toString("base64"),
      });
    } else {
      missing_files.push(asset.name || asset.asset_id);
    }
    const { url, file_path, thumbnail_path, ...rest } = asset;
    return {
      ...rest,
      package_file_name: fileName,
      original_file_name: fileName,
    };
  });
  const global_controls = (data.canvas.nodes || [])
    .filter((node) => node.type === "globalControl")
    .map((node) => ({
      type: "globalControl",
      data: {
        title: node.data?.title || "全局控制",
        text: node.data?.text || "",
      },
    }));
  return {
    package_type: "ai_video_reuse_pack",
    version: 1,
    exported_at: now(),
    source_project: {
      project_id: data.project?.project_id || projectId,
      name: data.project?.name || projectId,
    },
    tags,
    assets,
    files,
    global_controls,
    asset_library: data.asset_library || defaultAssetLibrary(),
    missing_files,
  };
}

function importProjectReusePackage(pack = {}, projectName = "") {
  if (pack.package_type !== "ai_video_reuse_pack") {
    throw new Error("这不是 AI 视频项目复用包。");
  }
  const baseName = projectName || `${pack.source_project?.name || "复用项目"}_复用`;
  const projectId = uniqueProjectId(baseName);
  createProject(projectId);
  const dir = projectDir(projectId);
  const inputDir = path.join(dir, "input");
  ensureDir(inputDir);
  const fileByAssetId = new Map((pack.files || []).map((file) => [file.asset_id, file]));
  const assets = (pack.assets || []).map((asset) => {
    const file = fileByAssetId.get(asset.asset_id);
    let filePath = "";
    if (file?.base64) {
      const safeFileName = safeName(file.file_name || asset.package_file_name || asset.name || asset.asset_id);
      const ext = path.extname(file.file_name || asset.package_file_name || "") || extensionFromMime(file.mime || "", ".bin");
      const base = path.extname(safeFileName) ? safeFileName : `${safeFileName}${ext}`;
      filePath = uniquePath(inputDir, base);
      fs.writeFileSync(filePath, Buffer.from(file.base64, "base64"));
    }
    const { package_file_name, original_file_name, ...rest } = asset;
    return {
      ...rest,
      source: rest.source || "input",
      file_path: filePath || undefined,
      thumbnail_path: filePath && (rest.kind || file?.kind) === "image" ? filePath : undefined,
      url: filePath ? publicAssetUrl(projectId, filePath) : rest.external_url || "",
    };
  });
  const canvas = {
    nodes: (pack.global_controls || []).map((node, index) => ({
      id: id("node"),
      type: "globalControl",
      x: 80,
      y: 80 + index * 150,
      data: {
        title: node.data?.title || "全局控制",
        text: node.data?.text || "",
      },
    })),
    edges: [],
    assets,
  };
  const assetIds = new Set(assets.map((asset) => asset.asset_id).filter(Boolean));
  const tags = (pack.tags || []).map((tag) => ({
    ...tag,
    bound_asset_ids: (tag.bound_asset_ids || []).filter((assetId) => assetIds.has(assetId)),
  }));
  saveProjectPart(projectId, "canvas.json", canvas);
  saveProjectPart(projectId, "tags.json", tags);
  saveProjectPart(projectId, "jobs.json", []);
  saveProjectPart(projectId, "shots.json", []);
  saveProjectPart(projectId, "archives.json", []);
  saveProjectPart(projectId, "asset_library.json", pack.asset_library || defaultAssetLibrary());
  return loadProject(projectId);
}

function parseShots(text) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return rows.map((line) => {
    const parts = line.includes("\t") ? line.split("\t") : line.split("|");
    const shot_id = String(parts.shift() || "").trim();
    const image_prompt = String(parts.shift() || "").trim();
    const video_prompt = parts.join("|").trim();
    const prompt = [image_prompt, video_prompt].filter(Boolean).join("\n\n");
    const tag_refs = extractTags(prompt);
    return {
      shot_id,
      platform: "lovart",
      transition: image_prompt ? "new_frame" : "continue_prev_tail",
      continuous: !image_prompt,
      image_prompt,
      video_prompt,
      video_model: "",
      duration: extractDurationFromPrompt(video_prompt),
      prompt,
      tag_refs,
    };
  }).filter((shot) => shot.shot_id && (shot.image_prompt || shot.video_prompt));
}

function extractTags(text) {
  const source = String(text || "");
  const refs = new Set();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@")) continue;
    const body = trimmed.slice(1).replace(/\s+/g, " ").trim();
    if (body) refs.add(`@${body}`);
  }
  return Array.from(refs);
}

function extractDurationFromPrompt(text) {
  const source = String(text || "");
  const explicit = source.match(/\[\s*总时长\s*[：:]\s*(\d+)\s*秒\s*\]/);
  if (explicit?.[1]) return `${explicit[1]}s`;
  const compact = source.match(/(?:^|\n)\s*(\d+)\s*秒\s*[。.\s]*(?:\d+\s*:\s*\d+)?\s*[。.\s]*$/);
  return compact?.[1] ? `${compact[1]}s` : "";
}

function extractAspectRatioFromPrompt(text) {
  const match = String(text || "").match(/(?:^|\n|。|\s)(\d+\s*:\s*\d+)\s*[。.\s]*$/);
  return match?.[1] ? match[1].replace(/\s+/g, "") : "";
}

function isLovartInteractionPrompt(message) {
  return /你希望如何处理|请选择|请确认|确认此|确认.*生成|是否开始|是否|要继续|继续生成|如何处理|which option|how would you like|would you like|\?|？/i.test(String(message || ""));
}

function isKlingModelName(value) {
  return /kling/i.test(String(value || ""));
}

function isSeedanceModelName(value) {
  return /seedance/i.test(String(value || ""));
}

function normalizeSeedancePlatform(value) {
  return String(value || "").trim() === "jimeng_cli" ? "jimeng_cli" : "lovart";
}

function mapImportedVideoModel(rawModel, preferredSeedancePlatform = "lovart") {
  const raw = String(rawModel || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase().replace(/\s+/g, "");
  const seedancePlatform = normalizeSeedancePlatform(preferredSeedancePlatform);
  const seedanceMap = {
    "seedance2.0": {
      lovart: "generate_video_seedance_v2_0",
      jimeng_cli: "seedance2.0",
    },
    "seedance2.0fast": {
      lovart: "generate_video_seedance_v2_0_fast",
      jimeng_cli: "seedance2.0fast",
    },
    "seedance2.0_vip": {
      lovart: "generate_video_seedance_v2_0",
      jimeng_cli: "seedance2.0_vip",
    },
    "seedance2.0fast_vip": {
      lovart: "generate_video_seedance_v2_0_fast",
      jimeng_cli: "seedance2.0fast_vip",
    },
    "generate_video_seedance_v2_0": {
      lovart: "generate_video_seedance_v2_0",
      jimeng_cli: "seedance2.0",
    },
    "generate_video_seedance_v2_0_fast": {
      lovart: "generate_video_seedance_v2_0_fast",
      jimeng_cli: "seedance2.0fast",
    },
  };
  if (seedanceMap[lower]) return seedanceMap[lower][seedancePlatform];
  const klingMap = {
    "kling2.6": "generate_video_kling_v2_6",
    "kling26": "generate_video_kling_v2_6",
    "kling3": "generate_video_kling_v3",
    "kling3.0": "generate_video_kling_v3",
    "kling3o": "generate_video_kling_v3_omni",
    "kling3omni": "generate_video_kling_v3_omni",
    "kling3.0omni": "generate_video_kling_v3_omni",
  };
  if (klingMap[lower]) return klingMap[lower];
  return raw;
}

function normalizeShotPlatformAndModel(rawPlatform, rawModel, transition, preferredSeedancePlatform = "lovart") {
  const rawPlatformText = String(rawPlatform || "").trim();
  const hasExplicitPlatform = rawPlatformText === "jimeng_cli" || rawPlatformText === "lovart";
  const explicitPlatform = hasExplicitPlatform ? normalizeSeedancePlatform(rawPlatformText) : "";
  const resolvedSeedancePlatform = explicitPlatform || normalizeSeedancePlatform(preferredSeedancePlatform);
  const mappedModel = mapImportedVideoModel(rawModel, resolvedSeedancePlatform);
  if (isKlingModelName(mappedModel)) {
    return { platform: "lovart", video_model: mappedModel };
  }
  if (isSeedanceModelName(mappedModel)) {
    return {
      platform: resolvedSeedancePlatform,
      video_model: mappedModel,
    };
  }
  if (transition === "video_direct" && !mappedModel) {
    const platform = resolvedSeedancePlatform;
    return {
      platform,
      video_model: platform === "jimeng_cli" ? "seedance2.0fast" : "generate_video_seedance_v2_0_fast",
    };
  }
  return {
    platform: explicitPlatform || normalizePlatform(rawPlatform),
    video_model: mappedModel,
  };
}

function normalizeShot(raw, previousShotId = "", preferredSeedancePlatform = "lovart") {
  const shot_id = String(raw.shot_id || "").trim();
  const transition = raw.transition === "continue_prev_tail"
    ? "continue_prev_tail"
    : raw.transition === "video_direct"
      ? "video_direct"
      : "new_frame";
  const image_prompt = String(raw.image_prompt || "").trim();
  const video_prompt = String(raw.video_prompt || "").trim();
  const normalizedPlatformAndModel = normalizeShotPlatformAndModel(raw.platform, raw.video_model, transition, raw.seedance_platform || preferredSeedancePlatform);
  const duration = String(raw.duration || extractDurationFromPrompt(video_prompt) || "").trim();
  const size = String(raw.size || extractAspectRatioFromPrompt(video_prompt) || "").trim();
  const prompt = [image_prompt, video_prompt].filter(Boolean).join("\n\n");
  const providedTags = Array.isArray(raw.tag_refs)
    ? Array.from(new Set(raw.tag_refs.map((item) => String(item || "").trim()).filter(Boolean)))
    : null;
  return {
    shot_id,
    platform: normalizedPlatformAndModel.platform,
    transition,
    continuous: transition === "continue_prev_tail",
    image_prompt,
    video_prompt,
    video_model: normalizedPlatformAndModel.video_model,
    duration,
    size,
    prompt,
    tag_refs: providedTags || extractTags(prompt),
    expected_prev_shot_id: transition === "continue_prev_tail" ? String(raw.expected_prev_shot_id || previousShotId || "").trim() : "",
  };
}

function defaultAssetLibrary() {
  return { global_rules: "", templates: [], image_model: "agent-auto" };
}

function categoryMeta(title) {
  const clean = String(title || "").trim();
  if (clean === "角色锚点") return { category: "character", default_size: "9:16" };
  if (clean === "场景锚点") return { category: "scene", default_size: "16:9" };
  if (clean === "道具锚点") return { category: "prop", default_size: "1:1" };
  return { category: "other", default_size: "1:1" };
}

function parseAssetLibraryMarkdown(text, previousLibrary = defaultAssetLibrary()) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const globalMatch = source.match(/##\s*全片视觉规则\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  const global_rules = (globalMatch?.[1] || "").trim();
  const templates = [];
  const previousByLabel = new Map((previousLibrary.templates || []).map((item) => [item.label, item]));
  const sectionRegex = /##\s*(角色锚点|场景锚点|道具锚点|[^\n]+)\s*\n([\s\S]*?)(?=\n##\s+|$)/g;
  let sectionMatch;
  while ((sectionMatch = sectionRegex.exec(source))) {
    const meta = categoryMeta(sectionMatch[1]);
    const body = sectionMatch[2] || "";
    const itemRegex = /###\s*(@[^\n]+)\s*\n([\s\S]*?)(?=\n###\s*@|\n##\s+|$)/g;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(body))) {
      const label = String(itemMatch[1] || "").trim();
      const source_body = String(itemMatch[2] || "").trim();
      if (!label || !source_body) continue;
      const previous = previousByLabel.get(label);
      templates.push({
        template_id: previous?.template_id || id("assettpl"),
        label,
        category: previous?.category || meta.category,
        source_body,
        combined_prompt: [global_rules, source_body].filter(Boolean).join("\n\n"),
        default_size: previous?.default_size || meta.default_size,
        generated_asset_ids: previous?.generated_asset_ids || [],
        status: previous?.status || "idle",
        failure_reason: previous?.failure_reason,
      });
    }
  }
  return {
    global_rules,
    image_model: previousLibrary.image_model || "agent-auto",
    templates,
  };
}

function assetTemplateDefaultSize(category) {
  if (category === "character") return "9:16";
  if (category === "scene") return "16:9";
  return "1:1";
}

function assetNameFromFilename(filename, fallback) {
  const raw = String(filename || "").trim() || String(fallback || "").trim() || "asset";
  const base = path.basename(raw);
  const ext = path.extname(base);
  return safeName(ext ? path.basename(base, ext) : base);
}

function parseAssetLibraryJsonl(text, previousLibrary = defaultAssetLibrary()) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const previousByKey = new Map();
  for (const item of previousLibrary.templates || []) {
    const keys = [
      item.filename ? `filename:${String(item.filename).toLowerCase()}` : "",
      item.label ? `label:${String(item.label).toLowerCase()}` : "",
    ].filter(Boolean);
    keys.forEach((key) => previousByKey.set(key, item));
  }
  const templates = [];
  lines.forEach((line, index) => {
    const sourceLine = line.trim();
    if (!sourceLine) return;
    let row;
    try {
      row = JSON.parse(sourceLine);
    } catch {
      throw new Error(`资产 JSONL 第 ${index + 1} 行不是有效 JSON。`);
    }
    const filename = String(row.filename || "").trim();
    const label = assetNameFromFilename(filename, row.asset);
    const category = String(row.category || "other").trim() || "other";
    const prompt = String(row.prompt || "").trim();
    const negative = String(row.negative || "").trim();
    if (!prompt) return;
    const source_body = [prompt, negative ? `Negative prompt: ${negative}` : ""].filter(Boolean).join("\n\n");
    const previous = previousByKey.get(`filename:${filename.toLowerCase()}`) || previousByKey.get(`label:${label.toLowerCase()}`);
    templates.push({
      template_id: previous?.template_id || id("assettpl"),
      label,
      filename: filename || `${label}.png`,
      category,
      use: String(row.use || "").trim(),
      source_file: String(row.source_file || "").trim(),
      source_body,
      combined_prompt: source_body,
      default_size: previous?.default_size || assetTemplateDefaultSize(category),
      generated_asset_ids: previous?.generated_asset_ids || [],
      status: previous?.status || "idle",
      failure_reason: previous?.failure_reason,
    });
  });
  return {
    global_rules: previousLibrary.global_rules || "",
    image_model: previousLibrary.image_model || "agent-auto",
    templates,
  };
}

function buildTags(shots, previousTags) {
  const previous = new Map(previousTags.map((tag) => [tag.label, tag]));
  const refs = new Map();
  for (const shot of shots) {
    for (const tag of shot.tag_refs) {
      if (!refs.has(tag)) refs.set(tag, []);
      refs.get(tag).push(shot.shot_id);
    }
  }

  return Array.from(refs.entries()).map(([label, shotIds]) => {
    const old = previous.get(label);
    return {
      tag_id: old?.tag_id || id("tag"),
      label,
      referenced_by_shot_ids: Array.from(new Set(shotIds)),
      bound_asset_ids: old?.bound_asset_ids || [],
      aliases: Array.isArray(old?.aliases) ? old.aliases : [],
    };
  });
}

function assetKindFromMime(mime, fileName) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a"].includes(ext)) return "audio";
  return "other";
}

function assetKindFromUrl(value) {
  const text = String(value || "");
  const clean = text.split("?")[0].split("#")[0].toLowerCase();
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(clean)) return "image";
  if (/\.(mp4|mov|webm)$/.test(clean)) return "video";
  if (/\.(mp3|wav|m4a)$/.test(clean)) return "audio";
  return "image";
}

function remoteAssetUrl(asset) {
  const value = String(asset?.external_url || asset?.url || "").trim();
  return /^https?:\/\//i.test(value) ? value : "";
}

function localAssetExists(asset) {
  return Boolean(asset?.file_path && fs.existsSync(asset.file_path));
}

function comparableAssetName(value) {
  return path.basename(String(value || "").trim().replace(/^@/, ""), path.extname(String(value || "")))
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function localAssetNameCandidates(asset = {}, hint = {}) {
  const values = [
    asset.name,
    asset.asset_id,
    hint.asset_name,
    hint.source_node_title,
    hint.primary_tag_label,
    ...(hint.tag_labels || []),
  ];
  for (const value of [asset.file_path, asset.external_url, asset.url]) {
    if (value) values.push(path.basename(String(value).split("?")[0].split("#")[0]));
  }
  return Array.from(new Set(values.map(comparableAssetName).filter(Boolean)));
}

function findExistingLocalAssetFile(projectId, asset = {}, hint = {}) {
  const candidates = new Set(localAssetNameCandidates(asset, hint));
  if (!candidates.size) return "";
  const dirs = [
    path.join(projectDir(projectId), "images"),
    path.join(projectDir(projectId), "input"),
    path.join(projectDir(projectId), "videos"),
  ];
  const allowed = asset.kind === "video"
    ? [".mp4", ".mov", ".webm"]
    : asset.kind === "audio"
      ? [".mp3", ".wav", ".m4a", ".aac"]
      : [".png", ".jpg", ".jpeg", ".webp", ".gif"];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!allowed.includes(ext)) continue;
      const stem = comparableAssetName(name);
      if (candidates.has(stem)) return path.join(dir, name);
    }
  }
  return "";
}

function downloadRemoteFile(fileUrl, destWithoutExt) {
  return new Promise((resolve, reject) => {
    let urlObject;
    try {
      urlObject = new URL(fileUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const urlExt = path.extname(urlObject.pathname || "");
    const finalPath = uniquePath(path.dirname(destWithoutExt), `${path.basename(destWithoutExt)}${urlExt || ".bin"}`);
    const child = spawn("curl", [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "15",
      "--max-time",
      "120",
      "--output",
      finalPath,
      fileUrl,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      try { fs.unlinkSync(finalPath); } catch {}
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ filePath: finalPath, contentType: "" });
        return;
      }
      try { fs.unlinkSync(finalPath); } catch {}
      reject(new Error(stderr.trim() || `curl 下载失败，退出码 ${code}`));
    });
  });
}

async function ensureJimengLocalAsset(projectId, asset, hint = {}) {
  if (localAssetExists(asset)) return asset.file_path;
  const existingFile = findExistingLocalAssetFile(projectId, asset, hint);
  if (existingFile) {
    asset.file_path = existingFile;
    if (!asset.thumbnail_path && asset.kind === "image") asset.thumbnail_path = existingFile;
    return existingFile;
  }
  return "";
}

async function stageJimengUploadFile(projectId, job, sourcePath, index, kind, logFile) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return "";
  const projectKey = crypto
    .createHash("sha1")
    .update(String(projectId || "project"))
    .digest("hex")
    .slice(0, 12);
  const jobKey = String(job?.job_id || job?.id || "job").replace(/[^a-zA-Z0-9_-]/g, "_");
  const ext = path.extname(sourcePath).toLowerCase() || ".bin";
  const safeKind = String(kind || "asset").replace(/[^a-zA-Z0-9_-]/g, "_") || "asset";
  const destDir = path.join(os.tmpdir(), "ai-video-jimeng-uploads", projectKey, jobKey);
  ensureDir(destDir);
  const shouldOptimizeImage = safeKind === "image" && /\.(png|jpe?g|webp)$/i.test(ext);
  const destPath = path.join(destDir, `${safeKind}_${String(index + 1).padStart(2, "0")}${shouldOptimizeImage ? ".jpg" : ext}`);
  if (shouldOptimizeImage) {
    const result = await convertImageToJpeg(sourcePath, destPath, {
      maxEdge: 2048,
      quality: 86,
      logFile,
      timeoutMs: 60000,
    });
    if (result.ok && fs.existsSync(destPath)) return destPath;
  }
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
}

async function ensureLocalAssetFile(projectId, asset) {
  if (localAssetExists(asset)) return asset.file_path;
  const fileUrl = remoteAssetUrl(asset);
  if (!fileUrl) return "";
  const cacheDir = path.join(projectDir(projectId), "input");
  ensureDir(cacheDir);
  const baseName = safeName(asset.name || asset.asset_id || "remote_asset");
  const { filePath } = await downloadRemoteFile(fileUrl, path.join(cacheDir, baseName));
  asset.file_path = filePath;
  if (!asset.thumbnail_path && asset.kind === "image") asset.thumbnail_path = filePath;
  return filePath;
}

async function extractVideoTailFrame(projectId, asset, dest, logFile) {
  const filePath = await ensureLocalAssetFile(projectId, asset);
  if (!filePath) throw new Error("这个视频还没有可用的本地文件。");
  const args = [
    "-y",
    "-sseof", "-0.10",
    "-i", filePath,
    "-frames:v", "1",
    "-q:v", "2",
    dest,
  ];
  const result = await runCommand(FFMPEG, args, logFile, {}, { timeoutMs: 30000 });
  if (!result.ok || !fs.existsSync(dest)) {
    throw new Error("尾帧提取失败。");
  }
}

function assetNameFromUrl(value) {
  const text = String(value || "");
  const clean = text.split("?")[0].split("#")[0];
  const base = path.basename(clean || "remote_asset");
  const stem = path.basename(base, path.extname(base));
  return safeName(stem || "remote_asset");
}

function publicAssetUrl(projectId, filePath) {
  const rel = path.relative(projectDir(projectId), filePath).split(path.sep).join("/");
  return `/project-files/${encodeURIComponent(projectId)}/${rel}`;
}

function lovartEnv() {
  const settings = loadSettings();
  return {
    LOVART_ACCESS_KEY: settings.lovart_access_key,
    LOVART_SECRET_KEY: settings.lovart_secret_key,
    OPENCLAW_ACCESS_KEY: settings.lovart_access_key,
    OPENCLAW_SECRET_KEY: settings.lovart_secret_key,
  };
}

function parseJsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("empty output");
  return JSON.parse(text);
}

function normalizeDeepSeekBaseUrl(value) {
  let text = String(value || "").trim() || "https://api.deepseek.com";
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/^http:\/\//i, "https://");
  return text.replace(/\/+$/, "") || "https://api.deepseek.com";
}

function isHtmlResponse(text) {
  return /<\s*html[\s>]|<\s*body[\s>]|<\s*h1[\s>]/i.test(String(text || ""));
}

function plainErrorText(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function deepSeekHttpErrorMessage(statusCode, data, headers = {}) {
  const raw = String(data?.raw || "");
  const location = String(headers.location || "");
  if ([301, 302, 307, 308].includes(statusCode)) {
    const target = location ? `（跳转到 ${location}）` : "";
    return `DeepSeek 地址发生跳转${target}。请把 Base URL 改为 https://api.deepseek.com 后重试。`;
  }
  if (isHtmlResponse(raw)) {
    const text = plainErrorText(raw);
    return text
      ? `DeepSeek 返回了网页错误页：${text}。请检查 Base URL 是否为 https://api.deepseek.com。`
      : "DeepSeek 返回了网页错误页。请检查 Base URL 是否为 https://api.deepseek.com。";
  }
  return data?.error?.message || data?.message || raw || `请求失败，状态码 ${statusCode}`;
}

function postJson(urlValue, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlValue);
    } catch (error) {
      reject(error);
      return;
    }
    const body = JSON.stringify(payload);
    const requestImpl = target.protocol === "http:" ? http : https;
    const req = requestImpl.request({
      method: "POST",
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
          return;
        }
        const message = deepSeekHttpErrorMessage(res.statusCode, data, res.headers);
        reject(new Error(message));
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("优化请求超时，可以稍后重试。"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("模型没有返回内容。");
  try {
    return JSON.parse(source);
  } catch {}
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(source.slice(start, end + 1));
  }
  throw new Error("模型返回格式异常，可以重试或手动修改。");
}

function appendMissingPromptTags(prompt, requiredTags = []) {
  const text = String(prompt || "").trim();
  const existing = new Set(extractTags(text));
  const missing = requiredTags.filter((tag) => tag && !existing.has(tag));
  if (!missing.length) return { prompt: text, missing };
  return {
    prompt: [missing.join(" "), text].filter(Boolean).join("\n"),
    missing,
  };
}

function shouldPreservePromptTags(context = {}) {
  return !isKlingModelName(context.model || context.video_model || "");
}

function normalizePromptOptimization(raw, original = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const warnings = sanitizeStringArray(value.warnings, 10);
  let revisedImagePrompt = String(value.revised_image_prompt ?? original.image_prompt ?? "");
  let revisedVideoPrompt = String(value.revised_video_prompt ?? original.video_prompt ?? "");
  if (shouldPreservePromptTags(original)) {
    const imageTags = extractTags(original.image_prompt || "");
    const videoTags = extractTags(original.video_prompt || "");
    const imageResult = appendMissingPromptTags(revisedImagePrompt, imageTags);
    const videoResult = appendMissingPromptTags(revisedVideoPrompt, videoTags);
    revisedImagePrompt = imageResult.prompt;
    revisedVideoPrompt = videoResult.prompt;
    const recovered = Array.from(new Set([...imageResult.missing, ...videoResult.missing]));
    if (recovered.length) {
      warnings.push(`模型漏掉了原提示词标签，系统已自动补回：${recovered.join("、")}。`);
    }
  }
  return {
    revised_image_prompt: revisedImagePrompt,
    revised_video_prompt: revisedVideoPrompt,
    change_summary: String(value.change_summary || "已根据反馈整理提示词。"),
    project_learning_suggestions: sanitizeStringArray(value.project_learning_suggestions, 10),
    warnings: sanitizeStringArray(warnings, 10),
  };
}

function deepSeekChatUrl(baseUrl) {
  const clean = String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
}

function compactContextForPrompt(context = {}) {
  return {
    policy_version: context.policy_version || "",
    project_context: context.project_context || {},
    learnings: (context.learnings || []).slice(-12),
    recent_revisions: (context.revisions || []).slice(-5).map((item) => ({
      shot_id: item.shot_id,
      feedback: item.feedback,
      change_summary: item.change_summary,
      warnings: item.warnings || [],
      applied_fields: item.applied_fields || [],
    })),
  };
}

async function optimizePromptWithDeepSeek(projectId, requestBody = {}) {
  const settings = loadSettings().deepseek || {};
  if (!settings.enabled || !settings.apiKey) {
    throw new Error("需要先配置 DeepSeek Key，再使用提示词优化。");
  }
  const policy = loadPromptPolicy();
  const context = loadPromptContext(projectId);
  const original = {
    image_prompt: String(requestBody.image_prompt || requestBody.shot?.image_prompt || ""),
    video_prompt: String(requestBody.video_prompt || requestBody.shot?.video_prompt || ""),
    model: String(requestBody.model || requestBody.video_model || requestBody.shot?.video_model || ""),
    platform: String(requestBody.platform || requestBody.shot?.platform || ""),
  };
  const payload = {
    task: "Optimize the selected AI video shot prompts. Return JSON only.",
    user_feedback: String(requestBody.user_feedback || "").trim(),
    policy,
    project_context: compactContextForPrompt(context),
    script_segment: requestBody.script_segment && typeof requestBody.script_segment === "object"
      ? {
          segment_id: String(requestBody.script_segment.segment_id || ""),
          title: String(requestBody.script_segment.title || ""),
          text: String(requestBody.script_segment.text || ""),
        }
      : null,
    shot: {
      shot_id: String(requestBody.shot_id || requestBody.shot?.shot_id || ""),
      transition: String(requestBody.transition || requestBody.shot?.transition || ""),
      platform: String(requestBody.platform || requestBody.shot?.platform || ""),
      model: String(requestBody.model || requestBody.video_model || requestBody.shot?.video_model || ""),
      mode: String(requestBody.mode || ""),
      duration: String(requestBody.duration || requestBody.shot?.duration || ""),
      size: String(requestBody.size || requestBody.shot?.size || ""),
      image_prompt: original.image_prompt,
      video_prompt: original.video_prompt,
      tag_refs: Array.isArray(requestBody.tag_refs) ? requestBody.tag_refs : (requestBody.shot?.tag_refs || []),
      bound_assets: Array.isArray(requestBody.bound_assets) ? requestBody.bound_assets : [],
    },
  };
  const response = await postJson(deepSeekChatUrl(settings.baseUrl), {
    model: settings.model || "deepseek-chat",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a concise AI film prompt optimizer for a local AI video canvas.",
          "Only rewrite text prompts. Do not suggest submitting generation jobs.",
          "Preserve model-specific anchor rules from the policy.",
          "If script_segment is provided, preserve its story intent while improving visual prompt clarity.",
          "Return valid JSON only with these fields: revised_image_prompt, revised_video_prompt, change_summary, project_learning_suggestions, warnings.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  }, {
    Authorization: `Bearer ${settings.apiKey}`,
  });
  const content = response?.choices?.[0]?.message?.content || "";
  return normalizePromptOptimization(extractJsonObject(content), original);
}

function isConcurrentLimit(message) {
  return /Concurrent task limit|ExceedConcurrencyLimit|ConcurrencyLimit|并发|concurrent|concurrency/i.test(String(message || ""));
}

function humanizeJimengFailureReason(reason = "") {
  const text = String(reason || "").trim();
  if (!text) return "";
  if (isConcurrentLimit(text)) return "即梦当前还有任务在生成，平台限制了并发。等上一条完成后再提交。";
  if (/spawn EBADF/i.test(text)) {
    return "本地图片预处理命令启动失败，任务还没有提交到即梦。已改为预处理失败时自动降级，请重新提交。";
  }
  if (/bad gateway|code\s*201007|commit phase/i.test(text)) {
    return "即梦上传提交阶段平台网关失败，任务没有成功进入生成。通常是平台上传链路临时异常，建议稍后重新提交。";
  }
  if (/upload phase|no file upload/i.test(text)) {
    return "即梦上传文件阶段失败，任务没有成功进入生成。通常是图片上传链路或文件读取异常，建议重新提交；若反复出现，先减少参考图数量。";
  }
  if (/^exit code 1$/i.test(text)) {
    return "即梦 CLI 已启动但无错误详情地退出，任务没有成功进入生成。建议重新提交；若连续出现，先检查 dreamina user_credit 和参考图数量。";
  }
  if (/command timed out/i.test(text)) {
    return "即梦 CLI 提交超时，任务没有拿到平台返回。建议稍后重新提交，或减少本次参考图数量。";
  }
  return text;
}

function jimengFailureReason(parsed = {}, fallback = "即梦平台退回失败。") {
  const reason = String(parsed.fail_reason || parsed.message || parsed.error || "").trim();
  return humanizeJimengFailureReason(reason) || fallback;
}

function isJimengFinalGenerationFailure(reason = "") {
  return /generation failed:\s*final generation failed|final generation failed/i.test(String(reason || ""));
}

const JIMENG_FINAL_FAILURE_AUTO_RETRY_WINDOW_MS = 2 * 60 * 1000;
const JIMENG_FINAL_FAILURE_AUTO_RETRY_LIMIT = 2;

function jimengSubmittedAgeMs(job = {}, nowMs = Date.now()) {
  const submittedAt = Date.parse(String(job.submitted_at || ""));
  if (!Number.isFinite(submittedAt)) return Infinity;
  return nowMs - submittedAt;
}

function canAutoRetryJimengJob(job = {}, reason = "", options = {}) {
  if (job.platform !== "jimeng_cli") return false;
  if (!isJimengFinalGenerationFailure(reason)) return false;
  const count = Number(job.auto_retry_count || 0);
  const retryLimit = Number(options.retryLimit || JIMENG_FINAL_FAILURE_AUTO_RETRY_LIMIT);
  if (!Number.isFinite(count) || count >= retryLimit) return false;
  const maxAgeMs = Number(options.maxAgeMs || JIMENG_FINAL_FAILURE_AUTO_RETRY_WINDOW_MS);
  const ageMs = jimengSubmittedAgeMs(job, options.nowMs);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function queueJimengAutoRetry(job = {}, reason = "") {
  const previousSubmitId = job.jimeng_submit_id || "";
  const previousSubmittedAt = job.submitted_at || "";
  job.auto_retry_count = Number(job.auto_retry_count || 0) + 1;
  job.auto_retry_history = [
    ...(Array.isArray(job.auto_retry_history) ? job.auto_retry_history : []),
    {
      at: now(),
      reason: String(reason || "").trim(),
      previous_submit_id: previousSubmitId,
      previous_submitted_at: previousSubmittedAt,
    },
  ];
  job.status = "queued";
  job.queue_reason = "waiting_turn";
  job.failure_reason = `即梦提交后 2 分钟内返回最终生成失败，已自动重提 ${job.auto_retry_count} 次，正在排队重新提交。`;
  job.jimeng_submit_id = "";
  delete job.submitted_at;
  job.updated_at = now();
  return job;
}

function jimengQueryTimeoutPendingReason(timeoutMs = DREAMINA_QUERY_TIMEOUT_MS) {
  const seconds = Math.round(Number(timeoutMs || 0) / 1000);
  return `即梦本次查询超过 ${seconds} 秒，平台可能仍在生成。系统会继续自动查询，不判定失败。`;
}

function rateLimitHandledReason(job = {}) {
  if (job.platform === "lovart") return "Lovart 并发限制已标记为处理完成，可重新提交任务。";
  return "当前平台并发限制已标记为处理完成，可重新提交任务。";
}

function collectInputs(canvas, nodeIds) {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const incoming = canvas.edges.filter((edge) => nodeIds.includes(edge.target));
  const promptParts = [];
  const assetInputs = [];
  const seenAssetIds = new Set();

  for (const edge of incoming) {
    const source = byId.get(edge.source);
    if (!source) continue;
    if (["globalControl", "text"].includes(source.type)) promptParts.push(source.data?.text || "");
    if (source.data?.asset_id && !seenAssetIds.has(source.data.asset_id)) {
      seenAssetIds.add(source.data.asset_id);
      assetInputs.push({
        asset_id: source.data.asset_id,
        source_node_id: source.id,
        source_node_title: source.data?.title || "",
        source_node_type: source.type,
        source_shot_role: source.data?.shot_role || "",
      });
    }
  }

  return { promptParts: promptParts.filter(Boolean), assetIds: assetInputs.map((item) => item.asset_id), assetInputs };
}

function getAssets(canvas, assetIds) {
  const byId = new Map(canvas.assets.map((asset) => [asset.asset_id, asset]));
  return assetIds.map((assetId) => byId.get(assetId)).filter(Boolean);
}

function assetTagLabelIndex(tags = []) {
  const byAsset = new Map();
  for (const tag of tags) {
    for (const assetId of tag.bound_asset_ids || []) {
      if (!byAsset.has(assetId)) byAsset.set(assetId, []);
      byAsset.get(assetId).push(tag.label);
    }
  }
  return byAsset;
}

function referenceRoleLabel(role) {
  return {
    first_frame: "首帧参考",
    tail_frame: "尾帧参考",
    character_reference: "角色参考",
    scene_reference: "场景参考",
    prop_reference: "道具参考",
    motion_reference: "运动参考",
    reference: "普通参考",
    auto: "自动判断",
  }[role] || "普通参考";
}

function buildNumberedReferenceLabels(inputAssets = []) {
  const mediaCounters = { image: 0, video: 0, audio: 0, file: 0 };
  return inputAssets.map((item, index) => {
    const kind = item.asset?.kind || item.asset_kind || "image";
    const mediaKey = kind === "video" ? "video" : kind === "audio" ? "audio" : kind === "image" ? "image" : "file";
    mediaCounters[mediaKey] += 1;
    const mediaLabel = mediaKey === "image"
      ? `图片${mediaCounters[mediaKey]}`
      : mediaKey === "video"
        ? `视频${mediaCounters[mediaKey]}`
        : mediaKey === "audio"
          ? `音频${mediaCounters[mediaKey]}`
          : `文件${mediaCounters[mediaKey]}`;
    const identity = item.primary_tag_label || item.asset_name || mediaLabel;
    const alias = item.asset_name && item.asset_name !== identity ? ` / ${item.asset_name}` : "";
    return `附件${index + 1} / ${mediaLabel} = ${identity}${alias}（${referenceRoleLabel(item.reference_role || "reference")}）`;
  });
}

function inferReferenceRole(kind, targetNode, input, asset, explicitRole = "") {
  if (explicitRole && explicitRole !== "auto") return explicitRole;
  if (asset?.asset_category === "character") return "character_reference";
  if (asset?.asset_category === "scene") return "scene_reference";
  if (asset?.asset_category === "prop") return "prop_reference";
  if (
    kind === "video"
    && !asset?.is_library_asset
    && asset?.kind === "image"
    && (input.source_shot_role === "frame"
      || input.source_shot_role === "image_result"
      || /分镜.*(图片|静帧)/.test(asset?.name || ""))
  ) return "first_frame";
  return "reference";
}

function normalizeJobInputReferenceRoles(items = [], kind, feature) {
  if (kind !== "video" || !items.length) return items;
  const next = items.map((item) => ({ ...item }));
  let firstFrameIndexes = next
    .map((item, index) => item.reference_role === "first_frame" ? index : -1)
    .filter((index) => index >= 0);

  if (!firstFrameIndexes.length && feature === "first_frame") {
    const candidateIndexes = next
      .map((item, index) => (!item.asset_category && /分镜.*(图片|静帧)/.test(item.asset_name || "")) ? index : -1)
      .filter((index) => index >= 0);
    if (candidateIndexes.length) {
      const chosen = candidateIndexes[candidateIndexes.length - 1];
      next[chosen].reference_role = "first_frame";
      firstFrameIndexes = [chosen];
    }
  }

  if (firstFrameIndexes.length > 1) {
    const chosen = firstFrameIndexes[firstFrameIndexes.length - 1];
    firstFrameIndexes.forEach((index) => {
      if (index === chosen) return;
      if (next[index].asset_category === "character") next[index].reference_role = "character_reference";
      else if (next[index].asset_category === "scene") next[index].reference_role = "scene_reference";
      else if (next[index].asset_category === "prop") next[index].reference_role = "prop_reference";
      else next[index].reference_role = "reference";
    });
  }
  return next;
}

function buildJobInputAssets(data, targetNode, kind, collected) {
  const assetMap = new Map((data.canvas?.assets || []).map((asset) => [asset.asset_id, asset]));
  const tagIndex = assetTagLabelIndex(data.tags || []);
  const explicitRoles = targetNode?.data?.asset_roles || {};
  const parameters = generatorParameters(targetNode?.data || {});
  const items = (collected.assetInputs || []).map((input, index) => {
    const asset = assetMap.get(input.asset_id);
    const tagLabels = Array.from(new Set(tagIndex.get(input.asset_id) || []));
    const referenceRole = inferReferenceRole(kind, targetNode, input, asset, explicitRoles[input.asset_id] || "");
    return {
      ...input,
      order: index + 1,
      asset_name: String(input.source_node_title || asset?.name || input.asset_id || "").trim(),
      asset_kind: asset?.kind || input.source_node_type || "image",
      asset_category: asset?.asset_category || "",
      tag_labels: tagLabels,
      primary_tag_label: tagLabels[0] || "",
      reference_role: referenceRole,
    };
  });
  return normalizeJobInputReferenceRoles(items, kind, parameters.feature || "auto");
}

function buildReferencePromptText(kind, inputAssets = [], parameters = {}) {
  if (!inputAssets.length) return "";
  const standardTags = Array.from(new Set(inputAssets.flatMap((item) => item.tag_labels || []).filter(Boolean)));
  const attachmentLines = buildNumberedReferenceLabels(inputAssets);
  const guidance = kind === "image"
    ? "请按上面的附件编号和图片编号使用参考图，不要忽略附件，也不要混淆角色、场景和道具。"
    : [
        parameters.feature === "first_frame" || inputAssets.some((item) => item.reference_role === "first_frame")
          ? "请严格使用被标记为“首帧参考”的附件作为起始画面。"
          : "",
        inputAssets.some((item) => item.reference_role === "tail_frame")
          ? "被标记为“尾帧参考”的附件只用于理解目标结束画面或上一镜尾帧，不要当成首帧。"
          : "",
        "角色参考只用于角色一致性，场景参考只用于空间与布光，道具参考只用于物体细节。",
        "不要混淆各附件编号、图片编号和用途；若模型无法遵守，请直接说明具体原因。",
      ].filter(Boolean).join(" ");
  return [
    standardTags.length ? `本任务标准标签名：${standardTags.join("、")}。请优先按这些标签名理解角色、场景和道具。` : "",
    "参考素材附件说明：",
    ...attachmentLines,
    guidance,
  ].filter(Boolean).join("\n");
}

function inferLovartProjectFromLogs(projectId) {
  const logDir = path.join(projectDir(projectId), "logs");
  if (!fs.existsSync(logDir)) return "";
  const files = fs.readdirSync(logDir)
    .filter((file) => file.endsWith(".log"))
    .map((file) => path.join(logDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/"project_id":\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function normalizePlatform(value) {
  return String(value || "").trim() === "jimeng_cli" ? "jimeng_cli" : "lovart";
}

function splitParametersByPlatform(platform, parameters = {}) {
  const source = { ...(parameters || {}) };
  const common = {};
  if (source.model != null) common.model = source.model;
  if (source.size != null) common.size = source.size;
  if (source.duration != null) common.duration = source.duration;
  const platformSpecific = {};
  if (source.mode != null) platformSpecific.mode = source.mode;
  if (source.video_resolution != null) platformSpecific.video_resolution = source.video_resolution;
  if (source.resolution_type != null) platformSpecific.resolution_type = source.resolution_type;
  if (source.feature != null) platformSpecific.feature = source.feature;
  if (source.motion_control != null) platformSpecific.motion_control = source.motion_control;
  if (source.edit_instruction != null) platformSpecific.edit_instruction = source.edit_instruction;
  return {
    common,
    platformSpecific: { [normalizePlatform(platform)]: platformSpecific },
  };
}

function normalizeGeneratorData(data = {}) {
  const platform = normalizePlatform(data.platform || data.parameters?.platform || "lovart");
  const common_parameters = { ...(data.common_parameters || {}) };
  const platform_parameters = { ...(data.platform_parameters || {}) };
  const legacyParameters = { ...(data.parameters || {}) };
  delete legacyParameters.platform;
  const split = splitParametersByPlatform(platform, legacyParameters);
  return {
    ...data,
    platform,
    common_parameters: { ...split.common, ...common_parameters },
    platform_parameters: {
      ...split.platformSpecific,
      ...platform_parameters,
      [platform]: {
        ...(split.platformSpecific[platform] || {}),
        ...(platform_parameters[platform] || {}),
      },
    },
  };
}

function generatorParameters(data = {}) {
  const normalized = normalizeGeneratorData(data);
  const merged = {
    ...normalized.common_parameters,
    ...(normalized.platform_parameters?.[normalized.platform] || {}),
    platform: normalized.platform,
  };
  if (normalized.platform === "jimeng_cli") {
    delete merged.feature;
    delete merged.motion_control;
    delete merged.edit_instruction;
  } else {
    delete merged.mode;
    delete merged.video_resolution;
    delete merged.resolution_type;
  }
  return merged;
}

function jimengReferenceName(item = {}) {
  return String(item.primary_tag_label || item.asset_name || "")
    .replace(/^@/, "")
    .trim();
}

function jimengReferenceFallbackName(item = {}, mediaLabel = "参考素材") {
  const roleLabel = referenceRoleLabel(item.reference_role || "reference");
  return String(item.primary_tag_label || item.asset_name || item.asset?.name || roleLabel || item.asset_id || mediaLabel || "参考素材")
    .replace(/^@/, "")
    .trim();
}

function jimengReferenceLine(mediaLabel, item = {}) {
  const roleLabel = referenceRoleLabel(item.reference_role || "reference");
  if (item.reference_role === "first_frame" && !String(item.primary_tag_label || "").trim()) {
    return `@${mediaLabel}=首帧参考`;
  }
  const name = jimengReferenceName(item) || jimengReferenceFallbackName(item, mediaLabel);
  return name === roleLabel ? `@${mediaLabel}=${roleLabel}` : `@${mediaLabel}=${name}（${roleLabel}）`;
}

function buildJimengReferencePrompt(orderedInputs = [], mode = "") {
  if (!orderedInputs.length) return "";
  const imageLines = [];
  const videoLines = [];
  const audioLines = [];
  let imageIndex = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  for (const item of orderedInputs) {
    if (item.asset?.kind === "image") {
      imageIndex += 1;
      const mediaLabel = `图片${imageIndex}`;
      imageLines.push(jimengReferenceLine(mediaLabel, item));
    } else if (item.asset?.kind === "video") {
      videoIndex += 1;
      const mediaLabel = `视频${videoIndex}`;
      videoLines.push(jimengReferenceLine(mediaLabel, item));
    } else if (item.asset?.kind === "audio") {
      audioIndex += 1;
      const mediaLabel = `音频${audioIndex}`;
      audioLines.push(jimengReferenceLine(mediaLabel, item));
    }
  }
  const lines = [...imageLines, ...videoLines, ...audioLines];
  if (!lines.length) return "";
  const usage = mode === "image2video"
    ? "请按上面的编号理解参考图，其中首帧图就是当前命令里的输入图片。"
    : "请严格按上面的编号理解参考素材，不要混淆它们的身份。";
  return [lines.join("，"), usage].join("\n");
}

async function ensureLovartProjectUnlocked(projectId, env) {
  const data = loadProject(projectId);
  const skillPath = lovartSkillPath();
  if (data.project?.lovart_project_id) return data.project.lovart_project_id;

  const inferred = inferLovartProjectFromLogs(projectId);
  if (inferred) {
    saveProjectMeta(projectId, { lovart_project_id: inferred });
    const renameLog = path.join(projectDir(projectId), "logs", `lovart_project_rename_${Date.now()}.log`);
    await runCommand(PYTHON, [skillPath, "project-rename", "--project-id", inferred, "--name", data.project?.name || projectId], renameLog, env);
    return inferred;
  }

  const createLog = path.join(projectDir(projectId), "logs", `lovart_project_create_${Date.now()}.log`);
  const created = await runCommand(PYTHON, [skillPath, "create-project"], createLog, env);
  if (!created.ok) throw new Error(created.error || "Lovart project 创建失败");
  const parsed = parseJsonFromOutput(created.stdout);
  if (!parsed.project_id) throw new Error(`Lovart project 创建返回无法解析：${created.stdout}`);
  const lovartProjectId = parsed.project_id;

  const renameLog = path.join(projectDir(projectId), "logs", `lovart_project_rename_${Date.now()}.log`);
  await runCommand(PYTHON, [skillPath, "project-rename", "--project-id", lovartProjectId, "--name", data.project?.name || projectId], renameLog, env);
  saveProjectMeta(projectId, { lovart_project_id: lovartProjectId });
  return lovartProjectId;
}

async function ensureLovartProject(projectId, env) {
  const key = String(projectId || "AI视频项目");
  const existing = lovartProjectLocks.get(key);
  if (existing) return existing;
  const pending = ensureLovartProjectUnlocked(projectId, env).finally(() => {
    lovartProjectLocks.delete(key);
  });
  lovartProjectLocks.set(key, pending);
  return pending;
}

function maskSecret(text, secret) {
  if (!secret) return text;
  return String(text).split(secret).join("***");
}

function maskSecrets(text, secrets) {
  return secrets.reduce((value, secret) => maskSecret(value, secret), String(text));
}

function runCommand(cmd, args, logFile, extraEnv = {}, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      });
    } catch (error) {
      try {
        fs.writeFileSync(logFile, `COMMAND: ${cmd} ${args.join(" ")}\n\nERROR:\n${maskSecrets(error.message, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n`);
      } catch {}
      finish({ ok: false, error: error.message, stdout, stderr, code: null });
      return;
    }
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          const message = `command timed out after ${options.timeoutMs}ms`;
          try { child.kill("SIGTERM"); } catch {}
          fs.writeFileSync(
            logFile,
            `COMMAND: ${cmd} ${args.join(" ")}\n\nSTDOUT:\n${maskSecrets(stdout, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n\nSTDERR:\n${maskSecrets(stderr, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n\nERROR:\n${message}\n`
          );
          finish({ ok: false, error: message, stdout, stderr, code: null, timedOut: true });
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      fs.writeFileSync(logFile, `COMMAND: ${cmd} ${args.join(" ")}\n\nERROR:\n${maskSecrets(error.message, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n`);
      finish({ ok: false, error: error.message, stdout, stderr, code: null });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      fs.writeFileSync(
        logFile,
        `COMMAND: ${cmd} ${args.join(" ")}\n\nSTDOUT:\n${maskSecrets(stdout, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n\nSTDERR:\n${maskSecrets(stderr, [extraEnv.LOVART_ACCESS_KEY, extraEnv.LOVART_SECRET_KEY])}\n\nCODE: ${code}\n`
      );
      finish({ ok: code === 0, error: stderr || stdout || `exit code ${code}`, stdout, stderr, code });
    });
  });
}

async function parseShotsXlsx(buffer, projectId, preferredSeedancePlatform = "lovart") {
  const tempDir = path.join(projectDir(projectId), "logs");
  ensureDir(tempDir);
  const tempFile = path.join(tempDir, `shots_import_${Date.now()}.xlsx`);
  const logFile = path.join(tempDir, `shots_import_${Date.now()}.log`);
  fs.writeFileSync(tempFile, buffer);
  try {
    const result = await runCommand(PYTHON, [XLSX_PARSER, tempFile], logFile, {}, { timeoutMs: 10000 });
    if (!result.ok) throw new Error(result.error || "Excel 解析失败");
    const parsed = parseJsonFromOutput(result.stdout);
    return (parsed.shots || []).map((shot, index, array) => normalizeShot(shot, array[index - 1]?.shot_id || "", preferredSeedancePlatform));
  } catch (error) {
    throw new Error(`Excel 导入失败：${error.message}`);
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    rarr: "→",
    mdash: "—",
    ndash: "–",
  };
  return String(text || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, entity) => {
    if (entity[0] === "#") {
      const value = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : all;
    }
    return named[entity] || all;
  });
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|td|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function htmlCellTextByClass(rowHtml, className) {
  const pattern = new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i");
  return htmlToPlainText(String(rowHtml || "").match(pattern)?.[1] || "");
}

function htmlCellHtmlByClass(rowHtml, className) {
  const pattern = new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i");
  return String(rowHtml || "").match(pattern)?.[1] || "";
}

function promptBlockTextFromCell(cellHtml, blockClassName) {
  const pattern = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${blockClassName}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, "i");
  const block = String(cellHtml || "").match(pattern)?.[1] || "";
  return htmlToPlainText(block);
}

function transitionFromImportedLabel(value) {
  const text = String(value || "").trim().replace(/\s+/g, "");
  if (!text) return "video_direct";
  if (/接上一尾帧|接上一帧|上一尾帧|continue_prev_tail|prev_tail|tail/i.test(text)) return "continue_prev_tail";
  if (/新建首帧|新首帧|首帧|new_frame|first_frame/i.test(text)) return "new_frame";
  if (/视频直出|直出|video_direct|direct/i.test(text)) return "video_direct";
  return "video_direct";
}

function parseShotlistHtml(html, preferredSeedancePlatform = "lovart") {
  const source = String(html || "").replace(/\r\n/g, "\n");
  const episode = source.match(/Episode\s*(\d+)/i)?.[1] || "1";
  const shots = [];
  const sections = [];
  const sectionRegex = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let sectionMatch;
  while ((sectionMatch = sectionRegex.exec(source))) {
    const attrs = sectionMatch[1] || "";
    const body = sectionMatch[2] || "";
    const scene = attrs.match(/\bid=["']sc(\d+)["']/i)?.[1] || body.match(/SCENE\s*(\d+)/i)?.[1] || "";
    sections.push({ scene, body });
  }
  const blocks = sections.length ? sections : [{ scene: "", body: source }];
  const rowPromptRegex = /<tr\b([^>]*)\bdata-scene=["']([^"']+)["'][^>]*>([\s\S]*?)<td\b[^>]*class=["'][^"']*\bc-prompt\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
  for (const block of blocks) {
    let match;
    rowPromptRegex.lastIndex = 0;
    while ((match = rowPromptRegex.exec(block.body))) {
      const scene = String(match[2] || block.scene || "").trim();
      const rowHtml = match[3] || "";
      const promptCell = match[4] || "";
      const headMatch = promptCell.match(/<div\b[^>]*class=["'][^"']*\bprompt-head\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const promptBlockMatch = promptCell.match(/<div\b[^>]*class=["'][^"']*\bprompt-block\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      if (!scene || !promptBlockMatch) continue;
      const headText = htmlToPlainText(headMatch?.[1] || "");
      const promptNumber = headText.match(/提示词\s*(\d+)/)?.[1] || String(shots.length + 1);
      const video_prompt = htmlToPlainText(promptBlockMatch[1]);
      if (!video_prompt) continue;
      const image_prompt = promptBlockTextFromCell(htmlCellHtmlByClass(rowHtml, "c-image-prompt"), "image-prompt-block");
      const video_model = htmlCellTextByClass(rowHtml, "c-model");
      const transition = transitionFromImportedLabel(htmlCellTextByClass(rowHtml, "c-link"));
      shots.push(normalizeShot({
        shot_id: `分镜${episode}-${scene}-${promptNumber}`,
        transition,
        image_prompt,
        video_prompt,
        video_model,
        duration: extractDurationFromPrompt(video_prompt),
        size: extractAspectRatioFromPrompt(video_prompt),
        tag_refs: extractTags([image_prompt, video_prompt].filter(Boolean).join("\n\n")),
        platform: "",
      }, shots[shots.length - 1]?.shot_id || "", preferredSeedancePlatform));
    }
  }
  return shots;
}

async function runLovartJob(projectId, job, canvas) {
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  const logFile = path.join(dir, "logs", `${job.job_id}.log`);
  const assetMap = new Map(getAssets(canvas, job.input_asset_ids).map((asset) => [asset.asset_id, asset]));
  const orderedInputs = (job.input_assets || []).length
    ? job.input_assets.map((input) => ({ ...input, asset: assetMap.get(input.asset_id) })).filter((item) => item.asset)
    : job.input_asset_ids.map((assetId, index) => {
        const asset = assetMap.get(assetId);
        return asset ? {
          asset_id: assetId,
          asset_name: asset.name,
          asset_kind: asset.kind,
          asset_category: asset.asset_category || "",
          tag_labels: [],
          primary_tag_label: "",
          reference_role: "reference",
          order: index + 1,
          asset,
        } : null;
      }).filter(Boolean);
  const env = lovartEnv();
  const skillPath = lovartSkillPath();
  if (!env.LOVART_ACCESS_KEY || !env.LOVART_SECRET_KEY) {
    return { ok: false, reason: "请先在左侧保存 Lovart Access Key 和 Secret Key。" };
  }
  if (!fs.existsSync(skillPath)) {
    return { ok: false, reason: `找不到 Lovart skill：${skillPath}` };
  }

  const uploaded = [];
  let lovartProjectId = "";
  try {
    lovartProjectId = await ensureLovartProject(projectId, env);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  for (const input of orderedInputs) {
    const asset = input.asset;
    if (!asset) continue;
    if (asset.external_url) {
      uploaded.push({ ...input, url: asset.external_url });
      continue;
    }
    if (!asset.file_path) continue;
    const uploadLog = path.join(dir, "logs", `${job.job_id}_upload_${asset.asset_id}.log`);
    const upload = await runCommand(PYTHON, [skillPath, "upload", "--file", asset.file_path], uploadLog, env);
    if (!upload.ok) return { ok: false, reason: `参考素材上传失败：${upload.error}` };
    try {
      const parsed = JSON.parse(upload.stdout);
      if (parsed.url) uploaded.push({ ...input, url: parsed.url });
    } catch {
      return { ok: false, reason: `参考素材上传返回无法解析：${upload.stdout || upload.stderr}` };
    }
  }

  const selectedModel = job.parameters?.model || "";
  const toolArgs = selectedModel && selectedModel !== "agent-auto" ? ["--include-tools", selectedModel] : [];
  const referenceText = buildReferencePromptText(job.kind, uploaded, job.parameters || {});
  const featureText = job.parameters?.feature && job.parameters.feature !== "auto"
    ? `功能选择: ${job.parameters.feature}`
    : "";
  const motionText = job.parameters?.motion_control ? `动作控制: ${job.parameters.motion_control}` : "";
  const editText = job.parameters?.edit_instruction ? `编辑要求: ${job.parameters.edit_instruction}` : "";
  const parameterText = [
    job.parameters?.size && job.parameters.size !== "agent-auto" ? `画幅比例: ${job.parameters.size}` : "",
    job.parameters?.duration && job.parameters.duration !== "agent-auto" ? `视频时长: ${job.parameters.duration}` : "",
    featureText,
    motionText,
    editText,
  ].filter(Boolean).join("\n");
  const prompt = [
    job.prompt,
    parameterText,
    referenceText,
    job.kind === "image" ? "任务: 生成图片。" : "任务: 生成视频。",
  ].join("\n\n");
  const chatArgs = [
    skillPath,
    "chat",
    "--project-id",
    lovartProjectId,
    "--prompt",
    prompt,
    ...uploaded.length ? ["--attachments", ...uploaded.map((item) => item.url)] : [],
    ...toolArgs,
    "--mode",
    "fast",
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ];
  job.submitted_prompt = prompt;
  job.submitted_command = `${PYTHON} ${chatArgs.join(" ")}`;
  const result = await runCommand(PYTHON, chatArgs, logFile, env);

  if (!result.ok) {
    return { ok: false, reason: result.error || "Lovart 调用失败" };
  }

  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `Lovart 返回无法解析：${result.stdout || result.stderr}` };
  }
  job.lovart_project_id = parsed.project_id || lovartProjectId;
  job.lovart_thread_id = parsed.thread_id;
  if (parsed.final_status === "pending_confirmation") {
    const cost = parsed.pending_confirmation?.estimated_cost || "未知";
    return {
      ok: false,
      pending: true,
      status: "pending_confirmation",
      reason: `Lovart 需要确认高消耗任务，预计 ${cost} credits。可在任务记录里点击“确认并继续”。`,
      lovart_project_id: parsed.project_id || lovartProjectId,
      lovart_thread_id: parsed.thread_id,
      pending_confirmation: parsed.pending_confirmation || {},
    };
  }
  if (parsed.final_status === "timeout") {
    return {
      ok: false,
      pending: true,
      status: "running",
      reason: "Lovart 已接收任务，仍在生成中。请稍后在任务记录里点“刷新结果”。",
      lovart_project_id: parsed.project_id || lovartProjectId,
      lovart_thread_id: parsed.thread_id,
    };
  }
  if (parsed.generation_succeeded === false) {
    const reason = parsed.agent_message || parsed.warning || "Lovart 未生成文件。";
    return { ok: false, status: isLovartInteractionPrompt(reason) ? "needs_input" : "failed", reason };
  }

  const created = assetsFromLovartResult(projectId, job, parsed);
  if (!created.length) return { ok: false, reason: "Lovart 任务完成，但没有下载到本地文件。" };

  return { ok: true, assets: created, lovart_project_id: parsed.project_id || lovartProjectId, lovart_thread_id: parsed.thread_id };
}

function parseDurationSeconds(value, fallback = 5) {
  const match = String(value || "").match(/(\d+)/);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeJimengModel(value, fallback = "seedance2.0fast") {
  return String(value || "").trim() || fallback;
}

function firstJimengImageInput(job, canvas) {
  const assetMap = new Map(getAssets(canvas, job.input_asset_ids).map((asset) => [asset.asset_id, asset]));
  const orderedInputs = (job.input_assets || []).length
    ? job.input_assets.map((input) => ({ ...input, asset: assetMap.get(input.asset_id) })).filter((item) => item.asset)
    : job.input_asset_ids.map((assetId, index) => {
        const asset = assetMap.get(assetId);
        return asset ? { asset_id: assetId, order: index + 1, asset, reference_role: "reference" } : null;
      }).filter(Boolean);
  const preferred = orderedInputs.find((item) => item.reference_role === "first_frame" && item.asset?.kind === "image")
    || orderedInputs.find((item) => item.asset?.kind === "image");
  return preferred?.asset || null;
}

function jimengOrderedInputs(job, canvas) {
  const assetMap = new Map(getAssets(canvas, job.input_asset_ids).map((asset) => [asset.asset_id, asset]));
  return (job.input_assets || []).length
    ? job.input_assets.map((input) => ({ ...input, asset: assetMap.get(input.asset_id) })).filter((item) => item.asset)
    : job.input_asset_ids.map((assetId, index) => {
        const asset = assetMap.get(assetId);
        return asset ? { asset_id: assetId, order: index + 1, asset, reference_role: "reference" } : null;
      }).filter(Boolean);
}

async function runJimengJob(projectId, job, canvas) {
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  const logFile = path.join(dir, "logs", `${job.job_id}.log`);
  const mode = String(job.parameters?.mode || (job.kind === "image" ? "text2image" : "text2video")).trim();
  const orderedInputs = jimengOrderedInputs(job, canvas);
  const imageInputs = orderedInputs.filter((item) => item.asset?.kind === "image");
  const videoInputs = orderedInputs.filter((item) => item.asset?.kind === "video");
  const audioInputs = orderedInputs.filter((item) => item.asset?.kind === "audio");

  const args = [mode];
  const referencePrompt = job.kind === "video" ? buildJimengReferencePrompt(orderedInputs, mode) : "";
  const prompt = [String(job.prompt || "").trim(), referencePrompt].filter(Boolean).join("\n\n");
  if (prompt) args.push("--prompt", prompt);

  const model = normalizeJimengModel(job.parameters?.model, job.kind === "image" ? "5.0" : "seedance2.0fast");
  if (model) args.push("--model_version", model);
  if (job.kind === "video") {
    const duration = parseDurationSeconds(job.parameters?.duration, 5);
    args.push("--duration", String(duration));
    const videoResolution = String(job.parameters?.video_resolution || "720p").trim();
    if (videoResolution) args.push("--video_resolution", videoResolution);
  }

  if (job.kind === "image" && mode === "text2image") {
    if (imageInputs.length || videoInputs.length || audioInputs.length) {
      return { ok: false, reason: "当前是文生图，不会带参考图。要用图片，请切到图生图。" };
    }
    const ratio = String(job.parameters?.size || "").trim();
    if (ratio) args.push("--ratio", ratio);
    const resolutionType = String(job.parameters?.resolution_type || "2k").trim();
    if (resolutionType) args.push("--resolution_type", resolutionType);
  } else if (job.kind === "image" && mode === "image2image") {
    if (!imageInputs.length) {
      return { ok: false, reason: "即梦图生图至少需要 1 张图片。" };
    }
    if (imageInputs.length > 10) {
      return { ok: false, reason: "即梦图生图当前最多支持 10 张图片，请先减少一些。" };
    }
    if (videoInputs.length || audioInputs.length) {
      return { ok: false, reason: "即梦图生图当前只支持图片，先把视频和音频断开。" };
    }
    for (const [index, item] of imageInputs.entries()) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset, item);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”只有远程 URL，没有本地文件。即梦提交必须使用本地素材，请先重新导入这个资产或换成本地图片。` };
      }
      args.push("--images", await stageJimengUploadFile(projectId, job, localPath, index, "image", logFile));
    }
    const ratio = String(job.parameters?.size || "").trim();
    if (ratio) args.push("--ratio", ratio);
    const resolutionType = String(job.parameters?.resolution_type || "2k").trim();
    if (resolutionType) args.push("--resolution_type", resolutionType);
  } else if (mode === "text2video") {
    if (imageInputs.length || videoInputs.length || audioInputs.length) {
      return { ok: false, reason: "当前即梦模式是文生视频，不会带参考素材。要用图片，请切到“单图生视频”；多图参考等“全能参考视频”接入后再用。" };
    }
    const ratio = String(job.parameters?.size || "").trim();
    if (ratio) args.push("--ratio", ratio);
  } else if (mode === "image2video") {
    if (!imageInputs.length) {
      return { ok: false, reason: "即梦单图生视频需要至少一张本地图片作为首帧。" };
    }
    const explicitFirstFrames = imageInputs.filter((item) => item.reference_role === "first_frame");
    if (imageInputs.length > 1 && explicitFirstFrames.length !== 1) {
      return { ok: false, reason: "当前连了多张图片，但即梦单图生视频只吃一张首帧。请只保留一张图，或把其中一张明确标成“首帧参考”。" };
    }
    if (videoInputs.length || audioInputs.length) {
      return { ok: false, reason: "即梦单图生视频这轮只接一张首帧图片，视频和音频参考先别连进来。" };
    }
    const imageInput = explicitFirstFrames[0] || imageInputs[0] || null;
    const imageAsset = imageInput?.asset || firstJimengImageInput(job, canvas);
    const localImagePath = await ensureJimengLocalAsset(projectId, imageAsset, imageInput || {});
    if (!localImagePath || !fs.existsSync(localImagePath)) {
      return { ok: false, reason: "这张图片只有远程 URL，没有本地文件。即梦提交必须使用本地素材，请先重新导入这个资产或换成本地图片。" };
    }
    args.push("--image", await stageJimengUploadFile(projectId, job, localImagePath, 0, "image", logFile));
  } else if (mode === "multimodal2video") {
    if (!imageInputs.length && !videoInputs.length) {
      return { ok: false, reason: "即梦全能参考至少要连一张图片或一个视频。" };
    }
    if (imageInputs.length > 9) {
      return { ok: false, reason: "即梦全能参考当前最多支持 9 张图片，请先减少一些。" };
    }
    if (videoInputs.length > 3) {
      return { ok: false, reason: "即梦全能参考当前最多支持 3 个视频参考，请先减少一些。" };
    }
    if (audioInputs.length > 3) {
      return { ok: false, reason: "即梦全能参考当前最多支持 3 个音频参考，请先减少一些。" };
    }
    for (const [index, item] of imageInputs.entries()) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset, item);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”只有远程 URL，没有本地文件。即梦提交必须使用本地素材，请先重新导入这个资产或换成本地图片。` };
      }
      args.push("--image", await stageJimengUploadFile(projectId, job, localPath, index, "image", logFile));
    }
    for (const [index, item] of videoInputs.entries()) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset, item);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”只有远程 URL，没有本地文件。即梦提交必须使用本地素材，请先重新导入这个资产或换成本地视频。` };
      }
      args.push("--video", await stageJimengUploadFile(projectId, job, localPath, index, "video", logFile));
    }
    for (const [index, item] of audioInputs.entries()) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset, item);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”只有远程 URL，没有本地文件。即梦提交必须使用本地素材，请先重新导入这个资产或换成本地音频。` };
      }
      args.push("--audio", await stageJimengUploadFile(projectId, job, localPath, index, "audio", logFile));
    }
    const ratio = String(job.parameters?.size || "").trim();
    if (ratio) args.push("--ratio", ratio);
  } else {
    return { ok: false, reason: `即梦${job.kind === "image" ? "图片" : "视频"}模式暂不支持：${mode}` };
  }

  job.submitted_prompt = prompt;
  job.submitted_command = `${DREAMINA} ${args.join(" ")}`;
  const result = await runCommand(DREAMINA, args, logFile, DIRECT_NETWORK_ENV, { timeoutMs: DREAMINA_SUBMIT_TIMEOUT_MS });
  if (!result.ok) {
    const detail = [result.error, result.stderr, result.stdout].map((item) => String(item || "").trim()).find(Boolean);
    return { ok: false, reason: humanizeJimengFailureReason(detail) || "即梦 CLI 调用失败" };
  }
  saveProjectPart(projectId, "canvas.json", canvas);
  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `即梦返回无法解析：${result.stdout || result.stderr}` };
  }
  job.jimeng_submit_id = parsed.submit_id || "";
  const genStatus = String(parsed.gen_status || "").trim();
  if (!job.jimeng_submit_id) {
    return { ok: false, reason: "即梦提交成功了，但没有返回 submit_id。" };
  }
  job.submitted_at = now();
  if (genStatus && genStatus !== "querying" && genStatus !== "running") {
    return { ok: false, reason: jimengFailureReason(parsed, `即梦提交状态异常：${genStatus}`) };
  }
  return {
    ok: false,
    pending: true,
    status: "running",
    reason: "即梦已接收任务，正在生成中。",
    jimeng_submit_id: job.jimeng_submit_id,
  };
}

function assetsFromDreaminaResult(projectId, job, parsed) {
  const resultJson = parsed.result_json || {};
  const items = job.kind === "video" ? (resultJson.videos || []) : (resultJson.images || []);
  return items
    .map((item) => item.path || "")
    .filter(Boolean)
    .filter((file) => fs.existsSync(file))
    .map((file, index) => {
      const ext = path.extname(file);
      const kind = job.kind === "video" ? "video" : "image";
      const suffix = items.length > 1 ? `_${index + 1}` : "";
      const desiredName = (job.asset_template_id || job.asset_template_label || job.asset_template_filename)
        ? assetTemplateOutputName(job, suffix)
        : (() => {
            const shotPart = job.shot_ids?.length ? `分镜${job.shot_ids.join("-")}` : path.basename(file, ext);
            const kindPart = kind === "video" ? "视频" : "图片";
            return safeName(`${shotPart}_${kindPart}${suffix}`);
          })();
      const dest = path.join(path.dirname(file), `${desiredName}${ext}`);
      const target = path.basename(file) === path.basename(dest) ? file : uniquePath(path.dirname(file), `${desiredName}${ext}`);
      if (target !== file) fs.renameSync(file, target);
      return {
        asset_id: id("asset"),
        name: path.basename(target, path.extname(target)),
        kind,
        source: "generated",
        file_path: target,
        thumbnail_path: kind === "image" ? target : undefined,
        url: publicAssetUrl(projectId, target),
        is_library_asset: Boolean(job.asset_template_id),
        asset_category: job.asset_category || undefined,
        asset_template_id: job.asset_template_id || undefined,
      };
    });
}

async function refreshDreaminaJob(projectId, job) {
  if (!job.jimeng_submit_id) {
    return { ok: false, pending: true, status: "running", reason: "即梦任务已提交，正在等待 submit_id。" };
  }
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  const logFile = path.join(dir, "logs", `${job.job_id}_result_${Date.now()}.log`);
  const result = await runCommand(DREAMINA, [
    "query_result",
    "--submit_id",
    job.jimeng_submit_id,
    "--download_dir",
    outputDir,
  ], logFile, DIRECT_NETWORK_ENV, { timeoutMs: DREAMINA_QUERY_TIMEOUT_MS });
  if (!result.ok) {
    if (result.timedOut) {
      return {
        ok: false,
        pending: true,
        status: "running",
        reason: jimengQueryTimeoutPendingReason(DREAMINA_QUERY_TIMEOUT_MS),
      };
    }
    const detail = [result.error, result.stderr, result.stdout].map((item) => String(item || "").trim()).find(Boolean);
    return { ok: false, reason: humanizeJimengFailureReason(detail) || "即梦结果刷新失败" };
  }
  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `即梦返回无法解析：${result.stdout || result.stderr}` };
  }
  const genStatus = String(parsed.gen_status || "").trim();
  if (genStatus === "querying" || genStatus === "running") {
    return { ok: false, pending: true, status: "running", reason: "即梦仍在生成中。" };
  }
  if (genStatus !== "success") {
    return { ok: false, reason: jimengFailureReason(parsed) };
  }
  const created = assetsFromDreaminaResult(projectId, job, parsed);
  if (!created.length) {
    return { ok: false, reason: "即梦任务完成了，但没有下载到本地文件。" };
  }
  return { ok: true, assets: created };
}

function assetsFromLovartResult(projectId, job, parsed) {
  const processedKeys = new Set(job.processed_download_keys || []);
  const files = (parsed.downloaded || [])
    .map((item) => ({
      local_path: item.local_path,
      download_key: item.url || item.local_path || "",
    }))
    .filter((item) => item.local_path)
    .filter((item) => fs.existsSync(item.local_path))
    .filter((item) => !item.download_key || !processedKeys.has(item.download_key));

  return files.map((item, index) => {
    const file = item.local_path;
    const ext = path.extname(file);
    const kind = assetKindFromFile(file, job.kind || "image");
    const suffix = files.length > 1 ? `_${index + 1}` : "";
    const desiredName = (job.asset_template_id || job.asset_template_label || job.asset_template_filename)
      ? assetTemplateOutputName(job, suffix)
      : (() => {
          const shotPart = job.shot_ids?.length
            ? `分镜${job.shot_ids.join("-")}`
            : path.basename(file, ext);
          const kindPart = kind === "video" ? "视频" : "图片";
          return safeName(`${shotPart}_${kindPart}${suffix}`);
        })();
    const renamed = file && fs.existsSync(file)
      ? (() => {
          const dest = path.join(path.dirname(file), `${desiredName}${ext}`);
          const target = path.basename(file) === path.basename(dest) ? file : uniquePath(path.dirname(file), `${desiredName}${ext}`);
          if (target !== file) fs.renameSync(file, target);
          return target;
        })()
      : file;
    const asset = {
      asset_id: id("asset"),
      name: path.basename(renamed, path.extname(renamed)),
      kind,
      source: "generated",
      file_path: renamed,
      thumbnail_path: kind === "image" || [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(renamed).toLowerCase()) ? renamed : undefined,
      url: publicAssetUrl(projectId, renamed),
      is_library_asset: Boolean(job.asset_template_id),
      asset_category: job.asset_category || undefined,
      asset_template_id: job.asset_template_id || undefined,
      download_key: item.download_key,
    };
    return asset;
  });
}

function recordProcessedDownloads(job, assets) {
  const keys = assets.map((asset) => asset.download_key).filter(Boolean);
  if (!keys.length) return;
  job.processed_download_keys = Array.from(new Set([...(job.processed_download_keys || []), ...keys]));
}

function cleanGeneratedAssets(assets) {
  return assets.map((asset) => {
    const { download_key, ...clean } = asset;
    return clean;
  });
}

function generatedAssetFileForJob(projectId, job) {
  const kind = job.kind === "video" ? "video" : "image";
  const dir = path.join(projectDir(projectId), kind === "video" ? "videos" : "images");
  if (!fs.existsSync(dir)) return "";
  const base = assetTemplateOutputName(job);
  const allowed = kind === "video"
    ? [".mp4", ".mov", ".webm", ".png", ".jpg", ".jpeg", ".webp", ".gif"]
    : [".png", ".jpg", ".jpeg", ".webp", ".gif"];
  const exact = allowed.map((ext) => path.join(dir, `${base}${ext}`)).find((file) => fs.existsSync(file));
  if (exact) return exact;
  const candidates = fs.readdirSync(dir)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return allowed.includes(ext) && (name === `${base}${ext}` || name.startsWith(`${base}_`));
    })
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || "";
}

function assetFromDownloadedJob(projectId, job, assetId) {
  const file = generatedAssetFileForJob(projectId, job);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  const kind = assetKindFromFile(file, job.kind || "image");
  return {
    asset_id: assetId,
    name: path.basename(file, path.extname(file)),
    kind,
    source: "generated",
    file_path: file,
    thumbnail_path: kind === "image" ? file : undefined,
    url: publicAssetUrl(projectId, file),
    is_library_asset: Boolean(job.asset_template_id),
    asset_category: job.asset_category || undefined,
    asset_template_id: job.asset_template_id || undefined,
  };
}

function reconcileDownloadedJobAssets(projectId, data) {
  if (!data?.canvas || !Array.isArray(data.jobs)) return false;
  data.canvas.nodes = Array.isArray(data.canvas.nodes) ? data.canvas.nodes : [];
  data.canvas.edges = Array.isArray(data.canvas.edges) ? data.canvas.edges : [];
  data.canvas.assets = Array.isArray(data.canvas.assets) ? data.canvas.assets : [];
  let changed = false;
  const assetIds = new Set(data.canvas.assets.map((asset) => asset.asset_id).filter(Boolean));
  for (const job of data.jobs) {
    if (job.status !== "downloaded") continue;
    const outputAssetIds = (job.output_asset_ids || []).filter(Boolean);
    if (!outputAssetIds.length) continue;
    const repairedAssets = [];
    for (const assetId of outputAssetIds) {
      let asset = data.canvas.assets.find((item) => item.asset_id === assetId);
      let assetWasMissing = false;
      if (!asset) {
        asset = assetFromDownloadedJob(projectId, job, assetId);
        if (!asset) continue;
        data.canvas.assets.push(asset);
        assetIds.add(asset.asset_id);
        repairedAssets.push(asset);
        assetWasMissing = true;
        changed = true;
      }
      const hasNode = data.canvas.nodes.some((node) => node.data?.asset_id === asset.asset_id);
      if (!hasNode && !assetWasMissing) repairedAssets.push(asset);
    }
    if (repairedAssets.length) {
      const anchor = resultAnchorForJob(data.canvas, job);
      const resultNodes = placeResultNodes(data.canvas, repairedAssets, anchor, job);
      const existingNodeAssets = new Set(data.canvas.nodes.map((node) => node.data?.asset_id).filter(Boolean));
      const newNodes = resultNodes.filter((node) => !existingNodeAssets.has(node.data?.asset_id));
      if (newNodes.length) {
        data.canvas.nodes.push(...newNodes);
        connectImageResultsToShotVideo(data.canvas, job, newNodes);
        changed = true;
      }
    }
  }
  if (changed) {
    saveProjectPart(projectId, "canvas.json", data.canvas);
    saveProjectPart(projectId, "jobs.json", data.jobs);
  }
  return changed;
}

function syncAssetLibraryTemplate(projectId, updater) {
  const file = path.join(projectDir(projectId), "asset_library.json");
  const library = readJson(file, defaultAssetLibrary());
  updater(library);
  writeJson(file, library);
  return library;
}

function updateAssetLibraryAfterJob(projectId, job, patch = {}) {
  if (!job.asset_template_id) return null;
  return syncAssetLibraryTemplate(projectId, (library) => {
    const template = (library.templates || []).find((item) => item.template_id === job.asset_template_id);
    if (!template) return;
    Object.assign(template, patch);
  });
}

function attachGeneratedAssetsToTemplate(projectId, job, assets) {
  if (!job.asset_template_id) return null;
  return syncAssetLibraryTemplate(projectId, (library) => {
    const template = (library.templates || []).find((item) => item.template_id === job.asset_template_id);
    if (!template) return;
    template.generated_asset_ids = Array.from(new Set([...(template.generated_asset_ids || []), ...assets.map((asset) => asset.asset_id)]));
    template.status = "done";
    template.failure_reason = "";
  });
}

function deleteQueuedJobFromProject(projectId, jobId) {
  const data = loadProject(projectId);
  const index = (data.jobs || []).findIndex((job) => job.job_id === jobId);
  if (index < 0) {
    return { ok: false, status: 404, error: "找不到任务。" };
  }
  const job = data.jobs[index];
  if (job.status !== "queued") {
    return { ok: false, status: 400, error: "只能删除待提交任务；已提交到平台的任务请保留记录。" };
  }
  data.jobs.splice(index, 1);
  saveProjectPart(projectId, "jobs.json", data.jobs);
  const assetLibrary = job.asset_template_id
    ? updateAssetLibraryAfterJob(projectId, job, { status: "idle", failure_reason: "" })
    : data.asset_library;
  return { ok: true, deleted_job: job, jobs: data.jobs, asset_library: assetLibrary || loadProject(projectId).asset_library };
}

function requeueFailedJobFromProject(projectId, jobId) {
  const data = loadProject(projectId);
  const job = (data.jobs || []).find((item) => item.job_id === jobId);
  if (!job) return { ok: false, status: 404, error: "找不到任务。" };
  if (job.status !== "failed") {
    return { ok: false, status: 400, error: "只有失败任务可以重新提交。" };
  }
  if (!ENABLED_PLATFORMS.has(normalizePlatform(job.platform))) {
    return { ok: false, status: 400, error: "这个任务的平台当前不能提交。" };
  }
  const previousSubmitId = job.jimeng_submit_id || job.lovart_thread_id || "";
  job.manual_retry_count = Number(job.manual_retry_count || 0) + 1;
  job.manual_retry_history = [
    ...(Array.isArray(job.manual_retry_history) ? job.manual_retry_history : []),
    {
      at: now(),
      reason: String(job.failure_reason || "").trim(),
      previous_platform_id: previousSubmitId,
      previous_submitted_at: job.submitted_at || "",
    },
  ];
  job.status = "queued";
  job.queue_reason = "waiting_turn";
  job.failure_reason = "已重新加入任务队列，待提交。";
  job.output_asset_ids = [];
  job.processed_download_keys = [];
  job.auto_retry_count = 0;
  delete job.submitted_at;
  delete job.jimeng_submit_id;
  delete job.lovart_thread_id;
  delete job.pending_confirmation;
  job.updated_at = now();
  updateAssetLibraryAfterJob(projectId, job, { status: "queued", failure_reason: job.failure_reason });
  saveProjectPart(projectId, "jobs.json", data.jobs);
  void resumeQueuedContinuousJobs(projectId).catch(() => {});
  return { ok: true, job, jobs: data.jobs, canvas: data.canvas, asset_library: loadProject(projectId).asset_library };
}

function assetTemplateOutputName(job, suffix = "") {
  const raw = String(job.asset_template_filename || job.asset_template_label || "").trim().replace(/^@/, "");
  const base = path.basename(raw || "asset");
  const ext = path.extname(base);
  return safeName(`${ext ? path.basename(base, ext) : base}${suffix}`);
}

function isJimengVipModel(model) {
  return /_vip$/i.test(String(model || "").trim());
}

function jimengConcurrencyModel(model) {
  return normalizeJimengModel(model, "").trim();
}

function isJimengRotatableSeedanceModel(model) {
  const normalized = jimengConcurrencyModel(model);
  return normalized === "seedance2.0fast" || normalized === "seedance2.0";
}

function alternateJimengSeedanceModel(model) {
  const normalized = jimengConcurrencyModel(model);
  if (normalized === "seedance2.0fast") return "seedance2.0";
  if (normalized === "seedance2.0") return "seedance2.0fast";
  return normalized;
}

function activeJobsForPlatform(jobs = [], platform = "lovart") {
  const normalizedPlatform = normalizePlatform(platform);
  return (jobs || []).filter((job) => {
    if (!["running", "pending_confirmation"].includes(job.status)) return false;
    if (normalizePlatform(job.platform || "lovart") !== normalizedPlatform) return false;
    return true;
  });
}

function activeJimengJobsForModel(jobs = [], model = "") {
  const normalizedModel = jimengConcurrencyModel(model);
  return activeJobsForPlatform(jobs, "jimeng_cli").filter((job) => {
    const jobModel = jimengConcurrencyModel(job.parameters?.model);
    return normalizedModel && jobModel === normalizedModel;
  });
}

function hasPendingRateLimitForPlatform(jobs = [], platform = "lovart") {
  const normalizedPlatform = normalizePlatform(platform);
  return (jobs || []).some((job) => (
    job.status === "rate_limited"
    && !job.rate_limit_handled
    && normalizePlatform(job.platform || "lovart") === normalizedPlatform
  ));
}

function hasPendingRateLimitForJimengModel(jobs = [], model = "") {
  const normalizedModel = jimengConcurrencyModel(model);
  if (!normalizedModel) return false;
  return (jobs || []).some((job) => (
    job.status === "rate_limited"
    && !job.rate_limit_handled
    && normalizePlatform(job.platform || "lovart") === "jimeng_cli"
    && jimengConcurrencyModel(job.parameters?.model) === normalizedModel
  ));
}

function hasSubmittingJobForPlatform(jobs = [], platform = "lovart") {
  const normalizedPlatform = normalizePlatform(platform);
  return (jobs || []).some((job) => {
    if (job.status !== "running") return false;
    if (normalizePlatform(job.platform || "lovart") !== normalizedPlatform) return false;
    if (normalizedPlatform === "lovart") return !job.lovart_thread_id;
    if (normalizedPlatform === "jimeng_cli") return !job.jimeng_submit_id;
    return true;
  });
}

function canStartJimengQueuedJobWithModel(jobs = [], model = "") {
  if (isJimengVipModel(model)) return true;
  if (!isJimengRotatableSeedanceModel(model)) {
    return activeJobsForPlatform(jobs, "jimeng_cli").length === 0
      && !(hasPendingRateLimitForPlatform(jobs, "jimeng_cli") && activeJobsForPlatform(jobs, "jimeng_cli").length > 0);
  }
  const activeCount = activeJimengJobsForModel(jobs, model).length;
  if (hasPendingRateLimitForJimengModel(jobs, model) && activeCount > 0) return false;
  return activeCount === 0;
}

function chooseJimengQueueModel(jobs = [], job = {}) {
  const current = jimengConcurrencyModel(job.parameters?.model);
  if (!isJimengRotatableSeedanceModel(current)) return current;
  if (canStartJimengQueuedJobWithModel(jobs, current)) return current;
  const alternate = alternateJimengSeedanceModel(current);
  if (canStartJimengQueuedJobWithModel(jobs, alternate)) return alternate;
  return current;
}

function canStartQueuedJob(jobs = [], job = {}) {
  const platform = normalizePlatform(job.platform || "lovart");
  const activeCount = activeJobsForPlatform(jobs, platform).length;
  if (platform === "lovart") {
    if (hasPendingRateLimitForPlatform(jobs, "lovart")) return false;
    if (hasSubmittingJobForPlatform(jobs, "lovart")) return false;
    return activeCount < 9;
  }
  if (platform === "jimeng_cli") return canStartJimengQueuedJobWithModel(jobs, job.parameters?.model);
  if (hasPendingRateLimitForPlatform(jobs, platform) && activeCount > 0) return false;
  return activeCount === 0;
}

function jobBlocksSubmission(job = {}, incoming = {}, jobs = []) {
  if (job.status !== "rate_limited" || job.rate_limit_handled) return false;
  const jobPlatform = normalizePlatform(job.platform || "lovart");
  const incomingPlatform = normalizePlatform(incoming.platform || "lovart");
  if (jobPlatform !== incomingPlatform) return false;
  if (incomingPlatform === "jimeng_cli" && isJimengVipModel(incoming.model)) return false;
  if (incomingPlatform === "jimeng_cli") {
    const incomingModel = jimengConcurrencyModel(incoming.model);
    if (isJimengRotatableSeedanceModel(incomingModel)) {
      return activeJimengJobsForModel(jobs, incomingModel).length > 0;
    }
    return activeJobsForPlatform(jobs, incomingPlatform).length > 0;
  }
  return true;
}

function blockingJobs(jobs, incoming = {}) {
  return (jobs || []).filter((job) => jobBlocksSubmission(job, incoming, jobs));
}

function activeDuplicateJobs(jobs, targetNodeId, incoming = {}) {
  return (jobs || []).filter((job) => {
    if (job.target_node_id !== targetNodeId) return false;
    if (job.status === "running" || job.status === "queued" || job.status === "pending_confirmation") return true;
    if (jobBlocksSubmission(job, incoming, jobs)) return true;
    return false;
  });
}

function pruneDormantJobsForTarget(jobs = [], targetNodeId = "") {
  const dormantStatuses = new Set(["queued", "rate_limited", "failed", "cancelled"]);
  return jobs.filter((job) => job.target_node_id !== targetNodeId || !dormantStatuses.has(job.status));
}

function placeResultNodes(canvas, assets, anchor, job = {}) {
  const base = anchor || { x: 80, y: 80 };
  return assets.map((asset, index) => ({
    id: id("node"),
    type: asset.kind,
    x: base.x + 280,
    y: base.y + index * 190,
    data: {
      title: asset.name,
      asset_id: asset.asset_id,
      source_job_id: job.job_id,
      source_shot_ids: job.shot_ids || [],
      shot_id: job.shot_ids?.length === 1 ? job.shot_ids[0] : undefined,
      shot_role: job.kind === "image" ? "image_result" : job.kind === "video" ? "video_result" : undefined,
      asset_template_id: asset.asset_template_id || job.asset_template_id,
    },
  }));
}

function resultAnchorForJob(canvas, job = {}) {
  return canvas.nodes.find((node) => node.id === job.target_node_id)
    || canvas.nodes.find((node) => job.input_asset_ids?.includes(node.data?.asset_id))
    || canvas.nodes.find((node) => ["imageGen", "videoGen"].includes(node.type))
    || { x: 80, y: 80 };
}

function connectImageResultsToShotVideo(canvas, job, resultNodes) {
  if (job.kind !== "image" || !job.shot_ids?.length) return;
  const resultImageNodes = resultNodes.filter((node) => node.type === "image" && node.data?.asset_id);
  if (!resultImageNodes.length) return;
  for (const shotId of job.shot_ids) {
    const videoNode = canvas.nodes.find((node) => node.type === "videoGen" && node.data?.shot_id === shotId && node.data?.shot_role === "video");
    if (!videoNode) continue;
    const oldImageGenNode = canvas.nodes.find((node) => node.type === "imageGen" && node.data?.shot_id === shotId && node.data?.shot_role === "image");
    if (oldImageGenNode) {
      canvas.edges = canvas.edges.filter((edge) => !(edge.source === oldImageGenNode.id && edge.target === videoNode.id));
    }
    for (const resultNode of resultImageNodes) {
      const exists = canvas.edges.some((edge) => edge.source === resultNode.id && edge.target === videoNode.id);
      if (!exists) canvas.edges.push({ id: id("edge"), source: resultNode.id, target: videoNode.id });
    }
  }
}

function findShotVideoGeneratorNode(canvas, shotId) {
  return canvas.nodes.find((node) => node.type === "videoGen" && node.data?.shot_id === shotId && node.data?.shot_role === "video");
}

function findShotVideoResultNode(canvas, shotId) {
  return canvas.nodes.find((node) => node.type === "video" && node.data?.shot_id === shotId && node.data?.shot_role === "video_result");
}

function findFrameNodeForSource(canvas, sourceVideoNodeId, shotId) {
  return canvas.nodes.find((node) => node.type === "image"
    && node.data?.shot_role === "frame"
    && (
      (sourceVideoNodeId && node.data?.source_video_node_id === sourceVideoNodeId)
      || (shotId && node.data?.shot_id === shotId)
    ));
}

async function createTailFrameNodeForShot(projectId, data, sourceVideoNode, sourceAsset, shotId) {
  const dir = path.join(projectDir(projectId), "images");
  ensureDir(dir);
  ensureDir(path.join(projectDir(projectId), "logs"));
  const name = safeName(shotId ? `分镜${shotId}_静帧` : (sourceAsset?.name || "视频静帧"));
  const dest = uniquePath(dir, `${name}.png`);
  const logFile = path.join(projectDir(projectId), "logs", `frame_${Date.now()}.log`);
  await extractVideoTailFrame(projectId, sourceAsset, dest, logFile);
  const asset = {
    asset_id: id("asset"),
    name: path.basename(dest, path.extname(dest)),
    kind: "image",
    source: "generated",
    file_path: dest,
    thumbnail_path: dest,
    url: publicAssetUrl(projectId, dest),
  };
  const node = {
    id: id("node"),
    type: "image",
    x: (sourceVideoNode?.x || 80) + 280,
    y: sourceVideoNode?.y || 80,
    data: {
      title: asset.name,
      asset_id: asset.asset_id,
      source_video_node_id: sourceVideoNode?.id,
      shot_id: shotId || sourceVideoNode?.data?.shot_id,
      shot_role: shotId || sourceVideoNode?.data?.shot_id ? "frame" : undefined,
    },
  };
  data.canvas.assets.push(asset);
  data.canvas.nodes.push(node);
  return node;
}

function connectFrameNodeToVideoNode(canvas, frameNode, videoNode) {
  if (!frameNode || !videoNode) return false;
  const exists = canvas.edges.some((edge) => edge.source === frameNode.id && edge.target === videoNode.id);
  if (exists) return false;
  canvas.edges.push({ id: id("edge"), source: frameNode.id, target: videoNode.id });
  return true;
}

function rebuildJobInputsFromCanvas(data, targetNode, job) {
  const collected = collectInputs(data.canvas, [targetNode.id]);
  job.input_asset_ids = collected.assetIds;
  job.input_assets = buildJobInputAssets(data, targetNode, job.kind, collected);
  job.parameters = generatorParameters(targetNode.data || {});
}

async function ensureContinuousShotTailFrame(projectId, data, job) {
  if (job.kind !== "video") return { ready: true };
  const targetNode = data.canvas.nodes.find((node) => node.id === job.target_node_id);
  if (!targetNode || !targetNode.data?.continuous) return { ready: true };
  const prevShotId = String(targetNode.data?.expected_prev_shot_id || job.shot_ids?.[0] || "").trim();
  if (!prevShotId) return { ready: false, reason: "还没找到上一分镜编号。" };
  const existingInputs = buildJobInputAssets(data, targetNode, "video", collectInputs(data.canvas, [targetNode.id]));
  if (existingInputs.some((item) => item.reference_role === "first_frame")) {
    rebuildJobInputsFromCanvas(data, targetNode, job);
    return { ready: true };
  }
  const previousVideoResultNode = findShotVideoResultNode(data.canvas, prevShotId);
  const previousVideoGeneratorNode = findShotVideoGeneratorNode(data.canvas, prevShotId);
  const sourceVideoNode = previousVideoResultNode || previousVideoGeneratorNode;
  if (!sourceVideoNode?.data?.asset_id) {
    return { ready: false, reason: `正在等待上一分镜 ${prevShotId} 的视频结果。` };
  }
  const sourceAsset = data.canvas.assets.find((asset) => asset.asset_id === sourceVideoNode.data.asset_id);
  if (!sourceAsset || sourceAsset.kind !== "video") {
    return { ready: false, reason: `上一分镜 ${prevShotId} 还没有可用视频。` };
  }
  let frameNode = findFrameNodeForSource(data.canvas, sourceVideoNode.id, prevShotId);
  if (!frameNode) {
    frameNode = await createTailFrameNodeForShot(projectId, data, sourceVideoNode, sourceAsset, prevShotId);
  }
  connectFrameNodeToVideoNode(data.canvas, frameNode, targetNode);
  rebuildJobInputsFromCanvas(data, targetNode, job);
  return { ready: true, frameNodeId: frameNode.id };
}

function backgroundErrorMessage(error, fallback = "后台提交任务失败。") {
  const message = String(error?.message || error || "").trim();
  return message || fallback;
}

function saveBackgroundErrorLog(projectId, jobId, error) {
  try {
    const logDir = path.join(projectDir(projectId), "logs");
    ensureDir(logDir);
    const text = String(error?.stack || error?.message || error || "后台提交任务失败。");
    fs.writeFileSync(path.join(logDir, `${jobId}_submit_error_${Date.now()}.log`), text);
  } catch {}
}

function nodeShotIds(node = {}) {
  return Array.from(new Set([
    node.data?.shot_id,
    ...(Array.isArray(node.data?.shot_ids) ? node.data.shot_ids : []),
  ].map((item) => String(item || "").trim()).filter(Boolean)));
}

function jobShotIds(job = {}) {
  return Array.from(new Set((job.shot_ids || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function intersectsSet(values = [], set = new Set()) {
  return values.some((value) => set.has(value));
}

function archiveTitle(shotIds = [], nodes = []) {
  if (shotIds.length) {
    const first = shotIds.slice(0, 3).join("、");
    return shotIds.length > 3 ? `分镜 ${first} 等 ${shotIds.length} 个` : `分镜 ${first}`;
  }
  const firstNode = nodes[0];
  return firstNode ? `节点 ${firstNode.data?.title || firstNode.id}` : "未命名归档";
}

function archiveSelectedNodes(projectId, nodeIds = []) {
  const data = loadProject(projectId);
  const selectedIds = new Set((nodeIds || []).map(String).filter(Boolean));
  const selectedNodes = data.canvas.nodes.filter((node) => selectedIds.has(node.id));
  if (!selectedNodes.length) throw new Error("先选中要归档的分镜节点。");

  const shotIds = new Set(selectedNodes.flatMap(nodeShotIds));
  const archiveNodeIds = new Set(selectedNodes.map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of data.canvas.nodes || []) {
      const shots = nodeShotIds(node);
      if (shots.length && intersectsSet(shots, shotIds) && !archiveNodeIds.has(node.id)) {
        archiveNodeIds.add(node.id);
        changed = true;
      }
    }
    for (const edge of data.canvas.edges || []) {
      const sourceArchived = archiveNodeIds.has(edge.source);
      const targetArchived = archiveNodeIds.has(edge.target);
      if (sourceArchived === targetArchived) continue;
      const source = data.canvas.nodes.find((node) => node.id === edge.source);
      const target = data.canvas.nodes.find((node) => node.id === edge.target);
      const other = sourceArchived ? target : source;
      if (other?.type === "memo" || other?.type === "globalControl") {
        archiveNodeIds.add(other.id);
        changed = true;
      }
    }
  }

  const relatedJobs = (data.jobs || []).filter((job) => (
    archiveNodeIds.has(job.target_node_id)
    || intersectsSet(jobShotIds(job), shotIds)
  ));
  const activeStatuses = new Set(["queued", "running", "rate_limited", "pending_confirmation", "needs_input"]);
  const activeJob = relatedJobs.find((job) => activeStatuses.has(job.status));
  if (activeJob) {
    const shotText = jobShotIds(activeJob).join("、") || activeJob.job_id;
    throw new Error(`分镜 ${shotText} 还有未结束任务，先等它完成或处理失败后再归档。`);
  }

  const outputAssetIds = new Set(relatedJobs.flatMap((job) => job.output_asset_ids || []));
  for (const node of data.canvas.nodes || []) {
    if (node.data?.asset_id && outputAssetIds.has(node.data.asset_id)) archiveNodeIds.add(node.id);
  }

  const archivedNodes = (data.canvas.nodes || []).filter((node) => archiveNodeIds.has(node.id));
  const archivedEdges = (data.canvas.edges || []).filter((edge) => archiveNodeIds.has(edge.source) && archiveNodeIds.has(edge.target));
  const nodeAssetIds = new Set(archivedNodes.map((node) => node.data?.asset_id).filter(Boolean));
  const jobAssetIds = new Set(relatedJobs.flatMap((job) => [
    ...(job.input_asset_ids || []),
    ...(job.output_asset_ids || []),
  ]));
  const archiveAssetIds = new Set([...nodeAssetIds, ...jobAssetIds]);
  const archivedAssets = (data.canvas.assets || []).filter((asset) => archiveAssetIds.has(asset.asset_id));
  const archivedShotIds = Array.from(shotIds);
  const archivedShots = (data.shots || []).filter((shot) => shotIds.has(String(shot.shot_id || "")));
  const archivedRevisions = (data.prompt_context?.revisions || []).filter((revision) => (
    shotIds.has(String(revision.shot_id || ""))
    || archiveNodeIds.has(String(revision.node_id || ""))
  ));
  const archivedBindings = (data.script?.bindings || []).filter((binding) => shotIds.has(String(binding.shot_id || "")));
  const segmentIds = new Set(archivedBindings.map((binding) => binding.segment_id).filter(Boolean));
  const archivedSegments = (data.script?.segments || []).filter((segment) => segmentIds.has(segment.segment_id));
  const archivedTags = (data.tags || []).filter((tag) => intersectsSet(tag.referenced_by_shot_ids || [], shotIds));
  const archive = {
    archive_id: id("archive"),
    title: archiveTitle(archivedShotIds, archivedNodes),
    created_at: now(),
    shot_ids: archivedShotIds,
    nodes: archivedNodes,
    edges: archivedEdges,
    assets: archivedAssets,
    jobs: relatedJobs,
    shots: archivedShots,
    tags: archivedTags,
    prompt_revisions: archivedRevisions,
    script_bindings: archivedBindings,
    script_segments: archivedSegments,
    counts: {
      nodes: archivedNodes.length,
      jobs: relatedJobs.length,
      assets: archivedAssets.length,
      memos: archivedNodes.filter((node) => node.type === "memo").length,
      shots: archivedShots.length,
    },
  };

  data.canvas.nodes = (data.canvas.nodes || []).filter((node) => !archiveNodeIds.has(node.id));
  data.canvas.edges = (data.canvas.edges || []).filter((edge) => !archiveNodeIds.has(edge.source) && !archiveNodeIds.has(edge.target));
  const remainingNodeAssetIds = new Set(data.canvas.nodes.map((node) => node.data?.asset_id).filter(Boolean));
  const removableAssetIds = new Set(archivedAssets
    .filter((asset) => (asset.source === "generated" || asset.source_job_id) && !remainingNodeAssetIds.has(asset.asset_id))
    .map((asset) => asset.asset_id));
  data.canvas.assets = (data.canvas.assets || []).filter((asset) => !removableAssetIds.has(asset.asset_id));
  const relatedJobIds = new Set(relatedJobs.map((job) => job.job_id));
  data.jobs = (data.jobs || []).filter((job) => !relatedJobIds.has(job.job_id));
  data.shots = (data.shots || []).filter((shot) => !shotIds.has(String(shot.shot_id || "")));
  data.tags = buildTags(data.shots, data.tags);
  data.prompt_context.revisions = (data.prompt_context.revisions || []).filter((revision) => !archivedRevisions.some((item) => item.revision_id === revision.revision_id));
  data.script.bindings = (data.script.bindings || []).filter((binding) => !shotIds.has(String(binding.shot_id || "")));
  data.archives = [archive, ...(data.archives || [])];

  saveProjectPart(projectId, "canvas.json", data.canvas);
  saveProjectPart(projectId, "jobs.json", data.jobs);
  saveProjectPart(projectId, "shots.json", data.shots);
  saveProjectPart(projectId, "tags.json", data.tags);
  saveProjectPart(projectId, "prompt_context.json", data.prompt_context);
  saveProjectPart(projectId, "script.json", data.script);
  saveProjectPart(projectId, "archives.json", data.archives);
  return { data, archive };
}

function deleteShotsFromProject(projectId, shotIds = []) {
  const data = loadProject(projectId);
  const shotIdSet = new Set((shotIds || []).map((item) => String(item || "").trim()).filter(Boolean));
  if (!shotIdSet.size) throw new Error("先选择要删除的分镜。");

  const existingShotIds = new Set((data.shots || []).map((shot) => String(shot.shot_id || "")));
  const deletableShotIds = new Set([...shotIdSet].filter((shotId) => existingShotIds.has(shotId)));
  if (!deletableShotIds.size) throw new Error("没有找到要删除的分镜。");

  const removeNodeIds = new Set((data.canvas.nodes || [])
    .filter((node) => intersectsSet(nodeShotIds(node), deletableShotIds))
    .map((node) => node.id));
  const relatedJobs = (data.jobs || []).filter((job) => (
    removeNodeIds.has(job.target_node_id)
    || intersectsSet(jobShotIds(job), deletableShotIds)
  ));
  const activeStatuses = new Set(["queued", "running", "rate_limited", "pending_confirmation", "needs_input"]);
  const activeJob = relatedJobs.find((job) => activeStatuses.has(job.status));
  if (activeJob) {
    const shotText = jobShotIds(activeJob).join("、") || activeJob.job_id;
    throw new Error(`分镜 ${shotText} 还有未结束任务，先等它完成或处理失败后再删除。`);
  }

  const outputAssetIds = new Set(relatedJobs.flatMap((job) => job.output_asset_ids || []));
  for (const node of data.canvas.nodes || []) {
    if (node.data?.asset_id && outputAssetIds.has(node.data.asset_id)) removeNodeIds.add(node.id);
  }

  const removedNodes = (data.canvas.nodes || []).filter((node) => removeNodeIds.has(node.id));
  data.canvas.nodes = (data.canvas.nodes || []).filter((node) => !removeNodeIds.has(node.id));
  data.canvas.edges = (data.canvas.edges || []).filter((edge) => !removeNodeIds.has(edge.source) && !removeNodeIds.has(edge.target));
  const remainingNodeAssetIds = new Set(data.canvas.nodes.map((node) => node.data?.asset_id).filter(Boolean));
  const removedNodeAssetIds = new Set(removedNodes.map((node) => node.data?.asset_id).filter(Boolean));
  const removableAssetIds = new Set((data.canvas.assets || [])
    .filter((asset) => removedNodeAssetIds.has(asset.asset_id))
    .filter((asset) => (asset.source === "generated" || asset.source_job_id) && !remainingNodeAssetIds.has(asset.asset_id))
    .map((asset) => asset.asset_id));
  data.canvas.assets = (data.canvas.assets || []).filter((asset) => !removableAssetIds.has(asset.asset_id));

  const relatedJobIds = new Set(relatedJobs.map((job) => job.job_id));
  data.jobs = (data.jobs || []).filter((job) => !relatedJobIds.has(job.job_id));
  data.shots = (data.shots || []).filter((shot) => !deletableShotIds.has(String(shot.shot_id || "")));
  data.tags = buildTags(data.shots, data.tags);
  data.prompt_context.revisions = (data.prompt_context.revisions || []).filter((revision) => (
    !deletableShotIds.has(String(revision.shot_id || ""))
    && !removeNodeIds.has(String(revision.node_id || ""))
  ));
  const removedBindings = (data.script.bindings || []).filter((binding) => deletableShotIds.has(String(binding.shot_id || "")));
  const removedSegmentIds = new Set(removedBindings.map((binding) => binding.segment_id).filter(Boolean));
  data.script.bindings = (data.script.bindings || []).filter((binding) => !deletableShotIds.has(String(binding.shot_id || "")));
  const remainingSegmentIds = new Set((data.script.bindings || []).map((binding) => binding.segment_id).filter(Boolean));
  data.script.segments = (data.script.segments || []).filter((segment) => !removedSegmentIds.has(segment.segment_id) || remainingSegmentIds.has(segment.segment_id));

  saveProjectPart(projectId, "canvas.json", data.canvas);
  saveProjectPart(projectId, "jobs.json", data.jobs);
  saveProjectPart(projectId, "shots.json", data.shots);
  saveProjectPart(projectId, "tags.json", data.tags);
  saveProjectPart(projectId, "prompt_context.json", data.prompt_context);
  saveProjectPart(projectId, "script.json", data.script);
  return {
    data,
    counts: {
      shots: deletableShotIds.size,
      nodes: removedNodes.length,
      jobs: relatedJobs.length,
      assets: removableAssetIds.size,
    },
  };
}

function restoreArchive(projectId, archiveId = "") {
  const data = loadProject(projectId);
  const archive = (data.archives || []).find((item) => item.archive_id === archiveId);
  if (!archive) throw new Error("找不到这个归档。");
  const assetIds = new Set((data.canvas.assets || []).map((asset) => asset.asset_id));
  for (const asset of archive.assets || []) {
    if (asset.asset_id && !assetIds.has(asset.asset_id)) {
      data.canvas.assets.push(asset);
      assetIds.add(asset.asset_id);
    }
  }
  const nodeIds = new Set((data.canvas.nodes || []).map((node) => node.id));
  for (const node of archive.nodes || []) {
    if (node.id && !nodeIds.has(node.id)) {
      data.canvas.nodes.push(node);
      nodeIds.add(node.id);
    }
  }
  const edgeKey = (edge) => `${edge.source || ""}->${edge.target || ""}`;
  const edgeKeys = new Set((data.canvas.edges || []).map(edgeKey));
  for (const edge of archive.edges || []) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const key = edgeKey(edge);
    if (!edgeKeys.has(key)) {
      data.canvas.edges.push(edge);
      edgeKeys.add(key);
    }
  }
  const jobIds = new Set((data.jobs || []).map((job) => job.job_id));
  for (const job of archive.jobs || []) {
    if (job.job_id && !jobIds.has(job.job_id)) data.jobs.push(job);
  }
  const shotIds = new Set((data.shots || []).map((shot) => String(shot.shot_id || "")));
  for (const shot of archive.shots || []) {
    if (shot.shot_id && !shotIds.has(String(shot.shot_id))) {
      data.shots.push(shot);
      shotIds.add(String(shot.shot_id));
    }
  }
  const revisionIds = new Set((data.prompt_context.revisions || []).map((revision) => revision.revision_id));
  for (const revision of archive.prompt_revisions || []) {
    if (revision.revision_id && !revisionIds.has(revision.revision_id)) data.prompt_context.revisions.push(revision);
  }
  const segmentIds = new Set((data.script.segments || []).map((segment) => segment.segment_id));
  for (const segment of archive.script_segments || []) {
    if (segment.segment_id && !segmentIds.has(segment.segment_id)) data.script.segments.push(segment);
  }
  const bindingKeys = new Set((data.script.bindings || []).map((binding) => `${binding.shot_id}:${binding.segment_id}`));
  for (const binding of archive.script_bindings || []) {
    const key = `${binding.shot_id}:${binding.segment_id}`;
    if (binding.shot_id && binding.segment_id && !bindingKeys.has(key)) data.script.bindings.push(binding);
  }
  data.tags = buildTags(data.shots, data.tags);
  data.archives = (data.archives || []).filter((item) => item.archive_id !== archiveId);

  saveProjectPart(projectId, "canvas.json", data.canvas);
  saveProjectPart(projectId, "jobs.json", data.jobs);
  saveProjectPart(projectId, "shots.json", data.shots);
  saveProjectPart(projectId, "tags.json", data.tags);
  saveProjectPart(projectId, "prompt_context.json", data.prompt_context);
  saveProjectPart(projectId, "script.json", data.script);
  saveProjectPart(projectId, "archives.json", data.archives);
  return { data, archive };
}

async function resumeQueuedContinuousJobs(projectId) {
  const data = loadProject(projectId);
  const jobsToStart = [];
  let changed = false;
  if (data.project?.queue_paused) {
    for (const job of data.jobs || []) {
      if (job.status !== "queued") continue;
      const pausedReason = "队列已暂停：任务保持待提交，恢复提交后会继续。";
      if (job.failure_reason !== pausedReason) {
        job.failure_reason = pausedReason;
        job.updated_at = now();
        changed = true;
      }
    }
    if (changed) saveProjectPart(projectId, "jobs.json", data.jobs);
    return;
  }
  for (const job of data.jobs || []) {
    if (job.status === "queued" && job.queue_reason === "waiting_prev_tail") {
      const prepared = await ensureContinuousShotTailFrame(projectId, data, job);
      if (!prepared.ready) {
        const waitingReason = prepared.reason || "正在等待上一分镜尾帧。";
        if (job.failure_reason !== waitingReason) {
          job.failure_reason = waitingReason;
          job.updated_at = now();
          changed = true;
        }
        continue;
      }
      job.queue_reason = "waiting_turn";
      job.failure_reason = "已拿到上一镜尾帧，待提交。";
      job.updated_at = now();
      changed = true;
    }
    if (job.status !== "queued" && job.status !== "rate_limited") continue;
    if (job.platform === "jimeng_cli" && !isJimengVipModel(job.parameters?.model)) {
      const nextModel = chooseJimengQueueModel(data.jobs, job);
      if (nextModel && nextModel !== job.parameters?.model) {
        job.parameters = { ...(job.parameters || {}), model: nextModel };
        job.failure_reason = `即梦 ${nextModel} 通道空闲，已自动切换普通模型待提交。`;
        job.updated_at = now();
        changed = true;
      }
    }
    if (!canStartQueuedJob(data.jobs, job)) {
      const waitingReason = job.platform === "jimeng_cli"
        ? "即梦当前同模型通道还有任务在生成，等结果返回后自动提交；seedance2.0 与 seedance2.0fast 会自动轮换。"
        : "待提交：Lovart 按单通道提交，等前一条拿到平台返回后自动提交。";
      if (job.failure_reason !== waitingReason) {
        job.failure_reason = waitingReason;
        job.updated_at = now();
        changed = true;
      }
      continue;
    }
    job.status = "running";
    job.failure_reason = "";
    delete job.queue_reason;
    job.rate_limit_handled = false;
    job.updated_at = now();
    updateAssetLibraryAfterJob(projectId, job, { status: "running", failure_reason: "" });
    jobsToStart.push(job.job_id);
    changed = true;
  }
  if (changed) {
    saveProjectPart(projectId, "canvas.json", data.canvas);
    saveProjectPart(projectId, "jobs.json", data.jobs);
  }
  for (const jobId of jobsToStart) {
    void processLovartJobSubmission(projectId, jobId).catch((error) => {
      const fresh = loadProject(projectId);
      const storedJob = fresh.jobs.find((item) => item.job_id === jobId);
      if (!storedJob) return;
      storedJob.status = "failed";
      saveBackgroundErrorLog(projectId, jobId, error);
      storedJob.failure_reason = backgroundErrorMessage(error);
      storedJob.updated_at = now();
      updateAssetLibraryAfterJob(projectId, storedJob, { status: "failed", failure_reason: storedJob.failure_reason || "" });
      saveProjectPart(projectId, "jobs.json", fresh.jobs);
    });
  }
}

function fallbackLovartParameters() {
  return {
    image: {
      platform: "lovart",
      kind: "image",
      models: [
        "agent-auto",
        "generate_image_gpt_image_2",
        "generate_image_gpt_image_2_low",
        "generate_image_gpt_image_2_medium",
        "generate_image_gpt_image_2_high",
        "generate_image_nano_banana_pro",
        "generate_image_nano_banana_2",
        "generate_image_gpt_image_1_5",
        "generate_image_seedream_v5",
        "generate_image_flux_2_max",
        "generate_image_flux_2_pro",
        "generate_image_seedream_v4_5",
        "generate_image_nano_banana",
        "generate_image_seedream_v4",
        "generate_image_imagen_v4",
        "generate_image_midjourney"
      ],
      sizes: ["agent-auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
    },
    video: {
      platform: "lovart",
      kind: "video",
      models: [
        "agent-auto",
        "generate_video_seedance_v2_0",
        "generate_video_seedance_v2_0_fast",
        "generate_video_kling_v3",
        "generate_video_kling_v3_omni",
        "generate_video_seedance_pro_v1_5",
        "generate_video_kling_v2_6",
        "generate_video_wan_v2_6",
        "generate_video_sora_v2_pro",
        "generate_video_sora_v2",
        "generate_video_veo3_1",
        "generate_video_veo3_1_fast",
        "generate_video_hailuo_v2_3",
        "generate_video_veo3",
        "generate_video_vidu_q2"
      ],
      sizes: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      durations: ["agent-auto", "5s", "10s", "15s"]
    }
  };
}

function modelKind(modelName) {
  if (modelName.includes("_video_") || modelName.startsWith("generate_video")) return "video";
  if (modelName.includes("_image_") || modelName.startsWith("generate_image")) return "image";
  return "unknown";
}

function featureOptions(kind, modelName) {
  if (kind === "image") {
    return [
      { value: "auto", label: "自动" },
      { value: "text_to_image", label: "文生图" },
      { value: "image_reference", label: "参考图生成" },
      { value: "image_edit", label: "图片编辑" },
      { value: "style_reference", label: "风格参考" },
      { value: "character_reference", label: "角色一致性" },
    ];
  }
  const base = [
    { value: "auto", label: "自动" },
    { value: "text_to_video", label: "文生视频" },
    { value: "first_frame", label: "首帧生成" },
    { value: "start_end_frame", label: "首尾帧" },
    { value: "all_reference", label: "全能参考" },
    { value: "video_edit", label: "视频编辑" },
  ];
  if (modelName.includes("kling")) {
    base.splice(4, 0, { value: "motion_control", label: "动作控制" });
  }
  return base;
}

function parameterSchema(params) {
  const meta = {};
  for (const model of [...params.image.models, ...params.video.models]) {
    const kind = modelKind(model);
    if (model === "agent-auto" || kind === "unknown") continue;
    meta[model] = {
      kind,
      label: model,
      features: featureOptions(kind, model),
    };
  }
  return meta;
}

async function getLovartParameters() {
  const fallback = fallbackLovartParameters();
  const result = {
    ...fallback,
    source: "fallback",
    model_meta: parameterSchema(fallback),
  };
  const env = lovartEnv();
  const skillPath = lovartSkillPath();
  if (!env.LOVART_ACCESS_KEY || !env.LOVART_SECRET_KEY || !fs.existsSync(skillPath)) return result;

  ensureDir(LOCAL_DIR);
  const logFile = path.join(LOCAL_DIR, `query_mode_${Date.now()}.log`);
  const queried = await runCommand(PYTHON, [skillPath, "query-mode"], logFile, env, { timeoutMs: 6000 });
  if (!queried.ok) return result;
  try {
    const parsed = parseJsonFromOutput(queried.stdout);
    const list = parsed.detail?.unlimited_list || [];
    const image = ["agent-auto"];
    const video = ["agent-auto"];
    const modelMeta = {};
    for (const item of list) {
      const tool = [...(item.alias_list || [])].reverse().find((alias) => alias.startsWith("generate_"));
      if (!tool) continue;
      const kind = modelKind(tool);
      if (kind === "image" && !image.includes(tool)) image.push(tool);
      if (kind === "video" && !video.includes(tool)) video.push(tool);
      modelMeta[tool] = {
        kind,
        label: `${item.model_display_name}${item.extraItem ? ` · ${item.extraItem}` : ""}`,
        aliases: item.alias_list || [],
        remaining_days: item.remaining_days,
        status: item.status,
        features: featureOptions(kind, tool),
      };
    }
    result.image.models = Array.from(new Set([...image, ...fallback.image.models]));
    result.video.models = Array.from(new Set([...video, ...fallback.video.models]));
    result.video.sizes = fallback.video.sizes;
    result.model_meta = { ...parameterSchema(result), ...modelMeta };
    result.mode = parsed.mode;
    result.source = "query-mode";
    return result;
  } catch {
    return result;
  }
}

async function refreshLovartJob(projectId, job, canvas) {
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  if (!job.lovart_thread_id) return { ok: false, reason: "这个任务没有 Lovart thread_id，无法刷新。" };
  const env = lovartEnv();
  const skillPath = lovartSkillPath();
  const logFile = path.join(dir, "logs", `${job.job_id}_result_${Date.now()}.log`);
  const result = await runCommand(PYTHON, [
    skillPath,
    "result",
    "--thread-id",
    job.lovart_thread_id,
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ], logFile, env);
  if (!result.ok) return { ok: false, reason: result.error || "Lovart 结果刷新失败" };
  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `Lovart 返回无法解析：${result.stdout || result.stderr}` };
  }
  if (parsed.status && parsed.status !== "done") {
    return { ok: false, pending: true, status: "running", reason: `Lovart 仍在生成中：${parsed.status}` };
  }
  if (parsed.final_status && parsed.final_status !== "done") {
    return { ok: false, pending: true, status: parsed.final_status, reason: `Lovart 当前状态：${parsed.final_status}` };
  }
  const created = assetsFromLovartResult(projectId, job, parsed);
  if (!created.length) {
    if (parsed.generation_succeeded === false) {
      const reason = parsed.agent_message || parsed.warning || "Lovart 未生成文件。";
      return { ok: false, status: isLovartInteractionPrompt(reason) ? "needs_input" : "failed", reason };
    }
    const hasItems = Array.isArray(parsed.items) && parsed.items.length > 0;
    return {
      ok: false,
      status: "failed",
      reason: hasItems
        ? "Lovart 任务结束了，但没有可下载文件。可能是模型没有产出 artifact。"
        : "Lovart 任务结束了，但返回 items 为空，没有实际生成图片。建议换模型或简化提示词后重新提交。",
    };
  }
  return { ok: true, assets: created };
}

async function confirmLovartJob(projectId, job) {
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  if (!job.lovart_thread_id) return { ok: false, reason: "这个任务没有 Lovart thread_id，无法确认。" };
  const env = lovartEnv();
  const skillPath = lovartSkillPath();
  const logFile = path.join(dir, "logs", `${job.job_id}_confirm_${Date.now()}.log`);
  const result = await runCommand(PYTHON, [
    skillPath,
    "confirm",
    "--thread-id",
    job.lovart_thread_id,
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ], logFile, env);
  if (!result.ok) return { ok: false, reason: result.error || "Lovart 确认任务失败" };
  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `Lovart 返回无法解析：${result.stdout || result.stderr}` };
  }
  if (parsed.final_status && parsed.final_status !== "done") {
    return { ok: false, pending: true, status: parsed.final_status, reason: `Lovart 当前状态：${parsed.final_status}` };
  }
  if (parsed.generation_succeeded === false) {
    const reason = parsed.agent_message || parsed.warning || "Lovart 未生成文件。";
    return { ok: false, status: isLovartInteractionPrompt(reason) ? "needs_input" : "failed", reason };
  }
  const created = assetsFromLovartResult(projectId, job, parsed);
  if (!created.length) return { ok: false, reason: "Lovart 确认完成，但没有下载到本地文件。" };
  return { ok: true, assets: created };
}

async function replyLovartJob(projectId, job, message) {
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, job.kind === "image" ? "images" : "videos");
  ensureDir(outputDir);
  if (!job.lovart_thread_id) return { ok: false, reason: "这个任务没有 Lovart thread_id，无法回复。" };
  const replyText = String(message || "").trim();
  if (!replyText) return { ok: false, reason: "先输入要回复 Lovart 的处理方式。" };
  const env = lovartEnv();
  const skillPath = lovartSkillPath();
  const selectedModel = job.parameters?.model || "";
  const toolArgs = selectedModel && selectedModel !== "agent-auto" ? ["--include-tools", selectedModel] : [];
  const logFile = path.join(dir, "logs", `${job.job_id}_reply_${Date.now()}.log`);
  const result = await runCommand(PYTHON, [
    skillPath,
    "chat",
    ...(job.lovart_project_id ? ["--project-id", job.lovart_project_id] : []),
    "--thread-id",
    job.lovart_thread_id,
    "--prompt",
    replyText,
    ...toolArgs,
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ], logFile, env);
  if (!result.ok) return { ok: false, reason: result.error || "Lovart 回复失败" };
  let parsed;
  try {
    parsed = parseJsonFromOutput(result.stdout);
  } catch {
    return { ok: false, reason: `Lovart 返回无法解析：${result.stdout || result.stderr}` };
  }
  if (parsed.project_id) job.lovart_project_id = parsed.project_id;
  if (parsed.thread_id) job.lovart_thread_id = parsed.thread_id;
  if (parsed.final_status === "pending_confirmation") {
    const cost = parsed.pending_confirmation?.estimated_cost || "未知";
    return {
      ok: false,
      status: "pending_confirmation",
      reason: `Lovart 需要确认高消耗任务，预计 ${cost} credits。可在任务记录里点击“确认并继续”。`,
      pending_confirmation: parsed.pending_confirmation || {},
    };
  }
  if (parsed.final_status === "timeout") {
    return {
      ok: false,
      pending: true,
      status: "running",
      reason: "Lovart 已接收回复，仍在生成中。请稍后刷新结果。",
    };
  }
  if (parsed.generation_succeeded === false) {
    const reason = parsed.agent_message || parsed.warning || "Lovart 未生成文件。";
    return { ok: false, status: isLovartInteractionPrompt(reason) ? "needs_input" : "failed", reason };
  }
  const created = assetsFromLovartResult(projectId, job, parsed);
  if (!created.length) return { ok: false, status: "failed", reason: "Lovart 回复完成，但没有下载到本地文件。" };
  return { ok: true, assets: created };
}

async function processLovartJobSubmission(projectId, jobId) {
  activeJobSubmissions.add(jobId);
  const data = loadProject(projectId);
  const job = data.jobs.find((item) => item.job_id === jobId);
  if (!job) {
    activeJobSubmissions.delete(jobId);
    return;
  }
  const targetNode = data.canvas.nodes.find((node) => node.id === job.target_node_id) || null;
  let result;
  try {
    result = job.platform === "jimeng_cli"
      ? await runJimengJob(projectId, job, data.canvas)
      : await runLovartJob(projectId, job, data.canvas);
  } finally {
    activeJobSubmissions.delete(jobId);
  }
  const fresh = loadProject(projectId);
  const storedJob = fresh.jobs.find((item) => item.job_id === jobId);
  if (!storedJob) return;
  if (result.lovart_project_id) storedJob.lovart_project_id = result.lovart_project_id;
  if (result.lovart_thread_id) storedJob.lovart_thread_id = result.lovart_thread_id;
  if (!storedJob.lovart_project_id && job.lovart_project_id) storedJob.lovart_project_id = job.lovart_project_id;
  if (!storedJob.lovart_thread_id && job.lovart_thread_id) storedJob.lovart_thread_id = job.lovart_thread_id;
  if (result.jimeng_submit_id) storedJob.jimeng_submit_id = result.jimeng_submit_id;
  if (job.submitted_prompt) storedJob.submitted_prompt = job.submitted_prompt;
  if (job.submitted_command) storedJob.submitted_command = job.submitted_command;
  if (job.submitted_at) storedJob.submitted_at = job.submitted_at;
  if (!result.ok) {
    const status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.status || (result.pending ? "running" : "failed"));
    if (canAutoRetryJimengJob(storedJob, result.reason) && status === "failed") {
      queueJimengAutoRetry(storedJob, result.reason);
      updateAssetLibraryAfterJob(projectId, storedJob, { status: "queued", failure_reason: storedJob.failure_reason || "" });
      saveProjectPart(projectId, "jobs.json", fresh.jobs);
      void resumeQueuedContinuousJobs(projectId).catch(() => {});
      return;
    }
    storedJob.status = status;
    storedJob.failure_reason = status === "running" ? "" : result.reason;
    if (result.pending_confirmation) storedJob.pending_confirmation = result.pending_confirmation;
    storedJob.updated_at = now();
    updateAssetLibraryAfterJob(projectId, storedJob, {
      status: status === "running" ? "running" : "failed",
      failure_reason: status === "running" ? "" : (result.reason || ""),
    });
    saveProjectPart(projectId, "jobs.json", fresh.jobs);
    if (
      (storedJob.platform === "lovart" && storedJob.lovart_thread_id && status !== "rate_limited")
      || (storedJob.platform === "jimeng_cli" && status !== "rate_limited" && status !== "running")
    ) {
      void resumeQueuedContinuousJobs(projectId).catch(() => {});
    }
    return;
  }

  recordProcessedDownloads(storedJob, result.assets);
  const cleanAssets = cleanGeneratedAssets(result.assets);
  fresh.canvas.assets.push(...cleanAssets);
  const anchorNode = fresh.canvas.nodes.find((node) => node.id === storedJob.target_node_id) || targetNode;
  const resultNodes = placeResultNodes(fresh.canvas, cleanAssets, anchorNode, storedJob);
  fresh.canvas.nodes.push(...resultNodes);
  connectImageResultsToShotVideo(fresh.canvas, storedJob, resultNodes);
  storedJob.status = "downloaded";
  storedJob.failure_reason = "";
  storedJob.output_asset_ids = cleanAssets.map((asset) => asset.asset_id);
  storedJob.updated_at = now();
  attachGeneratedAssetsToTemplate(projectId, storedJob, cleanAssets);
  saveProjectPart(projectId, "canvas.json", fresh.canvas);
  saveProjectPart(projectId, "jobs.json", fresh.jobs);
  if (storedJob.platform === "lovart" || storedJob.kind === "video") {
    void resumeQueuedContinuousJobs(projectId).catch(() => {});
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, value, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(contentType.startsWith("application/json") ? JSON.stringify(value) : value);
}

function serveFile(req, res, file) {
  const contentType = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range && contentType.startsWith("video/")) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": contentType.startsWith("video/") ? "bytes" : "none",
  });
  return fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/project-files/")) {
    const parts = decodeURIComponent(url.pathname).split("/");
    const projectId = parts[2];
    const rel = parts.slice(3).join("/");
    const projectPath = path.resolve(projectDir(projectId));
    const file = path.resolve(path.join(projectPath, rel));
    if (!file.startsWith(projectPath) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    return serveFile(req, res, file);
  }

  const filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  const file = path.normalize(filePath);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
  serveFile(req, res, file);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/project/create") {
    const body = await readBody(req);
    return send(res, 200, createProject(body.name));
  }

  if (req.method === "GET" && url.pathname === "/api/project") {
    const projectId = url.searchParams.get("project_id") || "AI视频项目";
    createProject(projectId);
    await resumeQueuedContinuousJobs(projectId);
    return send(res, 200, loadProject(projectId));
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/state") {
    const projectId = url.searchParams.get("project_id") || "AI视频项目";
    await resumeQueuedContinuousJobs(projectId);
    const data = loadProject(projectId);
    return send(res, 200, {
      project: data.project,
      jobs: data.jobs,
      canvas: data.canvas,
      asset_library: data.asset_library,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/queue-pause") {
    const body = await readBody(req);
    const projectId = body.project_id || "AI视频项目";
    const project = setQueuePaused(projectId, body.paused);
    await resumeQueuedContinuousJobs(projectId);
    const data = loadProject(projectId);
    return send(res, 200, {
      ok: true,
      project: data.project || project,
      jobs: data.jobs,
      canvas: data.canvas,
      asset_library: data.asset_library,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    return send(res, 200, listProjects());
  }

  if (req.method === "GET" && url.pathname === "/api/project/reuse-package") {
    const projectId = url.searchParams.get("project_id") || "AI视频项目";
    try {
      return send(res, 200, { ok: true, package: exportProjectReusePackage(projectId) });
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "导出项目复用包失败。" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/project/import-reuse-package") {
    const body = await readBody(req);
    try {
      return send(res, 200, importProjectReusePackage(body.package, body.name));
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "导入项目复用包失败。" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/canvas/save") {
    const body = await readBody(req);
    const nextCanvas = mergeCanvasForSave(body.project_id, body.canvas);
    saveProjectPart(body.project_id, "canvas.json", nextCanvas);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/archive/selected") {
    const body = await readBody(req);
    try {
      const { data, archive } = archiveSelectedNodes(body.project_id, Array.isArray(body.node_ids) ? body.node_ids : []);
      return send(res, 200, {
        ok: true,
        archive,
        canvas: data.canvas,
        shots: data.shots,
        tags: data.tags,
        jobs: data.jobs,
        archives: data.archives,
        prompt_context: data.prompt_context,
        script: data.script,
      });
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "归档失败。" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/shots/delete") {
    const body = await readBody(req);
    try {
      const { data, counts } = deleteShotsFromProject(body.project_id, Array.isArray(body.shot_ids) ? body.shot_ids : []);
      return send(res, 200, {
        ok: true,
        counts,
        canvas: data.canvas,
        shots: data.shots,
        tags: data.tags,
        jobs: data.jobs,
        archives: data.archives,
        prompt_context: data.prompt_context,
        script: data.script,
      });
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "删除分镜失败。" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/archive/restore") {
    const body = await readBody(req);
    try {
      const { data, archive } = restoreArchive(body.project_id, String(body.archive_id || ""));
      return send(res, 200, {
        ok: true,
        archive,
        canvas: data.canvas,
        shots: data.shots,
        tags: data.tags,
        jobs: data.jobs,
        archives: data.archives,
        prompt_context: data.prompt_context,
        script: data.script,
      });
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "恢复归档失败。" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/shots/parse-xlsx") {
    const body = await readBody(req);
    const buffer = Buffer.from(body.base64 || "", "base64");
    if (!buffer.length) return send(res, 400, { ok: false, error: "没有收到 Excel 文件。" });
    const shots = await parseShotsXlsx(buffer, body.project_id, body.seedance_platform || "lovart");
    return send(res, 200, { shots });
  }

  if (req.method === "POST" && url.pathname === "/api/shots/parse-html") {
    const body = await readBody(req);
    const source = Buffer.from(body.base64 || "", "base64").toString("utf8");
    if (!source.trim()) return send(res, 400, { ok: false, error: "没有收到 HTML 文件内容。" });
    const shots = parseShotlistHtml(source, body.seedance_platform || "lovart");
    if (!shots.length) return send(res, 400, { ok: false, error: "没有在这个网页里找到 Seedance 提示词块。" });
    return send(res, 200, { shots });
  }

  if (req.method === "POST" && url.pathname === "/api/shots/import") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const shots = parseShots(body.text);
    const tags = buildTags(shots, data.tags);
    saveProjectPart(body.project_id, "shots.json", shots);
    saveProjectPart(body.project_id, "tags.json", tags);
    return send(res, 200, { shots, tags });
  }

  if (req.method === "POST" && url.pathname === "/api/shots/save") {
    const body = await readBody(req);
    const shots = (body.shots || []).map((shot, index, array) => normalizeShot(shot, array[index - 1]?.shot_id || "", body.seedance_platform || "lovart"));
    const tags = body.tags || buildTags(shots, loadProject(body.project_id).tags);
    saveProjectPart(body.project_id, "shots.json", shots);
    saveProjectPart(body.project_id, "tags.json", tags);
    return send(res, 200, { ok: true, shots, tags });
  }

  if (req.method === "POST" && url.pathname === "/api/tags/save") {
    const body = await readBody(req);
    saveProjectPart(body.project_id, "tags.json", body.tags);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/script/save") {
    const body = await readBody(req);
    const projectId = body.project_id || "AI视频项目";
    createProject(projectId);
    return send(res, 200, { ok: true, script: saveScript(projectId, body.script || {}) });
  }

  if (req.method === "GET" && url.pathname === "/api/prompt-policy") {
    return send(res, 200, loadPromptPolicy());
  }

  if (req.method === "GET" && url.pathname === "/api/prompt-context") {
    const projectId = url.searchParams.get("project_id") || "AI视频项目";
    createProject(projectId);
    return send(res, 200, loadPromptContext(projectId));
  }

  if (req.method === "POST" && url.pathname === "/api/prompt-context") {
    const body = await readBody(req);
    const projectId = body.project_id || "AI视频项目";
    createProject(projectId);
    let context = loadPromptContext(projectId);
    if (body.context && typeof body.context === "object") {
      context = sanitizePromptContext(body.context);
    }
    if (body.project_context && typeof body.project_context === "object") {
      context.project_context = {
        ...context.project_context,
        style: body.project_context.style == null ? context.project_context.style : String(body.project_context.style || "").trim(),
        asset_summary: body.project_context.asset_summary == null ? context.project_context.asset_summary : String(body.project_context.asset_summary || "").trim(),
        model_preferences: body.project_context.model_preferences == null ? context.project_context.model_preferences : String(body.project_context.model_preferences || "").trim(),
        overrides: body.project_context.overrides == null ? context.project_context.overrides : sanitizeStringArray(body.project_context.overrides, 30),
      };
    }
    const learningItems = sanitizeStringArray([
      ...(Array.isArray(body.learnings) ? body.learnings : []),
      body.learning || "",
    ], 20);
    for (const learning of learningItems) {
      if (!context.learnings.includes(learning)) context.learnings.push(learning);
    }
    if (body.feedback_presets != null) {
      context.feedback_presets = sanitizeStringArray(body.feedback_presets, 30);
    }
    if (body.revision && typeof body.revision === "object") {
      context.revisions.push({
        revision_id: body.revision.revision_id || id("promptrev"),
        created_at: body.revision.created_at || now(),
        ...body.revision,
      });
    }
    return send(res, 200, { ok: true, prompt_context: savePromptContext(projectId, context) });
  }

  if (req.method === "POST" && url.pathname === "/api/prompt-optimize") {
    const body = await readBody(req);
    const projectId = body.project_id || "AI视频项目";
    createProject(projectId);
    const feedback = String(body.user_feedback || "").trim();
    if (!feedback) return send(res, 400, { ok: false, error: "先写一句这次哪里不理想。" });
    const result = await optimizePromptWithDeepSeek(projectId, body);
    return send(res, 200, { ok: true, result });
  }

  if (req.method === "POST" && url.pathname === "/api/asset-library/import") {
    const body = await readBody(req);
    const source = Buffer.from(body.base64 || "", "base64").toString("utf8");
    if (!source.trim()) return send(res, 400, { ok: false, error: "没有收到资产 Markdown 内容。" });
    const current = loadProject(body.project_id).asset_library || defaultAssetLibrary();
    const assetLibrary = parseAssetLibraryMarkdown(source, current);
    saveProjectPart(body.project_id, "asset_library.json", assetLibrary);
    return send(res, 200, { asset_library: assetLibrary });
  }

  if (req.method === "POST" && url.pathname === "/api/asset-library/import-jsonl") {
    const body = await readBody(req);
    const source = Buffer.from(body.base64 || "", "base64").toString("utf8");
    if (!source.trim()) return send(res, 400, { ok: false, error: "没有收到资产 JSONL 内容。" });
    const current = loadProject(body.project_id).asset_library || defaultAssetLibrary();
    const assetLibrary = parseAssetLibraryJsonl(source, current);
    saveProjectPart(body.project_id, "asset_library.json", assetLibrary);
    return send(res, 200, { asset_library: assetLibrary });
  }

  if (req.method === "POST" && url.pathname === "/api/asset-library/save") {
    const body = await readBody(req);
    const next = {
      global_rules: String(body.asset_library?.global_rules || ""),
      image_model: String(body.asset_library?.image_model || "agent-auto"),
      templates: Array.isArray(body.asset_library?.templates) ? body.asset_library.templates : [],
    };
    saveProjectPart(body.project_id, "asset_library.json", next);
    return send(res, 200, { ok: true, asset_library: next });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/import") {
    const body = await readBody(req);
    const dir = path.join(projectDir(body.project_id), "input");
    ensureDir(dir);
    const buffer = Buffer.from(body.base64, "base64");
    const dest = uniquePath(dir, safeName(body.file_name || "asset"));
    fs.writeFileSync(dest, buffer);
    const asset = {
      asset_id: id("asset"),
      name: path.basename(dest, path.extname(dest)),
      kind: assetKindFromMime(body.mime || "", body.file_name || ""),
      source: "input",
      is_library_asset: Boolean(body.is_library_asset),
      asset_category: body.asset_category || undefined,
      asset_template_id: body.asset_template_id || undefined,
      file_path: dest,
      thumbnail_path: assetKindFromMime(body.mime || "", body.file_name || "") === "image" ? dest : undefined,
      url: publicAssetUrl(body.project_id, dest),
    };
    const data = loadProject(body.project_id);
    data.canvas.assets.push(asset);
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { asset, canvas: data.canvas });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/url") {
    const body = await readBody(req);
    const rawUrl = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      return send(res, 400, { ok: false, error: "请输入可访问的 http 或 https 素材 URL。" });
    }
    const dir = path.join(projectDir(body.project_id), "input");
    ensureDir(dir);
    const displayName = safeName(body.name || assetNameFromUrl(rawUrl));
    let filePath = "";
    try {
      const downloaded = await downloadRemoteFile(rawUrl, path.join(dir, displayName));
      filePath = downloaded.filePath;
    } catch (error) {
      return send(res, 400, {
        ok: false,
        error: `URL 素材下载失败，没有写入本地文件夹：${error.message || "下载失败"}`,
      });
    }
    const kind = body.kind || assetKindFromUrl(rawUrl);
    const asset = {
      asset_id: id("asset"),
      name: path.basename(filePath, path.extname(filePath)) || displayName,
      kind,
      source: "input",
      is_library_asset: Boolean(body.is_library_asset),
      asset_category: body.asset_category || undefined,
      asset_template_id: body.asset_template_id || undefined,
      external_url: rawUrl,
      file_path: filePath,
      thumbnail_path: kind === "image" ? filePath : undefined,
      url: publicAssetUrl(body.project_id, filePath),
    };
    const data = loadProject(body.project_id);
    data.canvas.assets.push(asset);
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { ok: true, asset, canvas: data.canvas });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/frame") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const sourceNode = data.canvas.nodes.find((node) => node.id === body.source_node_id);
    const dir = path.join(projectDir(body.project_id), "images");
    ensureDir(dir);
    const name = safeName(body.name || "视频静帧");
    const dest = uniquePath(dir, `${name}.png`);
    if (body.use_ffmpeg) {
      const sourceAsset = data.canvas.assets.find((asset) => asset.asset_id === body.source_asset_id);
      if (!sourceAsset || sourceAsset.kind !== "video") {
        return send(res, 400, { ok: false, error: "找不到要提尾帧的视频素材。" });
      }
      ensureDir(path.join(projectDir(body.project_id), "logs"));
      const logFile = path.join(projectDir(body.project_id), "logs", `frame_${Date.now()}.log`);
      try {
        await extractVideoTailFrame(body.project_id, sourceAsset, dest, logFile);
      } catch (error) {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
        return send(res, 400, { ok: false, error: error.message || "尾帧提取失败。" });
      }
    } else {
      const buffer = Buffer.from(body.base64 || "", "base64");
      if (!buffer.length) return send(res, 400, { ok: false, error: "没有收到静帧图片。" });
      fs.writeFileSync(dest, buffer);
    }
    const asset = {
      asset_id: id("asset"),
      name: path.basename(dest, path.extname(dest)),
      kind: "image",
      source: "generated",
      file_path: dest,
      thumbnail_path: dest,
      url: publicAssetUrl(body.project_id, dest),
    };
    const node = {
      id: id("node"),
      type: "image",
      x: (sourceNode?.x || 80) + 280,
      y: sourceNode?.y || 80,
      data: {
        title: asset.name,
        asset_id: asset.asset_id,
        source_video_node_id: sourceNode?.id,
        shot_id: sourceNode?.data?.shot_id,
        shot_role: sourceNode?.data?.shot_id ? "frame" : undefined,
      },
    };
    data.canvas.assets.push(asset);
    data.canvas.nodes.push(node);
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { ok: true, asset, node, canvas: data.canvas });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/delete") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const assetId = String(body.asset_id || "");
    if (!assetId) return send(res, 400, { ok: false, error: "缺少 asset_id。" });
    const before = data.canvas.assets.length;
    data.canvas.assets = data.canvas.assets.filter((asset) => asset.asset_id !== assetId);
    if (data.canvas.assets.length === before) return send(res, 404, { ok: false, error: "找不到这个资产。" });

    const removedNodeIds = new Set(
      data.canvas.nodes
        .filter((node) => node.data?.asset_id === assetId)
        .map((node) => node.id)
    );
    data.canvas.nodes = data.canvas.nodes.filter((node) => node.data?.asset_id !== assetId);
    data.canvas.edges = data.canvas.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target));
    data.tags = data.tags.map((tag) => ({
      ...tag,
      bound_asset_ids: (tag.bound_asset_ids || []).filter((id) => id !== assetId),
    }));
    data.jobs = data.jobs.map((job) => ({
      ...job,
      input_asset_ids: (job.input_asset_ids || []).filter((id) => id !== assetId),
      output_asset_ids: (job.output_asset_ids || []).filter((id) => id !== assetId),
    }));
    data.asset_library.templates = (data.asset_library.templates || []).map((template) => ({
      ...template,
      generated_asset_ids: (template.generated_asset_ids || []).filter((id) => id !== assetId),
    }));
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    saveProjectPart(body.project_id, "tags.json", data.tags);
    saveProjectPart(body.project_id, "jobs.json", data.jobs);
    saveProjectPart(body.project_id, "asset_library.json", data.asset_library);
    return send(res, 200, { ok: true, canvas: data.canvas, tags: data.tags, jobs: data.jobs, asset_library: data.asset_library });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/rename") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const assetId = String(body.asset_id || "");
    const nextName = String(body.name || "").trim();
    if (!assetId) return send(res, 400, { ok: false, error: "缺少 asset_id。" });
    if (!nextName) return send(res, 400, { ok: false, error: "资产名称不能为空。" });
    const asset = data.canvas.assets.find((item) => item.asset_id === assetId);
    if (!asset) return send(res, 404, { ok: false, error: "找不到这个资产。" });
    renameFileForAsset(body.project_id, asset, nextName);
    for (const node of data.canvas.nodes) {
      if (node.data?.asset_id === assetId) node.data.title = asset.name;
    }
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { ok: true, asset, canvas: data.canvas });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/compress") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const assetId = String(body.asset_id || "");
    const asset = data.canvas.assets.find((item) => item.asset_id === assetId);
    if (!asset) return send(res, 404, { ok: false, error: "找不到这个资产。" });
    try {
      await compressImageAsset(body.project_id, asset, {
        target_mb: body.target_mb,
        max_edge: body.max_edge,
        quality: body.quality,
      });
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message || "图片压缩失败。" });
    }
    for (const node of data.canvas.nodes) {
      if (node.data?.asset_id === assetId) node.data.title = asset.name;
    }
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { ok: true, asset, canvas: data.canvas });
  }

  if (req.method === "POST" && url.pathname === "/api/assets/meta") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const assetId = String(body.asset_id || "");
    const asset = data.canvas.assets.find((item) => item.asset_id === assetId);
    if (!asset) return send(res, 404, { ok: false, error: "找不到这个资产。" });
    asset.is_library_asset = Boolean(body.is_library_asset);
    asset.asset_category = asset.is_library_asset ? (body.asset_category || asset.asset_category || "other") : undefined;
    saveProjectPart(body.project_id, "canvas.json", data.canvas);
    return send(res, 200, { ok: true, asset, canvas: data.canvas });
  }

  if (req.method === "GET" && url.pathname === "/api/lovart/parameters") {
    const params = await getLovartParameters();
    const skillPath = lovartSkillPath();
    return send(res, 200, {
      ...params,
      command: `${PYTHON} ${skillPath}`,
      adapter_status: fs.existsSync(skillPath) ? "skill_configured" : "skill_missing",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const settings = loadSettings();
    return send(res, 200, {
      lovart_access_key_set: Boolean(settings.lovart_access_key),
      lovart_access_key_preview: settings.lovart_access_key
        ? `${settings.lovart_access_key.slice(0, 4)}••••${settings.lovart_access_key.slice(-4)}`
        : "",
      lovart_secret_key_set: Boolean(settings.lovart_secret_key),
      lovart_secret_key_preview: settings.lovart_secret_key
        ? `${settings.lovart_secret_key.slice(0, 4)}••••${settings.lovart_secret_key.slice(-4)}`
        : "",
      project_root: settings.project_root,
      lovart_skill_path: settings.lovart_skill_path,
      lovart_skill_exists: fs.existsSync(settings.lovart_skill_path),
      deepseek: {
        enabled: Boolean(settings.deepseek?.enabled),
        api_key_set: Boolean(settings.deepseek?.apiKey),
        api_key_preview: settings.deepseek?.apiKey
          ? `${settings.deepseek.apiKey.slice(0, 4)}••••${settings.deepseek.apiKey.slice(-4)}`
          : "",
        base_url: settings.deepseek?.baseUrl || "https://api.deepseek.com",
        model: settings.deepseek?.model || "deepseek-chat",
      },
      python_command: PYTHON,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readBody(req);
    const settings = saveSettings({
      lovart_access_key: body.lovart_access_key == null ? undefined : String(body.lovart_access_key || "").trim(),
      lovart_secret_key: body.lovart_secret_key == null ? undefined : String(body.lovart_secret_key || "").trim(),
      project_root: body.project_root == null ? undefined : String(body.project_root || "").trim(),
      lovart_skill_path: body.lovart_skill_path == null ? undefined : String(body.lovart_skill_path || "").trim(),
      deepseek: body.deepseek && typeof body.deepseek === "object"
        ? {
            enabled: body.deepseek.enabled,
            apiKey: body.deepseek.api_key == null ? undefined : String(body.deepseek.api_key || "").trim(),
            baseUrl: body.deepseek.base_url == null ? undefined : String(body.deepseek.base_url || "").trim(),
            model: body.deepseek.model == null ? undefined : String(body.deepseek.model || "").trim(),
          }
        : undefined,
    });
    return send(res, 200, {
      ok: true,
      lovart_access_key_set: Boolean(settings.lovart_access_key),
      lovart_secret_key_set: Boolean(settings.lovart_secret_key),
      project_root: settings.project_root,
      lovart_skill_path: settings.lovart_skill_path,
      lovart_skill_exists: fs.existsSync(settings.lovart_skill_path),
      deepseek: {
        enabled: Boolean(settings.deepseek?.enabled),
        api_key_set: Boolean(settings.deepseek?.apiKey),
        api_key_preview: settings.deepseek?.apiKey
          ? `${settings.deepseek.apiKey.slice(0, 4)}••••${settings.deepseek.apiKey.slice(-4)}`
          : "",
        base_url: settings.deepseek?.baseUrl || "https://api.deepseek.com",
        model: settings.deepseek?.model || "deepseek-chat",
      },
      python_command: PYTHON,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/submit") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const targetNode = data.canvas.nodes.find((node) => node.id === body.node_id);
    if (!targetNode || !["imageGen", "videoGen"].includes(targetNode.type)) {
      return send(res, 400, { ok: false, error: "请选择图片生成或视频生成节点。" });
    }
    const kind = targetNode.type === "imageGen" ? "image" : "video";
    const generatorData = normalizeGeneratorData(targetNode.data || {});
    const platform = generatorData.platform;
    const parameters = generatorParameters(generatorData);
    data.jobs = pruneDormantJobsForTarget(data.jobs, targetNode.id);
    if (!body.force_duplicate) {
      const duplicates = activeDuplicateJobs(data.jobs, targetNode.id, { platform, model: parameters.model });
      if (duplicates.length) {
        return send(res, 200, {
          ok: false,
          duplicate_pending: true,
          error: "这条节点已经有进行中的任务了。",
          existing_jobs: duplicates.map((job) => ({
            job_id: job.job_id,
            status: job.status,
            kind: job.kind,
            platform: job.platform || "lovart",
            shot_ids: job.shot_ids || [],
            created_at: job.created_at,
            failure_reason: job.failure_reason || "",
            lovart_thread_id: job.lovart_thread_id,
            jimeng_submit_id: job.jimeng_submit_id,
          })),
        });
      }
    }

    if (!ENABLED_PLATFORMS.has(platform)) {
      return send(res, 400, {
        ok: false,
        error: platform === "jimeng_cli"
          ? "即梦 CLI 还没接入。这一轮先把平台骨架搭好，提交能力稍后再接。"
          : "这个平台当前还不能提交。",
      });
    }
    const collected = collectInputs(data.canvas, [targetNode.id]);
    const hasGlobalControl = data.canvas.edges
      .filter((edge) => edge.target === targetNode.id)
      .some((edge) => data.canvas.nodes.find((node) => node.id === edge.source)?.type === "globalControl");
    if (!hasGlobalControl) {
      return send(res, 400, { ok: false, error: "请先连接至少 1 个全局控制节点，再提交生成任务。" });
    }
    const prompt = [targetNode.data?.prompt, ...collected.promptParts].filter(Boolean).join("\n\n").trim();
    if (!prompt) return send(res, 400, { ok: false, error: "请先连接文本节点，或在生成节点里填写提示词。" });

    const job = {
      job_id: id("job"),
      kind,
      platform,
      target_node_id: targetNode.id,
      shot_ids: targetNode.data?.shot_ids || [],
      prompt,
      input_asset_ids: collected.assetIds,
      input_assets: buildJobInputAssets(data, targetNode, kind, collected),
      common_parameters: generatorData.common_parameters || {},
      platform_parameters: generatorData.platform_parameters || {},
      parameters: generatorParameters(generatorData),
      asset_template_id: targetNode.data?.asset_template_id || undefined,
      asset_template_label: targetNode.data?.asset_template_label || undefined,
      asset_template_filename: targetNode.data?.asset_template_filename || undefined,
      asset_category: targetNode.data?.asset_category || undefined,
      status: "queued",
      queue_reason: "waiting_turn",
      failure_reason: "已进入任务队列，待提交。",
      output_asset_ids: [],
      processed_download_keys: [],
      created_at: now(),
      updated_at: now(),
    };
    if (kind === "video" && targetNode.data?.continuous) {
      job.status = "queued";
      job.queue_reason = "waiting_prev_tail";
      job.failure_reason = `正在等待上一分镜 ${targetNode.data?.expected_prev_shot_id || ""} 的尾帧。`.trim();
    }
    updateAssetLibraryAfterJob(body.project_id, job, { status: job.status, failure_reason: job.failure_reason || "" });
    data.jobs.push(job);
    saveProjectPart(body.project_id, "jobs.json", data.jobs);
    void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
    return send(res, 200, { ok: true, job });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/refresh") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const job = data.jobs.find((item) => item.job_id === body.job_id);
    if (!job) return send(res, 404, { ok: false, error: "找不到任务。" });
    if (job.status === "downloaded" && (job.output_asset_ids || []).length) {
      return send(res, 200, { ok: true, job, assets: [], canvas: data.canvas, asset_library: data.asset_library });
    }

    const result = job.platform === "jimeng_cli"
      ? await refreshDreaminaJob(body.project_id, job, data.canvas)
      : await refreshLovartJob(body.project_id, job, data.canvas);
    const fresh = loadProject(body.project_id);
    const storedJob = fresh.jobs.find((item) => item.job_id === body.job_id);
    if (!result.ok) {
      if (result.pending) {
        storedJob.status = result.status === "pending_confirmation" ? "running" : (result.status || "running");
        storedJob.failure_reason = "";
        storedJob.updated_at = now();
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "running", failure_reason: "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
        return send(res, 200, {
          ok: true,
          pending: true,
          job: storedJob,
          message: result.reason || "平台仍在生成中。",
          canvas: fresh.canvas,
          asset_library: loadProject(body.project_id).asset_library,
        });
      }
      storedJob.status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.status || (result.pending ? "running" : "failed"));
      if (canAutoRetryJimengJob(storedJob, result.reason) && storedJob.status === "failed") {
        queueJimengAutoRetry(storedJob, result.reason);
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "queued", failure_reason: storedJob.failure_reason || "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
        void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
        return send(res, 200, {
          ok: true,
          pending: true,
          auto_retry: true,
          job: storedJob,
          message: storedJob.failure_reason,
          canvas: fresh.canvas,
          asset_library: loadProject(body.project_id).asset_library,
        });
      }
      storedJob.failure_reason = result.reason;
      storedJob.updated_at = now();
      updateAssetLibraryAfterJob(body.project_id, storedJob, { status: storedJob.status === "running" ? "running" : "failed", failure_reason: result.reason || "" });
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: false, job: storedJob, error: result.reason });
    }

    recordProcessedDownloads(storedJob, result.assets);
    const cleanAssets = cleanGeneratedAssets(result.assets);
    if (!cleanAssets.length) {
      storedJob.status = "downloaded";
      storedJob.updated_at = now();
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: true, job: storedJob, assets: [], canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
    }
    fresh.canvas.assets.push(...cleanAssets);
    const anchor = resultAnchorForJob(fresh.canvas, storedJob);
    const resultNodes = placeResultNodes(fresh.canvas, cleanAssets, anchor, storedJob);
    fresh.canvas.nodes.push(...resultNodes);
    connectImageResultsToShotVideo(fresh.canvas, storedJob, resultNodes);
    storedJob.status = "downloaded";
    storedJob.failure_reason = undefined;
    storedJob.output_asset_ids = Array.from(new Set([...(storedJob.output_asset_ids || []), ...cleanAssets.map((asset) => asset.asset_id)]));
    storedJob.updated_at = now();
    attachGeneratedAssetsToTemplate(body.project_id, storedJob, cleanAssets);
    saveProjectPart(body.project_id, "canvas.json", fresh.canvas);
    saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
    if (storedJob.kind === "video") {
      void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
    }
    return send(res, 200, { ok: true, job: storedJob, assets: cleanAssets, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/delete") {
    const body = await readBody(req);
    const result = deleteQueuedJobFromProject(body.project_id, body.job_id);
    if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error || "删除任务失败。" });
    return send(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/requeue-failed") {
    const body = await readBody(req);
    const result = requeueFailedJobFromProject(body.project_id, body.job_id);
    if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error || "重新提交失败。" });
    return send(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/confirm") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const job = data.jobs.find((item) => item.job_id === body.job_id);
    if (!job) return send(res, 404, { ok: false, error: "找不到任务。" });
    if (job.platform === "jimeng_cli") {
      return send(res, 400, { ok: false, error: "即梦任务不需要这一步确认。" });
    }
    if (job.status === "downloaded" && (job.output_asset_ids || []).length) {
      return send(res, 200, { ok: true, job, assets: [], canvas: data.canvas, asset_library: data.asset_library });
    }

    const result = await confirmLovartJob(body.project_id, job);
    const fresh = loadProject(body.project_id);
    const storedJob = fresh.jobs.find((item) => item.job_id === body.job_id);
    if (!result.ok) {
      if (result.pending) {
        storedJob.status = result.status === "pending_confirmation" ? "running" : (result.status || "running");
        storedJob.failure_reason = "已确认，Lovart 正在继续生成。";
        storedJob.pending_confirmation = undefined;
        storedJob.updated_at = now();
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "running", failure_reason: "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
        return send(res, 200, { ok: true, pending: true, job: storedJob, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
      }
      storedJob.status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.status || (result.pending ? "running" : "failed"));
      storedJob.failure_reason = result.reason;
      storedJob.updated_at = now();
      updateAssetLibraryAfterJob(body.project_id, storedJob, { status: storedJob.status === "running" ? "running" : "failed", failure_reason: result.reason || "" });
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: false, job: storedJob, error: result.reason });
    }

    recordProcessedDownloads(storedJob, result.assets);
    const cleanAssets = cleanGeneratedAssets(result.assets);
    if (!cleanAssets.length) {
      storedJob.status = "downloaded";
      storedJob.failure_reason = undefined;
      storedJob.pending_confirmation = undefined;
      storedJob.updated_at = now();
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: true, job: storedJob, assets: [], canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
    }
    fresh.canvas.assets.push(...cleanAssets);
    const anchor = resultAnchorForJob(fresh.canvas, storedJob);
    const resultNodes = placeResultNodes(fresh.canvas, cleanAssets, anchor, storedJob);
    fresh.canvas.nodes.push(...resultNodes);
    connectImageResultsToShotVideo(fresh.canvas, storedJob, resultNodes);
    storedJob.status = "downloaded";
    storedJob.failure_reason = undefined;
    storedJob.pending_confirmation = undefined;
    storedJob.output_asset_ids = Array.from(new Set([...(storedJob.output_asset_ids || []), ...cleanAssets.map((asset) => asset.asset_id)]));
    storedJob.updated_at = now();
    attachGeneratedAssetsToTemplate(body.project_id, storedJob, cleanAssets);
    saveProjectPart(body.project_id, "canvas.json", fresh.canvas);
    saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
    if (storedJob.kind === "video") {
      void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
    }
    return send(res, 200, { ok: true, job: storedJob, assets: cleanAssets, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/reply") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const job = data.jobs.find((item) => item.job_id === body.job_id);
    if (!job) return send(res, 404, { ok: false, error: "找不到任务。" });
    if (job.platform === "jimeng_cli") {
      return send(res, 400, { ok: false, error: "即梦任务暂不需要回复平台交互。" });
    }
    if (job.status === "downloaded" && (job.output_asset_ids || []).length) {
      return send(res, 200, { ok: true, job, assets: [], canvas: data.canvas, asset_library: data.asset_library });
    }

    const replyAt = now();
    job.last_lovart_reply = String(body.message || "").trim();
    job.last_lovart_reply_at = replyAt;
    job.last_lovart_reply_status = "sending";
    job.updated_at = replyAt;
    saveProjectPart(body.project_id, "jobs.json", data.jobs);

    const result = await replyLovartJob(body.project_id, job, body.message);
    const fresh = loadProject(body.project_id);
    const storedJob = fresh.jobs.find((item) => item.job_id === body.job_id);
    storedJob.last_lovart_reply = String(body.message || "").trim();
    storedJob.last_lovart_reply_at = replyAt;
    if (job.lovart_project_id) storedJob.lovart_project_id = job.lovart_project_id;
    if (job.lovart_thread_id) storedJob.lovart_thread_id = job.lovart_thread_id;
    if (!result.ok) {
      if (result.pending) {
        storedJob.last_lovart_reply_status = "sent";
        storedJob.status = result.status || "running";
        storedJob.failure_reason = "";
        storedJob.pending_confirmation = undefined;
        storedJob.updated_at = now();
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "running", failure_reason: "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
        return send(res, 200, { ok: true, pending: true, job: storedJob, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
      }
      storedJob.last_lovart_reply_status = "failed";
      storedJob.status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.status || "failed");
      storedJob.failure_reason = result.reason;
      if (result.pending_confirmation) storedJob.pending_confirmation = result.pending_confirmation;
      storedJob.updated_at = now();
      updateAssetLibraryAfterJob(body.project_id, storedJob, { status: storedJob.status === "running" ? "running" : "failed", failure_reason: result.reason || "" });
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: false, job: storedJob, error: result.reason });
    }

    recordProcessedDownloads(storedJob, result.assets);
    const cleanAssets = cleanGeneratedAssets(result.assets);
    storedJob.last_lovart_reply_status = "sent";
    if (!cleanAssets.length) {
      storedJob.status = "downloaded";
      storedJob.failure_reason = undefined;
      storedJob.pending_confirmation = undefined;
      storedJob.updated_at = now();
      saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      return send(res, 200, { ok: true, job: storedJob, assets: [], canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
    }
    fresh.canvas.assets.push(...cleanAssets);
    const anchor = resultAnchorForJob(fresh.canvas, storedJob);
    const resultNodes = placeResultNodes(fresh.canvas, cleanAssets, anchor, storedJob);
    fresh.canvas.nodes.push(...resultNodes);
    connectImageResultsToShotVideo(fresh.canvas, storedJob, resultNodes);
    storedJob.status = "downloaded";
    storedJob.failure_reason = undefined;
    storedJob.pending_confirmation = undefined;
    storedJob.output_asset_ids = Array.from(new Set([...(storedJob.output_asset_ids || []), ...cleanAssets.map((asset) => asset.asset_id)]));
    storedJob.updated_at = now();
    attachGeneratedAssetsToTemplate(body.project_id, storedJob, cleanAssets);
    saveProjectPart(body.project_id, "canvas.json", fresh.canvas);
    saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
    if (storedJob.kind === "video") {
      void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
    }
    return send(res, 200, { ok: true, job: storedJob, assets: cleanAssets, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/mark-handled") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const job = data.jobs.find((item) => item.job_id === body.job_id);
    if (!job) return send(res, 404, { ok: false, error: "找不到任务。" });
    if (job.status !== "rate_limited") return send(res, 400, { ok: false, error: "只有并发限制任务需要标记已处理。" });
    if (job.platform === "jimeng_cli") return send(res, 400, { ok: false, error: "即梦并发限制不需要手动解除，等已有任务返回后会继续提交。" });
    job.status = "failed";
    job.rate_limit_handled = true;
    job.failure_reason = rateLimitHandledReason(job);
    job.updated_at = now();
    saveProjectPart(body.project_id, "jobs.json", data.jobs);
    return send(res, 200, { ok: true, job });
  }

  send(res, 404, { ok: false, error: "Unknown API" });
}

ensureDir(DEFAULT_PROJECTS_DIR);
ensureDir(loadSettings().project_root);

function createServer() {
  return http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => send(res, 500, { ok: false, error: error.message }));
  } else {
    serveStatic(req, res);
  }
  });
}

function startServer() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`AI video canvas running at http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  assetsFromLovartResult,
  assetTemplateOutputName,
  blockingJobs,
  buildReferencePromptText,
  buildJimengReferencePrompt,
  buildTags,
  canStartQueuedJob,
  cleanGeneratedAssets,
  connectImageResultsToShotVideo,
  createProject,
  defaultPromptFeedbackPresets,
  deleteShotsFromProject,
  deleteQueuedJobFromProject,
  deepSeekHttpErrorMessage,
  extractJsonObject,
  ensureJimengLocalAsset,
  exportProjectReusePackage,
  importProjectReusePackage,
  canAutoRetryJimengJob,
  isJimengFinalGenerationFailure,
  isJimengVipModel,
  jimengQueryTimeoutPendingReason,
  jobBlocksSubmission,
  loadProject,
  mergeCanvasForSave,
  normalizeDeepSeekBaseUrl,
  normalizePromptOptimization,
  placeResultNodes,
  saveScript,
  parseShotlistHtml,
  parseAssetLibraryJsonl,
  parseShots,
  pruneDormantJobsForTarget,
  rateLimitHandledReason,
  recordProcessedDownloads,
  requeueFailedJobFromProject,
  safeName,
  uniquePath,
};
