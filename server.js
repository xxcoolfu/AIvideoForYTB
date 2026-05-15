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
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const ENABLED_PLATFORMS = new Set(["lovart", "jimeng_cli"]);
const PYTHON = process.env.PYTHON || DEFAULT_PYTHON;
const DREAMINA = process.env.DREAMINA || "dreamina";
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
  return {
    lovart_access_key: process.env.LOVART_ACCESS_KEY || settings.lovart_access_key || "",
    lovart_secret_key: process.env.LOVART_SECRET_KEY || settings.lovart_secret_key || "",
    project_root: path.resolve(projectRoot),
    lovart_skill_path: process.env.LOVART_SKILL || settings.lovart_skill_path || DEFAULT_LOVART_SKILL,
  };
}

function saveSettings(next) {
  ensureDir(LOCAL_DIR);
  const current = loadSettings();
  const settings = {
    lovart_access_key: next.lovart_access_key ?? current.lovart_access_key ?? "",
    lovart_secret_key: next.lovart_secret_key ?? current.lovart_secret_key ?? "",
    project_root: path.resolve(next.project_root || current.project_root || DEFAULT_PROJECTS_DIR),
    lovart_skill_path: String(next.lovart_skill_path ?? current.lovart_skill_path ?? DEFAULT_LOVART_SKILL).trim() || DEFAULT_LOVART_SKILL,
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
    asset_library: readJson(path.join(dir, "asset_library.json"), { global_rules: "", templates: [], image_model: "agent-auto" }),
  };
  migrateLovartMeta(projectId, data);
  return data;
}

function saveProjectPart(projectId, fileName, value) {
  const dir = projectDir(projectId);
  ensureDir(dir);
  writeJson(path.join(dir, fileName), value);
}

function saveProjectMeta(projectId, patch) {
  const dir = projectDir(projectId);
  const project = readJson(path.join(dir, "project.json"), {});
  const next = { ...project, ...patch, updated_at: now() };
  writeJson(path.join(dir, "project.json"), next);
  return next;
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
    if (job.rate_limit_handled || /已在 Lovart 平台处理/.test(String(job.failure_reason || ""))) {
      if (job.status === "rate_limited") {
        job.status = "failed";
        jobsChanged = true;
      }
      if (!job.rate_limit_handled) {
        job.rate_limit_handled = true;
        jobsChanged = true;
      }
      if (/并发限制已在 Lovart 平台处理/.test(String(job.failure_reason || ""))) {
        job.failure_reason = "已在 Lovart 平台处理，可重新提交任务。";
        jobsChanged = true;
      }
    }
    if (!job.rate_limit_handled && job.status === "failed" && isConcurrentLimit(job.failure_reason)) {
      job.status = "rate_limited";
      jobsChanged = true;
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
  return Array.from(new Set((String(text || "").match(/@(?:[A-Za-z][A-Za-z0-9_\-·]*|[\p{Script=Han}\p{N}_\-·]+)/gu) || []).map((x) => x.trim())));
}

function extractDurationFromPrompt(text) {
  const match = String(text || "").match(/\[\s*总时长\s*[：:]\s*(\d+)\s*秒\s*\]/);
  return match?.[1] ? `${match[1]}s` : "";
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

function downloadRemoteFile(fileUrl, destWithoutExt) {
  return new Promise((resolve, reject) => {
    const urlObject = new URL(fileUrl);
    const client = urlObject.protocol === "https:" ? https : http;
    const request = client.get(urlObject, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, fileUrl).toString();
        resolve(downloadRemoteFile(redirected, destWithoutExt));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载失败，状态码 ${response.statusCode || "未知"}`));
        return;
      }
      const headerType = String(response.headers["content-type"] || "").split(";")[0].trim();
      const urlExt = path.extname(urlObject.pathname || "");
      const ext = urlExt || extensionFromMime(headerType, ".bin");
      const finalPath = uniquePath(path.dirname(destWithoutExt), `${path.basename(destWithoutExt)}${ext}`);
      const stream = fs.createWriteStream(finalPath);
      response.pipe(stream);
      stream.on("finish", () => {
        stream.close(() => resolve({ filePath: finalPath, contentType: headerType }));
      });
      stream.on("error", (error) => {
        try { fs.unlinkSync(finalPath); } catch {}
        reject(error);
      });
    });
    request.on("error", reject);
  });
}

async function ensureJimengLocalAsset(projectId, asset) {
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

function isConcurrentLimit(message) {
  return /Concurrent task limit|并发|concurrent/i.test(String(message || ""));
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
    if (source.type === "text") promptParts.push(source.data?.text || "");
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
    character_reference: "角色参考",
    scene_reference: "场景参考",
    prop_reference: "道具参考",
    motion_reference: "运动参考",
    reference: "普通参考",
    auto: "自动判断",
  }[role] || "普通参考";
}

function buildNumberedReferenceLabels(inputAssets = []) {
  const counters = {};
  return inputAssets.map((item, index) => {
    const role = item.reference_role || "reference";
    counters[role] = (counters[role] || 0) + 1;
    const identity = item.primary_tag_label || item.asset_name;
    const alias = item.asset_name && item.asset_name !== identity ? ` / ${item.asset_name}` : "";
    const roleText = role === "character_reference"
      ? `角色${counters[role]}参考`
      : role === "scene_reference"
        ? `场景${counters[role]}参考`
        : role === "prop_reference"
          ? `道具${counters[role]}参考`
          : role === "motion_reference"
            ? `运动参考${counters[role]}`
            : role === "reference"
              ? `普通参考${counters[role]}`
              : referenceRoleLabel(role);
    return `附件${index + 1}（${identity}${alias}）= ${roleText}`;
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
      asset_name: asset?.name || input.source_node_title || input.asset_id,
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
    ? "请按上面的附件身份使用参考图，不要忽略附件，也不要混淆角色、场景和道具。"
    : [
        parameters.feature === "first_frame" || inputAssets.some((item) => item.reference_role === "first_frame")
          ? "请严格使用被标记为“首帧参考”的附件作为起始画面。"
          : "",
        "角色参考只用于角色一致性，场景参考只用于空间与布光，道具参考只用于物体细节。",
        "不要混淆各附件用途；若模型无法遵守，请直接说明具体原因。",
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
  }
  return merged;
}

function jimengReferenceName(item = {}) {
  return String(item.primary_tag_label || item.asset_name || "")
    .replace(/^@/, "")
    .trim();
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
    const name = jimengReferenceName(item);
    if (!name) continue;
    if (item.asset?.kind === "image") {
      imageIndex += 1;
      imageLines.push(`@图片${imageIndex}=${name}`);
    } else if (item.asset?.kind === "video") {
      videoIndex += 1;
      videoLines.push(`@视频${videoIndex}=${name}`);
    } else if (item.asset?.kind === "audio") {
      audioIndex += 1;
      audioLines.push(`@音频${audioIndex}=${name}`);
    }
  }
  const lines = [...imageLines, ...videoLines, ...audioLines];
  if (!lines.length) return "";
  const usage = mode === "image2video"
    ? "请按上面的编号理解参考图，其中首帧图就是当前命令里的输入图片。"
    : "请严格按上面的编号理解参考素材，不要混淆它们的身份。";
  return [lines.join("，"), usage].join("\n");
}

async function ensureLovartProject(projectId, env) {
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
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
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
    return { ok: false, reason: parsed.agent_message || parsed.warning || "Lovart 未生成文件。" };
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
  if (job.kind !== "video") {
    return { ok: false, reason: "这轮即梦 CLI 先只接视频节点，图片节点还没接。" };
  }
  const dir = projectDir(projectId);
  const outputDir = path.join(dir, "videos");
  ensureDir(outputDir);
  const logFile = path.join(dir, "logs", `${job.job_id}.log`);
  const mode = String(job.parameters?.mode || "text2video").trim();
  const orderedInputs = jimengOrderedInputs(job, canvas);
  const imageInputs = orderedInputs.filter((item) => item.asset?.kind === "image");
  const videoInputs = orderedInputs.filter((item) => item.asset?.kind === "video");
  const audioInputs = orderedInputs.filter((item) => item.asset?.kind === "audio");

  const args = [mode];
  const referencePrompt = buildJimengReferencePrompt(orderedInputs, mode);
  const prompt = [String(job.prompt || "").trim(), referencePrompt].filter(Boolean).join("\n\n");
  if (prompt) args.push("--prompt", prompt);

  const model = normalizeJimengModel(job.parameters?.model);
  if (model) args.push("--model_version", model);
  const duration = parseDurationSeconds(job.parameters?.duration, 5);
  args.push("--duration", String(duration));
  const videoResolution = String(job.parameters?.video_resolution || "720p").trim();
  if (videoResolution) args.push("--video_resolution", videoResolution);

  if (mode === "text2video") {
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
    const imageAsset = (explicitFirstFrames[0] || imageInputs[0])?.asset || firstJimengImageInput(job, canvas);
    const localImagePath = await ensureJimengLocalAsset(projectId, imageAsset);
    if (!localImagePath || !fs.existsSync(localImagePath)) {
      return { ok: false, reason: "这张图片还没法给即梦使用。先检查 URL 是否还能访问，或改用本地图片。" };
    }
    args.push("--image", localImagePath);
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
    for (const item of imageInputs) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”还没法给即梦使用。先检查这个 URL 是否还能访问，或改用本地文件。` };
      }
      args.push("--image", localPath);
    }
    for (const item of videoInputs) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”还没法给即梦使用。先检查这个 URL 是否还能访问，或改用本地文件。` };
      }
      args.push("--video", localPath);
    }
    for (const item of audioInputs) {
      const localPath = await ensureJimengLocalAsset(projectId, item.asset);
      if (!localPath || !fs.existsSync(localPath)) {
        return { ok: false, reason: `素材“${item.asset.name}”还没法给即梦使用。先检查这个 URL 是否还能访问，或改用本地文件。` };
      }
      args.push("--audio", localPath);
    }
    const ratio = String(job.parameters?.size || "").trim();
    if (ratio) args.push("--ratio", ratio);
  } else {
    return { ok: false, reason: `即梦视频模式暂不支持：${mode}` };
  }

  job.submitted_prompt = prompt;
  job.submitted_command = `${DREAMINA} ${args.join(" ")}`;
  const result = await runCommand(DREAMINA, args, logFile, {}, { timeoutMs: 15000 });
  if (!result.ok) {
    return { ok: false, reason: result.error || "即梦 CLI 调用失败" };
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
  if (genStatus && genStatus !== "querying" && genStatus !== "running") {
    return { ok: false, reason: `即梦提交状态异常：${genStatus}` };
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
      const desiredName = job.asset_template_label
        ? safeName(`${String(job.asset_template_label).replace(/^@/, "")}${suffix}`)
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
  ], logFile, {}, { timeoutMs: 15000 });
  if (!result.ok) {
    return { ok: false, reason: result.error || "即梦结果刷新失败" };
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
    return { ok: false, reason: `即梦任务状态：${genStatus || "未知"}` };
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
    const kind = ext.toLowerCase() === ".mp4" ? "video" : job.kind;
    const suffix = files.length > 1 ? `_${index + 1}` : "";
    const desiredName = job.asset_template_label
      ? safeName(`${String(job.asset_template_label).replace(/^@/, "")}${suffix}`)
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

function blockingJobs(jobs) {
  return (jobs || []).filter((job) => job.status === "rate_limited");
}

function activeDuplicateJobs(jobs, targetNodeId) {
  return (jobs || []).filter((job) => {
    if (job.target_node_id !== targetNodeId) return false;
    if (job.status === "running" || job.status === "queued" || job.status === "pending_confirmation") return true;
    if (job.status === "rate_limited" && !job.rate_limit_handled) return true;
    return false;
  });
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

async function resumeQueuedContinuousJobs(projectId) {
  const data = loadProject(projectId);
  const jobsToStart = [];
  let changed = false;
  for (const job of data.jobs || []) {
    if (job.status !== "queued" || job.queue_reason !== "waiting_prev_tail") continue;
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
    job.status = "running";
    job.failure_reason = "";
    delete job.queue_reason;
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
      storedJob.failure_reason = error.message || "后台提交任务失败。";
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
    return { ok: false, reason: parsed.agent_message || parsed.warning || "Lovart 未生成文件。" };
  }
  const created = assetsFromLovartResult(projectId, job, parsed);
  if (!created.length) return { ok: false, reason: "Lovart 确认完成，但没有下载到本地文件。" };
  return { ok: true, assets: created };
}

async function processLovartJobSubmission(projectId, jobId) {
  const data = loadProject(projectId);
  const job = data.jobs.find((item) => item.job_id === jobId);
  if (!job) return;
  const targetNode = data.canvas.nodes.find((node) => node.id === job.target_node_id) || null;
  const result = job.platform === "jimeng_cli"
    ? await runJimengJob(projectId, job, data.canvas)
    : await runLovartJob(projectId, job, data.canvas);
  const fresh = loadProject(projectId);
  const storedJob = fresh.jobs.find((item) => item.job_id === jobId);
  if (!storedJob) return;
  if (result.lovart_project_id) storedJob.lovart_project_id = result.lovart_project_id;
  if (result.lovart_thread_id) storedJob.lovart_thread_id = result.lovart_thread_id;
  if (result.jimeng_submit_id) storedJob.jimeng_submit_id = result.jimeng_submit_id;
  if (job.submitted_prompt) storedJob.submitted_prompt = job.submitted_prompt;
  if (job.submitted_command) storedJob.submitted_command = job.submitted_command;
  if (!result.ok) {
    const status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.pending ? (result.status || "running") : "failed");
    storedJob.status = status;
    storedJob.failure_reason = status === "running" ? "" : result.reason;
    if (result.pending_confirmation) storedJob.pending_confirmation = result.pending_confirmation;
    storedJob.updated_at = now();
    updateAssetLibraryAfterJob(projectId, storedJob, {
      status: status === "running" ? "running" : "failed",
      failure_reason: status === "running" ? "" : (result.reason || ""),
    });
    saveProjectPart(projectId, "jobs.json", fresh.jobs);
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
  if (storedJob.kind === "video") {
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

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/project-files/")) {
    const parts = decodeURIComponent(url.pathname).split("/");
    const projectId = parts[2];
    const rel = parts.slice(3).join("/");
    const projectPath = path.resolve(projectDir(projectId));
    const file = path.resolve(path.join(projectPath, rel));
    if (!file.startsWith(projectPath) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  }

  const filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  const file = path.normalize(filePath);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || "text/plain; charset=utf-8");
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
      jobs: data.jobs,
      canvas: data.canvas,
      asset_library: data.asset_library,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    return send(res, 200, listProjects());
  }

  if (req.method === "POST" && url.pathname === "/api/canvas/save") {
    const body = await readBody(req);
    saveProjectPart(body.project_id, "canvas.json", body.canvas);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/shots/parse-xlsx") {
    const body = await readBody(req);
    const buffer = Buffer.from(body.base64 || "", "base64");
    if (!buffer.length) return send(res, 400, { ok: false, error: "没有收到 Excel 文件。" });
    const shots = await parseShotsXlsx(buffer, body.project_id, body.seedance_platform || "lovart");
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

  if (req.method === "POST" && url.pathname === "/api/asset-library/import") {
    const body = await readBody(req);
    const source = Buffer.from(body.base64 || "", "base64").toString("utf8");
    if (!source.trim()) return send(res, 400, { ok: false, error: "没有收到资产 Markdown 内容。" });
    const current = loadProject(body.project_id).asset_library || defaultAssetLibrary();
    const assetLibrary = parseAssetLibraryMarkdown(source, current);
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
    const asset = {
      asset_id: id("asset"),
      name: safeName(body.name || assetNameFromUrl(rawUrl)),
      kind: body.kind || assetKindFromUrl(rawUrl),
      source: "input",
      is_library_asset: Boolean(body.is_library_asset),
      asset_category: body.asset_category || undefined,
      asset_template_id: body.asset_template_id || undefined,
      external_url: rawUrl,
      url: rawUrl,
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
    });
    return send(res, 200, {
      ok: true,
      lovart_access_key_set: Boolean(settings.lovart_access_key),
      lovart_secret_key_set: Boolean(settings.lovart_secret_key),
      project_root: settings.project_root,
      lovart_skill_path: settings.lovart_skill_path,
      lovart_skill_exists: fs.existsSync(settings.lovart_skill_path),
      python_command: PYTHON,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/submit") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const blockers = blockingJobs(data.jobs);
    if (blockers.length) {
      return send(res, 200, {
        ok: false,
        blocked: true,
        error: "还有并发限制任务。请先去对应平台处理后再继续提交。",
        blockers: blockers.map((job) => ({
          job_id: job.job_id,
          platform: job.platform || "lovart",
          status: job.status,
          kind: job.kind,
          prompt: job.prompt,
          failure_reason: job.failure_reason,
          lovart_thread_id: job.lovart_thread_id,
        })),
      });
    }
    const targetNode = data.canvas.nodes.find((node) => node.id === body.node_id);
    if (!targetNode || !["imageGen", "videoGen"].includes(targetNode.type)) {
      return send(res, 400, { ok: false, error: "请选择图片生成或视频生成节点。" });
    }
    if (!body.force_duplicate) {
      const duplicates = activeDuplicateJobs(data.jobs, targetNode.id);
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

    const kind = targetNode.type === "imageGen" ? "image" : "video";
    const generatorData = normalizeGeneratorData(targetNode.data || {});
    const platform = generatorData.platform;
    if (platform === "jimeng_cli" && kind !== "video") {
      return send(res, 400, { ok: false, error: "这轮先接即梦视频节点，图片节点后面再接。" });
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
      asset_category: targetNode.data?.asset_category || undefined,
      status: "running",
      failure_reason: undefined,
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
    if (job.status === "queued") {
      void resumeQueuedContinuousJobs(body.project_id).catch(() => {});
    } else {
      void processLovartJobSubmission(body.project_id, job.job_id).catch((error) => {
        const fresh = loadProject(body.project_id);
        const storedJob = fresh.jobs.find((item) => item.job_id === job.job_id);
        if (!storedJob) return;
        storedJob.status = "failed";
        storedJob.failure_reason = error.message || "后台提交任务失败。";
        storedJob.updated_at = now();
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "failed", failure_reason: storedJob.failure_reason || "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
      });
    }
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
      storedJob.status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.pending ? (result.status || "running") : "failed");
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
        storedJob.status = result.status || "running";
        storedJob.failure_reason = "已确认，Lovart 正在继续生成。";
        storedJob.pending_confirmation = undefined;
        storedJob.updated_at = now();
        updateAssetLibraryAfterJob(body.project_id, storedJob, { status: "running", failure_reason: "" });
        saveProjectPart(body.project_id, "jobs.json", fresh.jobs);
        return send(res, 200, { ok: true, pending: true, job: storedJob, canvas: fresh.canvas, asset_library: loadProject(body.project_id).asset_library });
      }
      storedJob.status = isConcurrentLimit(result.reason) ? "rate_limited" : (result.pending ? (result.status || "running") : "failed");
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

  if (req.method === "POST" && url.pathname === "/api/jobs/mark-handled") {
    const body = await readBody(req);
    const data = loadProject(body.project_id);
    const job = data.jobs.find((item) => item.job_id === body.job_id);
    if (!job) return send(res, 404, { ok: false, error: "找不到任务。" });
    if (job.status !== "rate_limited") return send(res, 400, { ok: false, error: "只有并发限制任务需要标记已处理。" });
    job.status = "failed";
    job.rate_limit_handled = true;
    job.failure_reason = "已在 Lovart 平台处理，可重新提交任务。";
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
  buildTags,
  cleanGeneratedAssets,
  connectImageResultsToShotVideo,
  createProject,
  loadProject,
  placeResultNodes,
  parseShots,
  recordProcessedDownloads,
  safeName,
  uniquePath,
};
