const state = {
  projectId: "AI视频项目",
  project: null,
  canvas: { nodes: [], edges: [], assets: [] },
  shots: [],
  tags: [],
  jobs: [],
  assetLibrary: { global_rules: "", templates: [], image_model: "agent-auto" },
  selectedNodeId: null,
  selectedNodeIds: [],
  openShotIds: [],
  openJobIds: [],
  selectedEdgeId: null,
  connectSourceId: null,
  connectSourceIds: [],
  contextConnection: null,
  selectionMode: false,
  marquee: null,
  suppressCanvasClick: false,
  params: null,
  settings: null,
  viewport: { x: 0, y: 0, scale: 1 },
  pan: null,
  nodeDrag: null,
  contextPoint: null,
  previewVideoNodeId: null,
  pendingDeleteAssetId: null,
  pendingDeleteNodeId: null,
  pendingDeleteEdgeId: null,
  pendingForceSubmitNodeId: null,
  pendingShotImport: null,
  pendingShotConflictIndex: 0,
  pendingTagPickerTagId: null,
  pendingTagPickerSelection: [],
  tagPickerHoverAssetId: null,
  pendingSeedanceImportResolver: null,
  autoRefreshTimer: null,
  autoRefreshingJobId: null,
  syncJobsTimer: null,
  canvasSaveTimer: null,
  canvasDirty: false,
  inspectorEditing: false,
  lastInspectorInputAt: 0,
  jobActionLocks: new Set(),
  bulkSubmit: {
    active: false,
    processing: false,
    queue: [],
    currentJobId: null,
    currentNodeId: null,
    total: 0,
    submitted: 0,
    skipped: 0,
    retryCounts: {},
    retryTimer: null,
  },
  availableProjects: [],
  rightTab: "inspector",
  leftPanelResize: null,
};

const WORKFLOW_PRESETS = {
  premium_story_video: {
    id: "premium_story_video",
    label: "精品视频工作流",
    description: "适合角色、场景、道具都要精细控制的流程。新建首帧时分开做图片和视频；连续镜头时只建视频节点。",
    summary: ["新建首帧：图片节点 + 视频节点", "接上一尾帧：只建视频节点"],
    applyAllLabel: "应用到全部分镜",
    applySingleLabel: "套用这个工作流",
  },
};

const DEFAULT_WORKFLOW_ID = "premium_story_video";
const GENERATION_PLATFORMS = [
  { value: "lovart", label: "Lovart" },
  { value: "jimeng_cli", label: "即梦 CLI" },
];
const JIMENG_VIDEO_MODES = [
  { value: "text2video", label: "文生视频" },
  { value: "image2video", label: "单图生视频" },
  { value: "multimodal2video", label: "全能参考视频" },
];
const JIMENG_IMAGE_MODES = [
  { value: "text2image", label: "文生图" },
  { value: "image2image", label: "图生图" },
];
const JIMENG_VIDEO_MODELS = {
  text2video: ["seedance2.0fast", "seedance2.0", "seedance2.0fast_vip", "seedance2.0_vip"],
  image2video: ["3.0fast", "3.0", "3.0pro", "3.5pro", "seedance2.0fast", "seedance2.0", "seedance2.0fast_vip", "seedance2.0_vip"],
  multimodal2video: ["seedance2.0fast", "seedance2.0", "seedance2.0fast_vip", "seedance2.0_vip"],
};
const JIMENG_IMAGE_MODELS = {
  text2image: ["5.0", "4.6", "4.5", "4.1", "4.0", "3.1", "3.0"],
  image2image: ["5.0", "4.6", "4.5", "4.1", "4.0"],
};
const SHOT_SEEDANCE_PLATFORM_KEY = "ai-video-seedance-platform";
const LEFT_PANEL_WIDTH_KEY = "ai-video-left-panel-width";
const LAST_PROJECT_KEY = "ai-video-last-project-id";
const CANVAS_DRAFT_PREFIX = "ai-video-canvas-draft:";
const CANVAS_MIN_SCALE = 0.1;
const CANVAS_MAX_SCALE = 2.5;
const CONTEXT_NODE_GAP = 90;
const BULK_SUBMIT_LOVART_ACTIVE_LIMIT = 9;

function workflowPreset(workflowId = DEFAULT_WORKFLOW_ID) {
  return WORKFLOW_PRESETS[workflowId] || WORKFLOW_PRESETS[DEFAULT_WORKFLOW_ID];
}

const $ = (selector) => document.querySelector(selector);
const canvasEl = $("#canvas");
const leftResizeHandle = $("#leftResizeHandle");
let worldEl = null;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 160;
const NODE_PORT_Y = 46;

function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setStatus(message, tone = "") {
  const el = $("#status");
  el.textContent = message;
  el.className = tone;
}

function canvasDraftKey(projectId = state.projectId) {
  return `${CANVAS_DRAFT_PREFIX}${projectId}`;
}

function readCanvasDraft(projectId = state.projectId) {
  try {
    const raw = localStorage.getItem(canvasDraftKey(projectId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCanvasDraft(reason = "pending_sync", options = {}) {
  if (!state.projectId || !state.canvas) return;
  const draft = {
    project_id: state.projectId,
    saved_at: new Date().toISOString(),
    reason,
    canvas: state.canvas,
  };
  try {
    localStorage.setItem(canvasDraftKey(state.projectId), JSON.stringify(draft));
    if (options.showNotice || reason === "server_save_failed") {
      renderCanvasDraftNotice(draft);
    }
  } catch (error) {
    setStatus(`本地备份失败：${error.message}`, "bad");
  }
}

function clearCanvasDraft(projectId = state.projectId) {
  localStorage.removeItem(canvasDraftKey(projectId));
  renderCanvasDraftNotice(null);
}

function formatDraftTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function mergeCanvasDraftWithServer(draftCanvas = {}, serverCanvas = {}) {
  const next = JSON.parse(JSON.stringify({
    nodes: Array.isArray(draftCanvas.nodes) ? draftCanvas.nodes : [],
    edges: Array.isArray(draftCanvas.edges) ? draftCanvas.edges : [],
    assets: Array.isArray(draftCanvas.assets) ? draftCanvas.assets : [],
  }));
  const nextAssetIds = new Set(next.assets.map((asset) => asset.asset_id).filter(Boolean));
  const preservedAssets = (serverCanvas.assets || []).filter((asset) => {
    if (!asset.asset_id || nextAssetIds.has(asset.asset_id)) return false;
    return asset.source === "generated" || asset.source_job_id || asset.asset_template_id;
  });
  next.assets.push(...preservedAssets);
  const preservedAssetIds = new Set(preservedAssets.map((asset) => asset.asset_id).filter(Boolean));
  const nextNodeIds = new Set(next.nodes.map((node) => node.id).filter(Boolean));
  const preservedNodes = (serverCanvas.nodes || []).filter((node) => {
    if (!node.id || nextNodeIds.has(node.id)) return false;
    return node.data?.source_job_id || preservedAssetIds.has(node.data?.asset_id);
  });
  next.nodes.push(...preservedNodes);
  preservedNodes.forEach((node) => nextNodeIds.add(node.id));
  const edgeKey = (edge) => `${edge.source || ""}->${edge.target || ""}`;
  const nextEdgeKeys = new Set(next.edges.map(edgeKey));
  for (const edge of serverCanvas.edges || []) {
    if (!edge.source || !edge.target) continue;
    if (!nextNodeIds.has(edge.source) || !nextNodeIds.has(edge.target)) continue;
    const key = edgeKey(edge);
    if (nextEdgeKeys.has(key)) continue;
    next.edges.push(edge);
    nextEdgeKeys.add(key);
  }
  return next;
}

function renderCanvasDraftNotice(draft = readCanvasDraft()) {
  const notice = $("#canvasDraftNotice");
  if (!notice) return;
  if (!draft) {
    notice.hidden = true;
    return;
  }
  const text = $("#canvasDraftText");
  if (text) {
    text.textContent = `有一份未同步的本地画布备份${formatDraftTime(draft.saved_at) ? `（${formatDraftTime(draft.saved_at)}）` : ""}。`;
  }
  notice.hidden = false;
}

async function restoreCanvasDraft(options = {}) {
  const draft = readCanvasDraft();
  if (!draft?.canvas) {
    renderCanvasDraftNotice(null);
    return false;
  }
  state.canvas = mergeCanvasDraftWithServer(draft.canvas, state.canvas);
  state.canvasDirty = true;
  render();
  renderCanvasDraftNotice(draft);
  setStatus("已恢复本地备份，正在同步到项目...", "ok");
  try {
    await saveCanvas({ silent: true });
    setStatus("本地备份已恢复并同步到项目。", "ok");
  } catch (error) {
    setStatus(`本地备份已恢复，但还没同步到项目：${error.message}`, "bad");
  }
  return true;
}

function fitTextareaToContent(textarea) {
  if (!textarea || textarea.tagName !== "TEXTAREA") return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function fitShotPromptTextareas(root = document) {
  root.querySelectorAll(".shot-prompt-textarea").forEach(fitTextareaToContent);
}

function leftPanelWidth() {
  const value = Number(localStorage.getItem(LEFT_PANEL_WIDTH_KEY) || "");
  if (Number.isFinite(value) && value >= 300 && value <= 560) return value;
  return 320;
}

function applyLeftPanelWidth(width) {
  const next = Math.max(300, Math.min(560, Math.round(width)));
  document.documentElement.style.setProperty("--left-panel-width", `${next}px`);
  localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(next));
}

function lastProjectId() {
  return (localStorage.getItem(LAST_PROJECT_KEY) || "").trim();
}

function rememberLastProjectId(projectId) {
  const next = String(projectId || "").trim();
  if (next) localStorage.setItem(LAST_PROJECT_KEY, next);
}

async function initialProjectId() {
  const rememberedProjectId = lastProjectId();
  try {
    const result = await api("/api/projects");
    state.availableProjects = result.projects || [];
    state.settings = { ...(state.settings || {}), project_root: result.project_root };
    if (rememberedProjectId) {
      const exists = state.availableProjects.some((project) => project.project_id === rememberedProjectId);
      if (exists) return rememberedProjectId;
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
    const defaultProject = state.availableProjects.find((project) => project.project_id === state.projectId);
    if (defaultProject) return defaultProject.project_id;
    const recentProject = [...state.availableProjects].sort((a, b) => {
      return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    })[0];
    if (recentProject) return recentProject.project_id;
  } catch (error) {
    if (rememberedProjectId) return rememberedProjectId;
  }
  return state.projectId;
}

function formatTimeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function nodeTitle(node) {
  if (node.type === "text") return node.data.title || "文本";
  if (node.type === "memo") return node.data.title || "备忘录";
  if (node.type === "image") return node.data.title || "图片素材";
  if (node.type === "video") return node.data.title || "视频素材";
  if (node.type === "audio") return node.data.title || "音频素材";
  if (node.type === "imageGen") return node.data.is_asset_generation ? "资产图片生成" : "图片生成节点";
  if (node.type === "videoGen") return "视频生成节点";
  return node.data.title || "节点";
}

function selectedNodeIds() {
  const existingIds = new Set(state.canvas.nodes.map((node) => node.id));
  return Array.from(new Set((state.selectedNodeIds || []).filter((id) => existingIds.has(id))));
}

function selectedNodes() {
  const ids = new Set(selectedNodeIds());
  return state.canvas.nodes.filter((node) => ids.has(node.id));
}

function isGeneratorNode(node) {
  return node && ["imageGen", "videoGen"].includes(node.type);
}

function selectedGeneratorNodes() {
  return selectedNodes().filter(isGeneratorNode);
}

function isNodeSelected(nodeId) {
  return selectedNodeIds().includes(nodeId);
}

function syncSelectionState() {
  const ids = selectedNodeIds();
  state.selectedNodeIds = ids;
  if (ids.length) {
    if (!ids.includes(state.selectedNodeId)) state.selectedNodeId = ids[ids.length - 1];
    state.rightTab = "inspector";
  } else {
    state.selectedNodeId = null;
  }
}

function setSingleNodeSelection(nodeId) {
  state.selectedNodeIds = nodeId ? [nodeId] : [];
  state.selectedNodeId = nodeId || null;
  if (nodeId) state.rightTab = "inspector";
  state.pendingDeleteNodeId = null;
  state.pendingDeleteEdgeId = null;
  state.pendingForceSubmitNodeId = null;
}

function toggleNodeSelection(nodeId) {
  const ids = selectedNodeIds();
  if (ids.includes(nodeId)) {
    state.selectedNodeIds = ids.filter((id) => id !== nodeId);
  } else {
    state.selectedNodeIds = [...ids, nodeId];
  }
  syncSelectionState();
}

function clearNodeSelection() {
  state.selectedNodeIds = [];
  state.selectedNodeId = null;
  state.pendingDeleteNodeId = null;
  state.pendingDeleteEdgeId = null;
  state.pendingForceSubmitNodeId = null;
}

function clearPendingCanvasDelete() {
  state.pendingDeleteNodeId = null;
  state.pendingDeleteEdgeId = null;
}

function bindLeftPanelResize() {
  if (!leftResizeHandle) return;
  leftResizeHandle.addEventListener("pointerdown", (event) => {
    if (document.body.classList.contains("left-collapsed")) return;
    state.leftPanelResize = {
      startX: event.clientX,
      startWidth: leftPanelWidth(),
    };
    document.body.classList.add("resizing-left");
    leftResizeHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  window.addEventListener("pointermove", (event) => {
    if (!state.leftPanelResize) return;
    const delta = event.clientX - state.leftPanelResize.startX;
    applyLeftPanelWidth(state.leftPanelResize.startWidth + delta);
    renderCanvasOnly();
  });
  const stopResize = () => {
    if (!state.leftPanelResize) return;
    state.leftPanelResize = null;
    document.body.classList.remove("resizing-left");
    render();
  };
  window.addEventListener("pointerup", stopResize);
  window.addEventListener("pointercancel", stopResize);
}

function activeConnectSourceIds() {
  if (Array.isArray(state.connectSourceIds) && state.connectSourceIds.length) {
    return state.connectSourceIds.filter((id) => state.canvas.nodes.some((node) => node.id === id));
  }
  return state.connectSourceId ? [state.connectSourceId] : [];
}

function clearConnectSources() {
  state.connectSourceId = null;
  state.connectSourceIds = [];
}

function setConnectSources(nodeIds) {
  const uniqueIds = Array.from(new Set((nodeIds || []).filter(Boolean)));
  state.connectSourceIds = uniqueIds;
  state.connectSourceId = uniqueIds[0] || null;
}

function rememberOpenId(listName, id, open) {
  const current = Array.isArray(state[listName]) ? state[listName] : [];
  state[listName] = open
    ? Array.from(new Set([...current, id]))
    : current.filter((item) => item !== id);
}

function marqueeScreenRect() {
  if (!state.marquee) return null;
  const rect = canvasEl.getBoundingClientRect();
  const { startX, startY, currentX, currentY } = state.marquee;
  return {
    left: Math.min(startX, currentX) - rect.left,
    top: Math.min(startY, currentY) - rect.top,
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

function marqueeWorldRect() {
  if (!state.marquee) return null;
  const start = screenToWorld(state.marquee.startX, state.marquee.startY);
  const end = screenToWorld(state.marquee.currentX, state.marquee.currentY);
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function nodeIntersectsRect(node, rect) {
  const nodeMinX = node.x;
  const nodeMinY = node.y;
  const nodeMaxX = node.x + NODE_WIDTH;
  const nodeMaxY = node.y + NODE_HEIGHT;
  return !(nodeMaxX < rect.minX || nodeMinX > rect.maxX || nodeMaxY < rect.minY || nodeMinY > rect.maxY);
}

function applyMarqueeSelection() {
  const rect = marqueeWorldRect();
  if (!rect) return;
  const pickedIds = state.canvas.nodes.filter((node) => nodeIntersectsRect(node, rect)).map((node) => node.id);
  if (state.marquee?.additive) {
    state.selectedNodeIds = Array.from(new Set([...selectedNodeIds(), ...pickedIds]));
    syncSelectionState();
  } else {
    state.selectedNodeIds = pickedIds;
    syncSelectionState();
  }
  state.selectedEdgeId = null;
}

function selectedNodeBounds() {
  const nodes = selectedNodes();
  if (!nodes.length) return null;
  return {
    minX: Math.min(...nodes.map((node) => node.x)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxX: Math.max(...nodes.map((node) => node.x + NODE_WIDTH)),
    maxY: Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)),
  };
}

async function saveCanvasQuietly(okMessage) {
  try {
    await saveCanvas();
    if (okMessage) setStatus(okMessage, "ok");
  } catch (error) {
    setStatus(error.message, "bad");
  }
}

function toggleSelectionMode(force) {
  state.selectionMode = typeof force === "boolean" ? force : !state.selectionMode;
  setStatus(state.selectionMode ? "框选多选已开启。拖动画布空白处即可框选。" : "框选多选已关闭。", "ok");
  render();
}

function startConnectFromSelection() {
  const selected = selectedNodes();
  if (!selected.length) {
    setStatus("先选择一个作为输出的节点。");
    return;
  }
  const sameTypeSelection = selected.length > 1 && selected.every((node) => node.type === selected[0].type);
  const sourceIds = sameTypeSelection ? selected.map((node) => node.id) : [selectedNode()?.id].filter(Boolean);
  setConnectSources(sourceIds);
  state.selectedEdgeId = null;
  setStatus(sourceIds.length > 1 ? `已选择 ${sourceIds.length} 个同类型输出节点。再点目标节点完成批量连线。` : `已选择输出：${nodeTitle(selectedNode())}。再点目标节点完成连线。`);
  render();
}

function bulkSubmitStateText() {
  const bulk = state.bulkSubmit;
  const pending = bulk.queue.length;
  const active = activeLovartJobCount();
  if (!bulk.active) return "";
  if (bulk.currentJobId) {
    return `批量提交中：已投 ${bulk.submitted}/${bulk.total}，待投 ${pending}，Lovart 活跃 ${active}/${BULK_SUBMIT_LOVART_ACTIVE_LIMIT}`;
  }
  return `批量队列：已投 ${bulk.submitted}/${bulk.total}，待投 ${pending}，Lovart 活跃 ${active}/${BULK_SUBMIT_LOVART_ACTIVE_LIMIT}`;
}

function resetBulkSubmitQueue() {
  if (state.bulkSubmit.retryTimer) {
    clearTimeout(state.bulkSubmit.retryTimer);
  }
  state.bulkSubmit = {
    active: false,
    processing: false,
    queue: [],
    currentJobId: null,
    currentNodeId: null,
    total: 0,
    submitted: 0,
    skipped: 0,
    retryCounts: {},
    retryTimer: null,
  };
}

function stopBulkSubmit(message, tone = "bad") {
  const skippedText = state.bulkSubmit.skipped ? `，跳过 ${state.bulkSubmit.skipped} 条` : "";
  const prefix = message || "批量提交已暂停。";
  resetBulkSubmitQueue();
  renderToolbarState();
  setStatus(`${prefix}${skippedText}`, tone);
}

function activeLovartJobCount() {
  return state.jobs.filter((job) => {
    const platform = job.platform || "lovart";
    if (platform !== "lovart") return false;
    return ["running", "pending_confirmation"].includes(job.status);
  }).length;
}

function rateLimitedJobs() {
  return state.jobs.filter((job) => job.status === "rate_limited" && !job.rate_limit_handled);
}

function hasBulkCapacityForNode(node) {
  const platform = normalizeGeneratorData(node?.data || {}).platform || "lovart";
  if (platform !== "lovart") return true;
  return activeLovartJobCount() < BULK_SUBMIT_LOVART_ACTIVE_LIMIT;
}

function scheduleBulkSubmitRetry(delay = 3000) {
  if (!state.bulkSubmit.active) return;
  if (state.bulkSubmit.retryTimer) clearTimeout(state.bulkSubmit.retryTimer);
  state.bulkSubmit.retryTimer = setTimeout(() => {
    state.bulkSubmit.retryTimer = null;
    processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
  }, delay);
}

async function startBulkSubmitSelected() {
  const nodes = selectedGeneratorNodes();
  if (!nodes.length) {
    setStatus("先选中要批量提交的图片/视频生成节点。", "bad");
    return;
  }
  const existing = new Set([
    ...state.bulkSubmit.queue,
    state.bulkSubmit.currentNodeId,
  ].filter(Boolean));
  const nextIds = nodes.map((node) => node.id).filter((id) => !existing.has(id));
  if (!nextIds.length) {
    setStatus("这些节点已经在批量提交队列里了。", "bad");
    return;
  }
  if (!state.bulkSubmit.active) {
    resetBulkSubmitQueue();
    state.bulkSubmit.active = true;
  }
  state.bulkSubmit.queue.push(...nextIds);
  state.bulkSubmit.total += nextIds.length;
  renderToolbarState();
  setStatus(`已加入 ${nextIds.length} 个生成节点。${bulkSubmitStateText()}`, "ok");
  try {
    await saveCanvas({ silent: true });
  } catch (error) {
    resetBulkSubmitQueue();
    renderToolbarState();
    setStatus(`批量提交没有开始：本地服务连接失败或保存失败。${error.message}`, "bad");
    return;
  }
  processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
}

async function refreshBulkSubmitState() {
  const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
  state.jobs = fresh.jobs;
  state.canvas = fresh.canvas;
  state.project = fresh.project;
  state.assetLibrary = fresh.asset_library || state.assetLibrary;
}

async function markRateLimitedJobsHandledSilently(jobs) {
  for (const job of jobs) {
    await api("/api/jobs/mark-handled", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, job_id: job.job_id }),
    });
  }
  await refreshBulkSubmitState();
}

async function submitBulkNode(nodeId) {
  const result = await api("/api/jobs/submit", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, node_id: nodeId, force_duplicate: false }),
  });
  await refreshBulkSubmitState();
  if (result.ok) {
    if (result.job) upsertJob(result.job);
    state.bulkSubmit.submitted += 1;
    scheduleAutoRefresh();
    return { ok: true, job: result.job };
  }
  if (result.duplicate_pending) {
    state.bulkSubmit.skipped += 1;
    return { ok: false, skipped: true, reason: "已有进行中的任务" };
  }
  if (result.blocked) {
    return { ok: false, blocked: true, reason: result.error || "并发限制任务未处理" };
  }
  throw new Error(result.error || "批量提交失败。");
}

async function processBulkSubmitQueue() {
  const bulk = state.bulkSubmit;
  if (!bulk.active || bulk.processing) return;
  bulk.processing = true;
  let submittedThisPass = 0;
  try {
    await refreshBulkSubmitState();
    if (rateLimitedJobs().length) {
      if (activeLovartJobCount() >= BULK_SUBMIT_LOVART_ACTIVE_LIMIT || runningJobsForAutoRefresh().length) {
        setStatus(`批量提交暂停：Lovart 活跃任务较多，等返图后自动继续。${bulkSubmitStateText()}`, "ok");
        scheduleAutoRefresh();
        scheduleBulkSubmitRetry(12000);
        return;
      }
      await markRateLimitedJobsHandledSilently(rateLimitedJobs());
    }
    while (bulk.queue.length) {
      const nodeId = bulk.queue[0];
      const node = state.canvas.nodes.find((item) => item.id === nodeId);
      if (!node || !isGeneratorNode(node)) {
        bulk.queue.shift();
        bulk.skipped += 1;
        continue;
      }
      if (!hasBulkCapacityForNode(node)) {
        setStatus(`Lovart 已有 ${activeLovartJobCount()} 条活跃任务，批量提交先等返图。${bulkSubmitStateText()}`, "ok");
        scheduleAutoRefresh();
        scheduleBulkSubmitRetry(12000);
        return;
      }
      bulk.currentNodeId = nodeId;
      setStatus(`正在批量提交：${nodeTitle(node)}。${bulkSubmitStateText()}`, "ok");
      const result = await submitBulkNode(nodeId);
      bulk.queue.shift();
      bulk.currentNodeId = null;
      bulk.currentJobId = result.job?.job_id || null;
      if (result.blocked) {
        bulk.queue.unshift(nodeId);
        setStatus(`批量提交遇到并发限制，等返图后自动重试。${bulkSubmitStateText()}`, "ok");
        scheduleAutoRefresh();
        scheduleBulkSubmitRetry(12000);
        return;
      }
      submittedThisPass += result.ok ? 1 : 0;
    }
    const skippedText = bulk.skipped ? `，跳过 ${bulk.skipped} 条已有任务的节点` : "";
    const submittedText = bulk.submitted ? `已提交 ${bulk.submitted} 条` : "没有提交新任务";
    resetBulkSubmitQueue();
    render();
    setStatus(`批量提交完成：${submittedText}${skippedText}。`, "ok");
  } finally {
    bulk.processing = false;
    renderToolbarState();
    if (submittedThisPass) render();
  }
}

function alignSelectedNodes(axis) {
  const nodes = selectedNodes();
  if (nodes.length < 2) {
    setStatus("至少选中两个节点，才能对齐。", "bad");
    return;
  }
  if (axis === "x") {
    const minX = Math.min(...nodes.map((node) => node.x));
    nodes.forEach((node) => { node.x = minX; });
    render();
    saveCanvasQuietly("已左对齐选中节点。");
    return;
  }
  const minY = Math.min(...nodes.map((node) => node.y));
  nodes.forEach((node) => { node.y = minY; });
  render();
  saveCanvasQuietly("已上对齐选中节点。");
}

function distributeSelectedNodes(axis) {
  const nodes = selectedNodes();
  if (nodes.length < 3) {
    setStatus("至少选中三个节点，才能分布。", "bad");
    return;
  }
  const sorted = [...nodes].sort((a, b) => axis === "x" ? a.x - b.x : a.y - b.y);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalRange = axis === "x" ? last.x - first.x : last.y - first.y;
  if (totalRange <= 0) {
    setStatus(axis === "x" ? "横向位置还一样，暂时没法分布。" : "纵向位置还一样，暂时没法分布。", "bad");
    return;
  }
  const step = totalRange / (sorted.length - 1);
  sorted.forEach((node, index) => {
    if (index === 0 || index === sorted.length - 1) return;
    if (axis === "x") node.x = first.x + step * index;
    else node.y = first.y + step * index;
  });
  render();
  saveCanvasQuietly(axis === "x" ? "已横向分布选中节点。" : "已纵向分布选中节点。");
}

function nodeTypeLabel(type) {
  return {
    text: "提示词输入",
    memo: "项目备忘",
    image: "图片参考",
    video: "视频参考",
    audio: "音频参考",
    imageGen: "生成器",
    videoGen: "生成器",
  }[type] || type;
}

function memoHtmlToText(html) {
  const box = document.createElement("div");
  box.innerHTML = String(html || "");
  return (box.textContent || "").trim();
}

function sanitizeMemoHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowedTags = new Set(["B", "STRONG", "I", "EM", "U", "BR", "DIV", "P", "SPAN", "FONT"]);
  const walk = (node) => {
    [...node.children].forEach((child) => {
      if (!allowedTags.has(child.tagName)) {
        const fragment = document.createDocumentFragment();
        while (child.firstChild) fragment.appendChild(child.firstChild);
        child.replaceWith(fragment);
        return;
      }
      [...child.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (child.tagName === "FONT" && name === "color") return;
        if (child.tagName === "FONT" && name === "size") return;
        if (name === "style") {
          const safeStyles = String(child.getAttribute("style") || "")
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean)
            .filter((item) => /^color\s*:|^font-size\s*:|^font-weight\s*:|^font-style\s*:|^text-decoration\s*:/i.test(item));
          if (safeStyles.length) child.setAttribute("style", safeStyles.join("; "));
          else child.removeAttribute("style");
          return;
        }
        child.removeAttribute(attr.name);
      });
      walk(child);
    });
  };
  walk(template.content);
  return template.innerHTML;
}

function memoPlainPreview(node) {
  return memoHtmlToText(node.data?.html || "").slice(0, 90) || "双击右侧填写复盘内容";
}

function memoLinkedNodes(memoNode) {
  const linkedIds = new Set();
  for (const edge of state.canvas.edges) {
    if (edge.source === memoNode.id) linkedIds.add(edge.target);
    if (edge.target === memoNode.id) linkedIds.add(edge.source);
  }
  linkedIds.delete(memoNode.id);
  return state.canvas.nodes.filter((node) => linkedIds.has(node.id));
}

function formatGeneratorParameters(parameters = {}) {
  const isJimeng = parameters.platform === "jimeng_cli";
  return [
    parameters.model || "",
    parameters.mode ? `模式 ${jimengModeLabel(parameters.mode)}` : "",
    parameters.size ? `画幅 ${parameters.size}` : "",
    parameters.duration ? `时长 ${parameters.duration}` : "",
    parameters.video_resolution ? `分辨率 ${parameters.video_resolution}` : "",
    parameters.resolution_type ? `分辨率 ${parameters.resolution_type}` : "",
    !isJimeng && parameters.feature ? `功能 ${parameters.feature}` : "",
  ].filter(Boolean).join(" · ");
}

function commonParameterSummary(parameters = {}) {
  return [
    parameters.model ? `模型 ${shotModelLabel(parameters.model)}` : "",
    parameters.size ? `画幅 ${parameters.size}` : "",
    parameters.duration ? `时长 ${parameters.duration}` : "",
  ].filter(Boolean).join(" · ");
}

function platformParameterSummary(platform, parameters = {}) {
  if (platform === "jimeng_cli") {
    return [
      parameters.mode ? `模式 ${jimengModeLabel(parameters.mode)}` : "",
      parameters.video_resolution ? `分辨率 ${parameters.video_resolution}` : "",
      parameters.resolution_type ? `分辨率 ${parameters.resolution_type}` : "",
    ].filter(Boolean).join(" · ");
  }
  return [
    parameters.feature ? `功能 ${parameters.feature}` : "",
    parameters.motion_control ? "含动作控制" : "",
    parameters.edit_instruction ? "含编辑要求" : "",
  ].filter(Boolean).join(" · ");
}

function visibleSubmittedCommand(job = {}) {
  const command = String(job.submitted_command || "").trim();
  if (!command) return "";
  if (job.platform === "jimeng_cli") {
    return command.replace(/\s+--download_dir\s+\S+/g, "").trim();
  }
  return command
    .replace(/\s+--json/g, "")
    .replace(/\s+--download/g, "")
    .replace(/\s+--output-dir\s+\S+/g, "")
    .trim();
}

function formatGeneratorParametersFull(parameters = {}) {
  const lines = Object.entries(parameters || {})
    .filter(([key]) => !(parameters.platform === "jimeng_cli" && ["feature", "motion_control", "edit_instruction"].includes(key)))
    .filter(([key]) => !(parameters.platform !== "jimeng_cli" && ["mode", "video_resolution", "resolution_type"].includes(key)))
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      return `${key}: ${text}`;
    });
  return lines.join("\n");
}

function renderAssociatedNodeSummary(node) {
  if (["imageGen", "videoGen"].includes(node.type)) {
    const parameters = generatorParameters(node.data || {});
    const fullParameters = formatGeneratorParametersFull(parameters);
    const prompt = String(node.data?.prompt || "").trim();
    return `
      <div class="hint">类型：${escapeHtml(node.type === "imageGen" ? "图片生成" : "视频生成")}</div>
      <div class="hint">平台：${escapeHtml(platformLabel(node.data?.platform))}</div>
      <div class="hint">参数：${escapeHtml(formatGeneratorParameters(parameters) || "未设置")}</div>
      <label class="field compact generator-field-third">
        <span>完整参数</span>
        <textarea class="review-detail-text" readonly>${escapeHtml(fullParameters || "未设置")}</textarea>
      </label>
      <label class="field compact generator-field-third">
        <span>完整提示词</span>
        <textarea class="review-detail-text" readonly>${escapeHtml(prompt || "无")}</textarea>
      </label>
    `;
  }
  const asset = node.data?.asset_id ? assetById(node.data.asset_id) : null;
  if (asset?.kind === "image" && asset.url) {
    return `<img src="${asset.url}" alt="${escapeHtml(asset.name)}">`;
  }
  if (asset?.kind === "video" && asset.url) {
    return `<video src="${asset.url}" controls></video>`;
  }
  return `<div class="hint">${escapeHtml(nodeTitle(node))}</div>`;
}

function addNode(type, data = {}, position = null, options = {}) {
  const index = state.canvas.nodes.length;
  const point = position || screenToWorld(
    canvasEl.getBoundingClientRect().left + canvasEl.clientWidth / 2 + (index % 3) * 24,
    canvasEl.getBoundingClientRect().top + canvasEl.clientHeight / 2 + Math.floor(index / 3) * 24
  );
  const node = {
    id: uid("node"),
    type,
    x: point.x,
    y: point.y,
    data,
  };
  state.canvas.nodes.push(node);
  setSingleNodeSelection(node.id);
  state.canvasDirty = true;
  scheduleCanvasSave();
  if (options.render !== false) render();
  return node;
}

function defaultNodeData(type) {
  if (type === "text") return { title: "文本", text: "" };
  if (type === "memo") return { title: "备忘录", html: "<div>记录这次尝试、问题和结论。</div>" };
  return {};
}

function isEditingElement(target = document.activeElement) {
  if (!target) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  if (target.isContentEditable) return true;
  if (typeof target.closest === "function" && target.closest("[contenteditable='true']")) return true;
  return false;
}

function addAssetNode(asset) {
  const type = asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? asset.kind : "image";
  addNode(type, { title: asset.name, asset_id: asset.asset_id });
  return selectedNode();
}

function selectedNode() {
  return state.canvas.nodes.find((node) => node.id === state.selectedNodeId);
}

function assetById(assetId) {
  return state.canvas.assets.find((asset) => asset.asset_id === assetId);
}

function tagsFromText(text) {
  const source = String(text || "");
  const refs = new Set();
  for (const match of source.matchAll(/^\s*@([^@\n]{1,120}?)\s+[—–-]\s+/gmu)) {
    const label = String(match[1] || "").replace(/\s+/g, " ").trim();
    if (label) refs.add(`@${label}`);
  }
  for (const token of source.match(/@(?:[A-Za-z][A-Za-z0-9_\-·]*|[\p{Script=Han}\p{N}_\-·]+)/gu) || []) {
    const label = token.trim();
    const isShortPrefix = Array.from(refs).some((fullLabel) => fullLabel !== label && fullLabel.startsWith(`${label} `));
    if (!isShortPrefix) refs.add(label);
  }
  return Array.from(refs);
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasMatchRegex(alias) {
  const escaped = escapeRegex(alias);
  if (/[A-Za-z]/.test(alias)) {
    return new RegExp(`(^|[^@A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, "gu");
  }
  return new RegExp(escaped, "gu");
}

function promptContainsAlias(text, alias) {
  return aliasMatchRegex(alias).test(String(text || ""));
}

function tagRefsForPrompt(prompt, tags = state.tags) {
  const refs = new Set(tagsFromText(prompt));
  const text = String(prompt || "");
  for (const tag of tags || []) {
    const canonical = String(tag.label || "").replace(/^@/, "").trim();
    const aliases = Array.from(new Set([canonical, ...(tag.aliases || [])].map((item) => String(item || "").trim()).filter(Boolean)));
    if (aliases.some((alias) => promptContainsAlias(text, alias))) refs.add(tag.label);
  }
  return Array.from(refs);
}

function firstAvailableModel(kind, preferred) {
  const models = state.params?.[kind]?.models || [];
  return models.includes(preferred) ? preferred : (models[0] || "agent-auto");
}

function getPreferredSeedancePlatform() {
  const value = $("#seedancePlatformPreference")?.value || localStorage.getItem(SHOT_SEEDANCE_PLATFORM_KEY) || "lovart";
  return value === "jimeng_cli" ? "jimeng_cli" : "lovart";
}

function setPreferredSeedancePlatform(value) {
  const next = value === "jimeng_cli" ? "jimeng_cli" : "lovart";
  localStorage.setItem(SHOT_SEEDANCE_PLATFORM_KEY, next);
  const select = $("#seedancePlatformPreference");
  if (select) select.value = next;
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

function isKlingModelName(value) {
  return /kling/i.test(String(value || ""));
}

function isSeedanceModelName(value) {
  return /seedance/i.test(String(value || ""));
}

function mapImportedVideoModel(rawModel, preferredSeedancePlatform = "lovart") {
  const raw = String(rawModel || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase().replace(/\s+/g, "");
  const seedancePlatform = preferredSeedancePlatform === "jimeng_cli" ? "jimeng_cli" : "lovart";
  const seedanceMap = {
    "seedance2.0": { lovart: "generate_video_seedance_v2_0", jimeng_cli: "seedance2.0" },
    "seedance2.0fast": { lovart: "generate_video_seedance_v2_0_fast", jimeng_cli: "seedance2.0fast" },
    "seedance2.0_vip": { lovart: "generate_video_seedance_v2_0", jimeng_cli: "seedance2.0_vip" },
    "seedance2.0fast_vip": { lovart: "generate_video_seedance_v2_0_fast", jimeng_cli: "seedance2.0fast_vip" },
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
  const explicitPlatform = hasExplicitPlatform ? normalizePlatform(rawPlatformText) : "";
  const resolvedSeedancePlatform = explicitPlatform || (preferredSeedancePlatform === "jimeng_cli" ? "jimeng_cli" : "lovart");
  const mappedModel = mapImportedVideoModel(rawModel, resolvedSeedancePlatform);
  if (isKlingModelName(mappedModel)) return { platform: "lovart", video_model: mappedModel };
  if (isSeedanceModelName(mappedModel)) return {
    platform: resolvedSeedancePlatform,
    video_model: mappedModel,
  };
  if (transition === "video_direct" && !mappedModel) {
    const platform = resolvedSeedancePlatform;
    return {
      platform,
      video_model: platform === "jimeng_cli" ? "seedance2.0fast" : "generate_video_seedance_v2_0_fast",
    };
  }
  return { platform: explicitPlatform || normalizePlatform(rawPlatform), video_model: mappedModel };
}

function shotNeedsSeedanceChoice(shot = {}) {
  return shot.transition === "video_direct" || isSeedanceModelName(shot.video_model);
}

function applySeedancePlatformToImportedShots(shots = [], preferredSeedancePlatform = "lovart") {
  return shots.map((shot) => {
    const normalized = normalizeShotPlatformAndModel(
      shot.platform,
      String(shot.video_model || "").trim(),
      shot.transition,
      preferredSeedancePlatform
    );
    return {
      ...shot,
      platform: normalized.platform,
      video_model: normalized.video_model,
      duration: String(shot.duration || extractDurationFromPrompt(shot.video_prompt || "") || "").trim(),
      size: String(shot.size || extractAspectRatioFromPrompt(shot.video_prompt || "") || "").trim(),
    };
  });
}

function closeSeedanceImportModal(choice = null) {
  $("#seedanceImportModal").hidden = true;
  const resolver = state.pendingSeedanceImportResolver;
  state.pendingSeedanceImportResolver = null;
  if (resolver) resolver(choice || getPreferredSeedancePlatform());
}

function chooseSeedancePlatformForImport(shots = []) {
  const relevant = shots.filter((shot) => shotNeedsSeedanceChoice(shot));
  if (!relevant.length) return Promise.resolve(getPreferredSeedancePlatform());
  $("#seedanceImportSummary").textContent = `涉及 ${relevant.length} 条 Seedance / 视频直出分镜。Kling 系列仍会自动走 Lovart。`;
  $("#seedanceImportModal").hidden = false;
  return new Promise((resolve) => {
    state.pendingSeedanceImportResolver = resolve;
  });
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

function defaultImageParameters() {
  const preferredLovartImageModel = firstAvailableModel("image", "generate_image_nano_banana_pro");
  return {
    model: preferredLovartImageModel,
    size: "16:9",
    feature: "auto",
  };
}

function defaultAssetImageParameters(size, model) {
  return {
    model: model || firstAvailableModel("image", "generate_image_nano_banana_pro"),
    size: size || "1:1",
    feature: "auto",
  };
}

function recommendedVideoBehavior(platform, model) {
  const safePlatform = normalizePlatform(platform);
  const safeModel = String(model || "").trim().toLowerCase();
  if (!safeModel) return {};
  if (safePlatform === "jimeng_cli") {
    if (safeModel.includes("seedance")) return { mode: "multimodal2video" };
    return {};
  }
  if (safeModel.includes("kling_v2_6") || safeModel.includes("kling2.6")) return { feature: "first_frame" };
  if (safeModel.includes("kling_v3") || safeModel.includes("kling3")) return { feature: "auto" };
  if (safeModel.includes("seedance")) return { feature: "all_reference" };
  return {};
}

function defaultVideoParameters(shot) {
  const wantsFirstFrame = shot.transition === "new_frame" && Boolean((shot.image_prompt || "").trim());
  const preferredModel = String(shot.video_model || "").trim();
  const platform = normalizePlatform(shot.platform);
  const duration = String(shot.duration || "").trim() || "5s";
  if (platform === "jimeng_cli") {
    const model = preferredModel || "seedance2.0fast";
    const recommended = recommendedVideoBehavior(platform, model);
    return {
      platform,
      model,
      duration,
      size: wantsFirstFrame ? "" : (shot.size || "16:9"),
      mode: recommended.mode || (wantsFirstFrame ? "image2video" : "text2video"),
      video_resolution: "720p",
    };
  }
  const model = firstAvailableModel("video", preferredModel || (wantsFirstFrame ? "generate_video_kling_v2_6" : "generate_video_seedance_v2_0"));
  const recommended = recommendedVideoBehavior(platform, model);
  return {
    platform,
    model,
    duration,
    size: shot.size || "",
    feature: recommended.feature || (wantsFirstFrame ? "first_frame" : "text_to_video"),
  };
}

function transitionLabel(value) {
  return value === "continue_prev_tail" ? "接上一尾帧" : value === "video_direct" ? "视频直出" : "新建首帧";
}

function shotModelLabel(model) {
  if (!model) return "自动";
  const jimengLabels = {
    "5.0": "即梦 5.0",
    "4.6": "即梦 4.6",
    "4.5": "即梦 4.5",
    "4.1": "即梦 4.1",
    "4.0": "即梦 4.0",
    "3.1": "即梦 3.1",
    "seedance2.0fast": "Seedance 2.0 Fast",
    "seedance2.0": "Seedance 2.0",
    "seedance2.0fast_vip": "Seedance 2.0 Fast VIP",
    "seedance2.0_vip": "Seedance 2.0 VIP",
    "3.0fast": "即梦 3.0 Fast",
    "3.0": "即梦 3.0",
    "3.0pro": "即梦 3.0 Pro",
    "3.5pro": "即梦 3.5 Pro",
  };
  if (jimengLabels[model]) return jimengLabels[model];
  return state.params?.model_meta?.[model]?.label || model;
}

function normalizePlatform(value) {
  return GENERATION_PLATFORMS.some((item) => item.value === value) ? value : "lovart";
}

function platformLabel(value) {
  return GENERATION_PLATFORMS.find((item) => item.value === value)?.label || "Lovart";
}

function jimengVideoModeLabel(value) {
  return JIMENG_VIDEO_MODES.find((item) => item.value === value)?.label || "文生视频";
}

function jimengVideoModeOptions(mode) {
  return JIMENG_VIDEO_MODELS[mode] || JIMENG_VIDEO_MODELS.text2video;
}

function jimengImageModeLabel(value) {
  return JIMENG_IMAGE_MODES.find((item) => item.value === value)?.label || "文生图";
}

function jimengImageModeOptions(mode) {
  return JIMENG_IMAGE_MODELS[mode] || JIMENG_IMAGE_MODELS.text2image;
}

function jimengImageResolutionOptions(mode, model) {
  if (mode === "image2image") return ["2k", "4k"];
  return ["3.0", "3.1"].includes(String(model || "").trim()) ? ["1k", "2k"] : ["2k", "4k"];
}

function jimengModeLabel(value) {
  if (JIMENG_VIDEO_MODES.some((item) => item.value === value)) return jimengVideoModeLabel(value);
  if (JIMENG_IMAGE_MODES.some((item) => item.value === value)) return jimengImageModeLabel(value);
  return value || "";
}

function parseDurationNumber(value, fallback = 5) {
  const match = String(value || "").match(/(\d+)/);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDurationValue(value, fallback = "5s") {
  const parsed = parseDurationNumber(value, NaN);
  return Number.isFinite(parsed) ? `${parsed}s` : fallback;
}

function jimengDurationRange(mode, model) {
  const safeMode = mode || "text2video";
  const safeModel = String(model || "").trim();
  if (safeMode === "image2video") {
    if (/^3\.5pro$/i.test(safeModel)) return { min: 4, max: 12 };
    if (/^3\.0(?:fast|pro)?$/i.test(safeModel)) return { min: 3, max: 10 };
  }
  return { min: 4, max: 15 };
}

function lovartDurationRange(model) {
  const safeModel = String(model || "").trim();
  if (/seedance|kling/i.test(safeModel)) return { min: 4, max: 15 };
  return { min: 5, max: 15 };
}

function assetDisplayName(asset) {
  return `${asset.name}${asset.asset_category ? ` · ${asset.asset_category}` : ""}`;
}

function referenceRoleLabel(role) {
  return {
    auto: "自动判断",
    first_frame: "首帧参考",
    character_reference: "角色参考",
    scene_reference: "场景参考",
    prop_reference: "道具参考",
    motion_reference: "运动参考",
    reference: "普通参考",
  }[role] || "普通参考";
}

function buildNumberedReferenceLabels(items = []) {
  const counters = {};
  return items.map((item, index) => {
    const role = item.reference_role || "reference";
    counters[role] = (counters[role] || 0) + 1;
    const identity = item.primary_tag_label || item.asset_name;
    const alias = item.asset_name !== identity ? ` / ${item.asset_name}` : "";
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

function jimengReferenceName(item = {}) {
  return String(item.primary_tag_label || item.asset_name || "")
    .replace(/^@/, "")
    .trim();
}

function buildJimengReferencePrompt(items = [], mode = "") {
  if (!items.length) return "";
  const imageLines = [];
  const videoLines = [];
  const audioLines = [];
  let imageIndex = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  for (const item of items) {
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

function assetTagLabels(assetId) {
  return state.tags
    .filter((tag) => (tag.bound_asset_ids || []).includes(assetId))
    .map((tag) => tag.label);
}

function inferReferenceRoleForNode(node, input, asset, explicitRole = "") {
  if (explicitRole && explicitRole !== "auto") return explicitRole;
  if (asset?.asset_category === "character") return "character_reference";
  if (asset?.asset_category === "scene") return "scene_reference";
  if (asset?.asset_category === "prop") return "prop_reference";
  if (
    node.type === "videoGen"
    && !asset?.is_library_asset
    && asset?.kind === "image"
    && (input.source_shot_role === "frame"
      || input.source_shot_role === "image_result"
      || /分镜.*(图片|静帧)/.test(asset?.name || ""))
  ) return "first_frame";
  return "reference";
}

function normalizeReferenceRoles(items, kind, feature) {
  if (!Array.isArray(items) || !items.length) return items || [];
  if (kind !== "video") return items;
  const next = items.map((item) => ({ ...item }));
  let firstFrameIndexes = next
    .map((item, index) => item.reference_role === "first_frame" ? index : -1)
    .filter((index) => index >= 0);

  if (!firstFrameIndexes.length && feature === "first_frame") {
    const candidateIndexes = next
      .map((item, index) => (!item.asset?.is_library_asset && item.asset?.kind === "image" && /分镜.*(图片|静帧)/.test(item.asset_name || "")) ? index : -1)
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
      const asset = next[index].asset;
      if (asset?.asset_category === "character") next[index].reference_role = "character_reference";
      else if (asset?.asset_category === "scene") next[index].reference_role = "scene_reference";
      else if (asset?.asset_category === "prop") next[index].reference_role = "prop_reference";
      else next[index].reference_role = "reference";
    });
  }
  return next;
}

function libraryAssets() {
  return state.canvas.assets.filter((asset) => asset.is_library_asset);
}

const LEFT_SECTION_KEY = "ai-video-left-sections";

function loadLeftSectionState() {
  try {
    return JSON.parse(localStorage.getItem(LEFT_SECTION_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLeftSectionState(map) {
  localStorage.setItem(LEFT_SECTION_KEY, JSON.stringify(map));
}

function leftSections() {
  return Array.from(document.querySelectorAll(".left-section[data-section-id]"));
}

function setLeftSectionExpanded(section, expanded) {
  section.classList.toggle("collapsed", !expanded);
  const toggle = section.querySelector(".section-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function saveCurrentLeftSectionState() {
  const next = {};
  leftSections().forEach((section) => {
    next[section.dataset.sectionId] = !section.classList.contains("collapsed");
  });
  saveLeftSectionState(next);
}

function markInspectorInteraction() {
  state.lastInspectorInputAt = Date.now();
}

function setInspectorEditing(value) {
  state.inspectorEditing = Boolean(value);
  if (value) markInspectorInteraction();
}

function inspectorRecentlyActive(windowMs = 1500) {
  return state.inspectorEditing || (Date.now() - (state.lastInspectorInputAt || 0) < windowMs);
}

function applyLeftSectionState() {
  const stored = loadLeftSectionState();
  const sections = leftSections();
  const hasStoredState = Object.keys(stored).length > 0;
  const expandedSectionId = hasStoredState
    ? sections.find((section) => Boolean(stored[section.dataset.sectionId]))?.dataset.sectionId
    : "shot-table";
  sections.forEach((section) => {
    setLeftSectionExpanded(section, section.dataset.sectionId === expandedSectionId);
  });
  saveCurrentLeftSectionState();
}

function toggleLeftSection(sectionId) {
  const section = document.querySelector(`.left-section[data-section-id="${sectionId}"]`);
  if (!section) return;
  const nextExpanded = section.classList.contains("collapsed");
  if (nextExpanded) {
    leftSections().forEach((item) => {
      setLeftSectionExpanded(item, item.dataset.sectionId === sectionId);
    });
  } else {
    setLeftSectionExpanded(section, false);
  }
  saveCurrentLeftSectionState();
  if (sectionId === "assets") renderAssets();
}

function ensureLeftSectionExpanded(sectionId) {
  const section = document.querySelector(`.left-section[data-section-id="${sectionId}"]`);
  if (!section || !section.classList.contains("collapsed")) {
    if (sectionId === "assets") renderAssets();
    return;
  }
  toggleLeftSection(sectionId);
}

function scrollToLeftSection(sectionId) {
  const section = document.querySelector(`.left-section[data-section-id="${sectionId}"]`);
  section?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function focusNode(node) {
  if (!node) return;
  const rect = canvasEl.getBoundingClientRect();
  state.viewport.x = rect.width / 2 - (node.x + NODE_WIDTH / 2) * state.viewport.scale;
  state.viewport.y = rect.height / 2 - (node.y + NODE_HEIGHT / 2) * state.viewport.scale;
  setSingleNodeSelection(node.id);
  render();
}

function collectSubmissionInputs(nodeId) {
  const incoming = state.canvas.edges.filter((edge) => edge.target === nodeId);
  const promptParts = [];
  const assetInputs = [];
  const seenAssetIds = new Set();
  for (const edge of incoming) {
    const source = state.canvas.nodes.find((node) => node.id === edge.source);
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
  return {
    promptParts: promptParts.filter(Boolean),
    assetIds: assetInputs.map((item) => item.asset_id),
    assetInputs,
  };
}

function buildSubmissionPreview(node) {
  if (!node || !["imageGen", "videoGen"].includes(node.type)) return null;
  const kind = node.type === "imageGen" ? "image" : "video";
  const params = generatorParameters(node.data || {});
  const collected = collectSubmissionInputs(node.id);
  const promptBase = [node.data?.prompt, ...collected.promptParts].filter(Boolean).join("\n\n").trim();
  let assets = collected.assetInputs.map((input, index) => {
    const asset = assetById(input.asset_id);
    if (!asset) return null;
    const tagLabels = assetTagLabels(input.asset_id);
    const explicitRole = node.data?.asset_roles?.[input.asset_id] || "";
    return {
      ...input,
      order: index + 1,
      asset,
      asset_name: asset.name,
      tag_labels: tagLabels,
      primary_tag_label: tagLabels[0] || "",
      reference_role: inferReferenceRoleForNode(node, input, asset, explicitRole),
    };
  }).filter(Boolean);
  assets = normalizeReferenceRoles(assets, kind, params.feature || "auto");
  const featureText = params.feature && params.feature !== "auto" ? `功能选择: ${params.feature}` : "";
  const motionText = params.motion_control ? `动作控制: ${params.motion_control}` : "";
  const editText = params.edit_instruction ? `编辑要求: ${params.edit_instruction}` : "";
  const parameterText = [
    params.size && params.size !== "agent-auto" ? `画幅比例: ${params.size}` : "",
    params.duration && params.duration !== "agent-auto" ? `视频时长: ${params.duration}` : "",
    featureText,
    motionText,
    editText,
  ].filter(Boolean).join("\n");
  const standardTags = Array.from(new Set(assets.flatMap((item) => item.tag_labels || []).filter(Boolean)));
  const attachmentLines = buildNumberedReferenceLabels(assets);
  const referenceText = assets.length
    ? (
      params.platform === "jimeng_cli"
        ? [
            standardTags.length ? `本任务标准标签名：${standardTags.join("、")}。请优先按这些标签名理解角色、场景和道具。` : "",
            buildJimengReferencePrompt(assets, params.mode || ""),
          ].filter(Boolean).join("\n")
        : [
            standardTags.length ? `本任务标准标签名：${standardTags.join("、")}。请优先按这些标签名理解角色、场景和道具。` : "",
            "参考素材附件说明（提交时会上传成附件）:",
            ...attachmentLines,
            kind === "image"
              ? "请按上面的附件身份使用参考图，不要忽略附件，也不要混淆角色、场景和道具。"
              : [
                  params.feature === "first_frame" || assets.some((item) => item.reference_role === "first_frame")
                    ? "请严格使用被标记为“首帧参考”的附件作为起始画面。"
                    : "",
                  "角色参考只用于角色一致性，场景参考只用于空间与布光，道具参考只用于物体细节。",
                  "不要混淆各附件用途；若模型无法遵守，请直接说明具体原因。",
                ].filter(Boolean).join(" "),
          ].join("\n")
    )
    : "";
  const finalPrompt = [
    promptBase,
    parameterText,
    referenceText,
    kind === "image" ? "任务: 生成图片。" : "任务: 生成视频。",
  ].filter(Boolean).join("\n\n");
  return {
    kind,
    platform: normalizePlatform(node.data?.platform),
    model: params.model || "agent-auto",
    size: params.size || "",
    duration: params.duration || "",
    mode: params.mode || "",
    video_resolution: params.video_resolution || "",
    feature: params.feature || "auto",
    assets,
    promptBase,
    finalPrompt,
  };
}

function renderReferenceAssetFields(node) {
  if (node.type !== "videoGen") return "";
  const preview = buildSubmissionPreview(node);
  if (!preview?.assets?.length) return "";
  const selectedRoles = node.data?.asset_roles || {};
  const needsManualHelp = preview.assets.some((item) => item.reference_role === "reference");
  return `
    <div class="field">
      <span>参考素材设置</span>
      <div class="hint">${needsManualHelp ? "下拉框当前值就是系统判断结果；不对就直接改。" : "下拉框当前值就是系统判断结果。通常不用再改。"}</div>
      <div class="reference-role-list ${needsManualHelp ? "needs-attention" : ""}">
        ${preview.assets.map((item) => `
          <label class="field compact reference-role-item">
            <span>附件${item.order} · ${escapeHtml(item.primary_tag_label || item.asset_name)}</span>
            <select data-asset-role="${item.asset.asset_id}">
              ${[
                ["auto", "自动判断"],
                ["first_frame", "首帧参考"],
                ["character_reference", "角色参考"],
                ["scene_reference", "场景参考"],
                ["prop_reference", "道具参考"],
                ["motion_reference", "运动参考"],
                ["reference", "普通参考"],
              ].map(([value, label]) => {
                const currentValue = selectedRoles[item.asset.asset_id] || item.reference_role || "auto";
                return `<option value="${value}" ${currentValue === value ? "selected" : ""}>${label}</option>`;
              }).join("")}
            </select>
          </label>
        `).join("")}
      </div>
    </div>
  `;
}

function shotBoundAssetIds(shot) {
  const byLabel = new Map(state.tags.map((tag) => [tag.label, tag]));
  const ids = [];
  for (const label of shot.tag_refs || []) {
    const tag = byLabel.get(label);
    if (tag?.bound_asset_ids?.length) ids.push(...tag.bound_asset_ids);
  }
  return Array.from(new Set(ids));
}

function boundAssetIdsForPrompt(prompt) {
  const byLabel = new Map(state.tags.map((tag) => [tag.label, tag]));
  const ids = [];
  for (const label of tagRefsForPrompt(prompt)) {
    const tag = byLabel.get(label);
    if (tag?.bound_asset_ids?.length) ids.push(...tag.bound_asset_ids);
  }
  return Array.from(new Set(ids));
}

function canvasNodeBounds() {
  if (!state.canvas.nodes.length) {
    const center = screenToWorld(
      canvasEl.getBoundingClientRect().left + canvasEl.clientWidth / 2,
      canvasEl.getBoundingClientRect().top + canvasEl.clientHeight / 2
    );
    return { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y };
  }
  return {
    minX: Math.min(...state.canvas.nodes.map((node) => node.x)),
    minY: Math.min(...state.canvas.nodes.map((node) => node.y)),
    maxX: Math.max(...state.canvas.nodes.map((node) => node.x + NODE_WIDTH)),
    maxY: Math.max(...state.canvas.nodes.map((node) => node.y + NODE_HEIGHT)),
  };
}

function renderedNodeBounds() {
  if (!worldEl) return null;
  const nodeEls = Array.from(worldEl.querySelectorAll(".node[data-id]"));
  if (!nodeEls.length) return null;
  const byId = new Map(state.canvas.nodes.map((node) => [node.id, node]));
  const bounds = nodeEls
    .map((el) => {
      const node = byId.get(el.dataset.id);
      if (!node) return null;
      return {
        minX: node.x,
        minY: node.y,
        maxX: node.x + el.offsetWidth,
        maxY: node.y + el.offsetHeight,
      };
    })
    .filter(Boolean);
  if (!bounds.length) return null;
  return {
    minX: Math.min(...bounds.map((item) => item.minX)),
    minY: Math.min(...bounds.map((item) => item.minY)),
    maxX: Math.max(...bounds.map((item) => item.maxX)),
    maxY: Math.max(...bounds.map((item) => item.maxY)),
  };
}

function findShotNode(shotId, role) {
  return state.canvas.nodes.find((node) => node.data?.shot_id === shotId && node.data?.shot_role === role);
}

function findAssetTemplateNode(templateId) {
  return state.canvas.nodes.find((node) => node.data?.asset_template_id === templateId && node.data?.is_asset_generation);
}

function upsertEdge(source, target) {
  if (!source || !target || source === target) return;
  const exists = state.canvas.edges.some((edge) => edge.source === source && edge.target === target);
  if (!exists) state.canvas.edges.push({ id: uid("edge"), source, target });
}

function ensureAssetNode(assetId, position) {
  const existing = state.canvas.nodes.find((node) => node.data?.asset_id === assetId);
  if (existing) return existing;
  const asset = assetById(assetId);
  if (!asset) return null;
  const type = ["image", "video", "audio"].includes(asset.kind) ? asset.kind : "image";
  const node = {
    id: uid("node"),
    type,
    x: position.x,
    y: position.y,
    data: { title: asset.name, asset_id: asset.asset_id },
  };
  state.canvas.nodes.push(node);
  return node;
}

function upsertShotGeneratorNode(type, shot, role, position, prompt, parameters, title, workflow = workflowPreset()) {
  const existing = findShotNode(shot.shot_id, role);
  const normalizedExisting = normalizeGeneratorData(existing?.data || {});
  const split = splitParametersByPlatform(normalizePlatform(shot.platform), parameters);
  const data = {
    ...(existing?.data || {}),
    title,
    prompt,
    platform: normalizePlatform(shot.platform),
    common_parameters: { ...split.common, ...(normalizedExisting.common_parameters || {}) },
    platform_parameters: {
      ...split.platformSpecific,
      ...(normalizedExisting.platform_parameters || {}),
      [normalizePlatform(shot.platform)]: {
        ...(split.platformSpecific[normalizePlatform(shot.platform)] || {}),
        ...(normalizedExisting.platform_parameters?.[normalizePlatform(shot.platform)] || {}),
      },
    },
    shot_id: shot.shot_id,
    shot_ids: [shot.shot_id],
    shot_role: role,
    workflow_id: workflow.id,
    workflow_label: workflow.label,
  };
  if (existing) {
    existing.type = type;
    existing.data = data;
    return existing;
  }
  const node = {
    id: uid("node"),
    type,
    x: position.x,
    y: position.y,
    data,
  };
  state.canvas.nodes.push(node);
  return node;
}

function upsertAssetTemplateNode(template, position) {
  const existing = findAssetTemplateNode(template.template_id);
  const normalizedExisting = normalizeGeneratorData(existing?.data || {});
  const split = splitParametersByPlatform("lovart", defaultAssetImageParameters(template.default_size, state.assetLibrary.image_model));
  const data = {
    ...(existing?.data || {}),
    title: template.label.replace(/^@/, ""),
    prompt: template.combined_prompt,
    platform: "lovart",
    common_parameters: { ...split.common, ...(normalizedExisting.common_parameters || {}) },
    platform_parameters: {
      ...split.platformSpecific,
      ...(normalizedExisting.platform_parameters || {}),
      lovart: {
        ...(split.platformSpecific.lovart || {}),
        ...(normalizedExisting.platform_parameters?.lovart || {}),
      },
    },
    asset_template_id: template.template_id,
    asset_template_label: template.label,
    asset_template_filename: template.filename || "",
    asset_category: template.category,
    is_asset_generation: true,
    template_status: template.status,
  };
  if (existing) {
    existing.type = "imageGen";
    existing.data = data;
    return existing;
  }
  const node = {
    id: uid("node"),
    type: "imageGen",
    x: position.x,
    y: position.y,
    data,
  };
  state.canvas.nodes.push(node);
  return node;
}

function updateNode(nodeId, patch) {
  const node = state.canvas.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  node.data = { ...node.data, ...patch };
  render();
}

function patchNodeData(nodeId, patch) {
  const node = state.canvas.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  node.data = { ...node.data, ...patch };
  state.canvasDirty = true;
  scheduleCanvasSave();
}

function connectTo(targetId) {
  const sourceIds = activeConnectSourceIds().filter((id) => id !== targetId);
  if (!sourceIds.length) return;
  let created = 0;
  for (const sourceId of sourceIds) {
    const exists = state.canvas.edges.some((edge) => edge.source === sourceId && edge.target === targetId);
    if (!exists) {
      state.canvas.edges.push({ id: uid("edge"), source: sourceId, target: targetId });
      created += 1;
    }
  }
  clearConnectSources();
  state.selectedEdgeId = null;
  setStatus(created > 1 ? `已批量创建 ${created} 条连线。` : "连线已创建。");
  render();
  saveCanvas().catch((error) => setStatus(`连线已创建，但保存失败：${error.message}`, "bad"));
}

async function deleteNode(nodeId = state.selectedNodeId, force = false) {
  if (!nodeId) return;
  if (!force && state.pendingDeleteNodeId !== nodeId) {
    state.pendingDeleteNodeId = nodeId;
    state.pendingDeleteEdgeId = null;
    renderInspector();
    setStatus("再点一次“删除节点”才会真的删除。", "bad");
    return;
  }
  const node = state.canvas.nodes.find((item) => item.id === nodeId);
  clearPendingCanvasDelete();
  state.canvas.nodes = state.canvas.nodes.filter((item) => item.id !== nodeId);
  state.canvas.edges = state.canvas.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
  state.selectedNodeIds = selectedNodeIds().filter((id) => id !== nodeId);
  syncSelectionState();
  clearConnectSources();
  render();
  await saveCanvas();
  setStatus(`已删除节点：${node ? nodeTitle(node) : nodeId}`, "ok");
}

async function deleteEdge(edgeId = state.selectedEdgeId, force = false) {
  if (!edgeId) return;
  if (!force && state.pendingDeleteEdgeId !== edgeId) {
    state.pendingDeleteEdgeId = edgeId;
    state.pendingDeleteNodeId = null;
    renderInspector();
    setStatus("再点一次“删除连线”才会真的删除。", "bad");
    return;
  }
  const before = state.canvas.edges.length;
  clearPendingCanvasDelete();
  state.canvas.edges = state.canvas.edges.filter((edge) => edge.id !== edgeId);
  if (state.canvas.edges.length === before) return;
  state.selectedEdgeId = null;
  clearConnectSources();
  render();
  await saveCanvas();
  setStatus("已删除连线。", "ok");
}

async function deleteAsset(assetId) {
  const asset = assetById(assetId);
  if (!asset) return;
  const data = await api("/api/assets/delete", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, asset_id: assetId }),
  });
  state.canvas = data.canvas;
  state.tags = data.tags;
  state.jobs = data.jobs;
  state.assetLibrary = data.asset_library || state.assetLibrary;
  clearNodeSelection();
  clearConnectSources();
  render();
  setStatus(`已从项目移除资产：${asset.name}`, "ok");
}

async function renameAsset(assetId, name) {
  const data = await api("/api/assets/rename", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, asset_id: assetId, name }),
  });
  state.canvas = data.canvas;
  render();
  setStatus(`资产已改名：${data.asset.name}`, "ok");
}

async function updateAssetMeta(assetId, patch) {
  const data = await api("/api/assets/meta", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, asset_id: assetId, ...patch }),
  });
  state.canvas = data.canvas;
  render();
  setStatus(`已更新资产标记：${data.asset.name}`, "ok");
}

function videoAssetForNode(node) {
  const asset = node?.data?.asset_id ? assetById(node.data.asset_id) : null;
  return asset?.kind === "video" && asset.url ? asset : null;
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频帧读取失败。"));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function loadVideoForFrame(asset, currentTime = null) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = asset.url;
  await waitForVideoEvent(video, "loadedmetadata");
  if (video.readyState < 2) {
    await waitForVideoEvent(video, "loadeddata");
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (currentTime == null) {
    const startTime = Math.max(0, duration - 0.4);
    if (Math.abs(video.currentTime - startTime) > 0.02) {
      video.currentTime = startTime;
      await waitForVideoEvent(video, "seeked");
    }
    try {
      await video.play();
      if (!video.ended) {
        await waitForVideoEvent(video, "ended");
      }
      video.pause();
      return video;
    } catch {
      const fallbackTime = Math.max(0, duration > 0.12 ? duration - 0.01 : duration);
      if (Math.abs(video.currentTime - fallbackTime) > 0.02) {
        video.currentTime = fallbackTime;
        await waitForVideoEvent(video, "seeked");
      }
      return video;
    }
  }
  const targetTime = Math.min(Math.max(0, currentTime), duration || currentTime);
  if (Math.abs(video.currentTime - targetTime) > 0.02) {
    video.currentTime = targetTime;
    await waitForVideoEvent(video, "seeked");
  }
  return video;
}

function frameBase64FromVideo(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("视频还没有可读取画面。");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/png").split(",")[1];
}

function frameNameForNode(node, asset) {
  const shotId = node?.data?.shot_id;
  if (shotId) return `分镜${shotId}_静帧`;
  return `${asset?.name || "视频"}_静帧`;
}

async function saveFrameAsset(node, asset, base64, useFfmpeg = false) {
  const data = await api("/api/assets/frame", {
    method: "POST",
    body: JSON.stringify({
      project_id: state.projectId,
      source_node_id: node.id,
      source_asset_id: asset?.asset_id,
      name: frameNameForNode(node, asset),
      base64,
      use_ffmpeg: useFfmpeg,
    }),
  });
  state.canvas = data.canvas;
  setSingleNodeSelection(data.node.id);
  state.selectedEdgeId = null;
  render();
  await saveCanvas();
  setStatus(`已提取静帧：${data.asset.name}`, "ok");
}

async function captureVideoFrame(nodeId, usePreview = false) {
  const node = state.canvas.nodes.find((item) => item.id === nodeId);
  const asset = videoAssetForNode(node);
  if (!node || !asset) {
    setStatus("先选择一个视频节点。", "bad");
    return;
  }
  setStatus(usePreview ? "正在提取当前预览帧..." : "正在提取视频尾帧...");
  if (!usePreview) {
    await saveFrameAsset(node, asset, "", true);
    return;
  }
  const preview = $("#videoPreviewPlayer");
  const canUsePreview = state.previewVideoNodeId === nodeId && preview?.src;
  const video = canUsePreview ? preview : await loadVideoForFrame(asset);
  const base64 = frameBase64FromVideo(video);
  await saveFrameAsset(node, asset, base64, false);
}

function openVideoPreview(nodeId) {
  const node = state.canvas.nodes.find((item) => item.id === nodeId);
  const asset = videoAssetForNode(node);
  if (!asset) return setStatus("先选择一个视频节点。", "bad");
  state.previewVideoNodeId = nodeId;
  $("#videoPreviewTitle").textContent = asset.name;
  const player = $("#videoPreviewPlayer");
  player.pause();
  player.src = asset.url;
  player.load();
  $("#videoPreviewModal").hidden = false;
  player.onloadedmetadata = () => setStatus("视频预览已加载。", "ok");
  player.onerror = () => setStatus("视频预览加载失败。文件在本地，但播放器没能读取这个视频。", "bad");
}

function closeVideoPreview() {
  const modal = $("#videoPreviewModal");
  const player = $("#videoPreviewPlayer");
  if (player) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  state.previewVideoNodeId = null;
  if (modal) modal.hidden = true;
}

function renderEdges() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("edge-layer");
  const byId = new Map(state.canvas.nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(selectedNodeIds());
  const selectedConnectedNodeIds = new Set();
  if (selectedIds.size) {
    for (const edge of state.canvas.edges) {
      if (selectedIds.has(edge.source)) selectedConnectedNodeIds.add(edge.target);
      if (selectedIds.has(edge.target)) selectedConnectedNodeIds.add(edge.source);
    }
  }
  for (const edge of state.canvas.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const x1 = source.x + NODE_WIDTH;
    const y1 = source.y + NODE_PORT_Y;
    const x2 = target.x;
    const y2 = target.y + NODE_PORT_Y;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mid = Math.max(40, Math.abs(x2 - x1) / 2);
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    const highlighted = edge.id === state.selectedEdgeId || selectedIds.has(edge.source) || selectedIds.has(edge.target);
    path.setAttribute("stroke", highlighted ? "#8ee6a8" : "#667085");
    path.setAttribute("stroke-width", highlighted ? "4" : "2");
    path.dataset.id = edge.id;
    path.classList.add("edge-path");
    if (edge.id === state.selectedEdgeId) path.classList.add("selected");
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      hideContextMenu();
      clearPendingCanvasDelete();
      state.selectedEdgeId = edge.id;
      clearNodeSelection();
      render();
      setStatus("已选择连线，按 Delete 可删除。");
    });
    svg.appendChild(path);
  }
  svg.dataset.connectedNodeIds = Array.from(selectedConnectedNodeIds).join(",");
  return svg;
}

function renderNode(node) {
  const el = document.createElement("div");
  const selectedIds = selectedNodeIds();
  const selectedIdSet = new Set(selectedIds);
  const connectedToSelected = selectedIds.length && !selectedIdSet.has(node.id)
    && state.canvas.edges.some((edge) =>
      (selectedIdSet.has(edge.source) && edge.target === node.id)
      || (selectedIdSet.has(edge.target) && edge.source === node.id)
    );
  el.className = `node ${isNodeSelected(node.id) ? "selected" : ""} ${connectedToSelected ? "connected" : ""}`;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.dataset.id = node.id;

  const asset = node.data.asset_id ? assetById(node.data.asset_id) : null;
  let body = "";
  if (node.type === "text") {
    body = `<div>${escapeHtml((node.data.text || "双击右侧面板填写提示词").slice(0, 90))}</div>`;
  } else if (node.type === "memo") {
    body = `<div class="memo-preview">${escapeHtml(memoPlainPreview(node))}</div>`;
  } else if (asset?.kind === "image" && asset.url) {
    body = `<img src="${asset.url}" alt="${escapeHtml(asset.name)}">`;
  } else if (asset?.kind === "video" && asset.url) {
    const videoName = escapeHtml(asset.name || "视频素材");
    body = `
      <div class="node-video-card">
        <button type="button" class="node-video-surface" data-preview-node="${node.id}" aria-label="预览视频">
          <span class="node-video-format">MP4</span>
          <span class="node-video-play" aria-hidden="true"></span>
        </button>
        <div class="node-video-footer">
          <div class="node-video-name" title="${videoName}">${videoName}</div>
          <button type="button" data-preview-node="${node.id}">预览</button>
        </div>
      </div>
    `;
  } else if (node.type === "imageGen" || node.type === "videoGen") {
    const shot = node.data.asset_template_label
      ? `资产 ${node.data.asset_template_label}`
      : node.data.shot_id
        ? `分镜 ${node.data.shot_id}${node.data.continuous ? " · 连续镜头" : ""}`
        : platformLabel(node.data.platform);
    const prompt = (node.data.prompt || "连接文本和素材后，在右侧提交生成任务。").slice(0, 88);
    body = `<div><strong>${escapeHtml(shot)}</strong><br>${escapeHtml(prompt)}</div>`;
  } else {
    body = `<div>${escapeHtml(asset?.name || "素材节点")}</div>`;
  }

  el.innerHTML = `
    <div class="handle in" title="输入"></div>
    <div class="handle out" title="输出"></div>
    <div class="node-header">
      <strong>${escapeHtml(nodeTitle(node))}</strong>
      <span class="node-type">${escapeHtml(nodeTypeLabel(node.type))}</span>
    </div>
    <div class="node-body">${body}</div>
  `;

  el.addEventListener("click", (event) => {
    event.stopPropagation();
    hideContextMenu();
    if (activeConnectSourceIds().length && !activeConnectSourceIds().includes(node.id)) {
      connectTo(node.id);
    } else if (event.shiftKey || event.metaKey || event.ctrlKey) {
      clearPendingCanvasDelete();
      toggleNodeSelection(node.id);
      state.selectedEdgeId = null;
      render();
    } else {
      clearPendingCanvasDelete();
      setSingleNodeSelection(node.id);
      state.selectedEdgeId = null;
      render();
    }
  });

  el.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".handle")) return;
    if (["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.button !== 0) return;
    if (activeConnectSourceIds().length && !activeConnectSourceIds().includes(node.id)) {
      event.stopPropagation();
      hideContextMenu();
      connectTo(node.id);
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.stopPropagation();
      toggleNodeSelection(node.id);
      state.selectedEdgeId = null;
      render();
      return;
    }
    if (!isNodeSelected(node.id)) setSingleNodeSelection(node.id);
    state.selectedEdgeId = null;
    startDrag(event, node);
  });
  const inputHandle = el.querySelector(".handle.in");
  const outputHandle = el.querySelector(".handle.out");
  const openPortMenu = (event, port) => {
    event.preventDefault();
    event.stopPropagation();
    state.selectionMode = false;
    state.marquee = null;
    renderToolbarState();
    openCanvasContextMenu(event.clientX, event.clientY, nodePortInsertPosition(node, port), { nodeId: node.id, port });
  };
  inputHandle.addEventListener("contextmenu", (event) => openPortMenu(event, "in"));
  outputHandle.addEventListener("contextmenu", (event) => openPortMenu(event, "out"));
  el.querySelectorAll("[data-preview-node]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openVideoPreview(event.currentTarget.dataset.previewNode);
    });
  });
  outputHandle.addEventListener("click", (event) => {
    event.stopPropagation();
    hideContextMenu();
    const selected = selectedNodes();
    const sameTypeSelection = selected.length > 1 && selected.every((item) => item.type === node.type) && selected.some((item) => item.id === node.id);
    const sourceIds = sameTypeSelection ? selected.map((item) => item.id) : [node.id];
    setConnectSources(sourceIds);
    state.selectedEdgeId = null;
    setStatus(sourceIds.length > 1 ? `已选择 ${sourceIds.length} 个同类型输出节点。再点目标节点完成批量连线。` : `已选择输出：${nodeTitle(node)}。再点目标节点完成连线。`);
    render();
  });
  return el;
}

function startDrag(event, node) {
  event.preventDefault();
  state.nodeDrag = { nodeId: node.id };
  const startX = event.clientX;
  const startY = event.clientY;
  const dragNodes = isNodeSelected(node.id) ? selectedNodes() : [node];
  const origins = dragNodes.map((item) => ({ id: item.id, x: item.x, y: item.y }));
  let moved = false;
  const move = (moveEvent) => {
    const deltaX = (moveEvent.clientX - startX) / state.viewport.scale;
    const deltaY = (moveEvent.clientY - startY) / state.viewport.scale;
    moved = moved || Math.abs(moveEvent.clientX - startX) > 2 || Math.abs(moveEvent.clientY - startY) > 2;
    for (const origin of origins) {
      const target = state.canvas.nodes.find((item) => item.id === origin.id);
      if (!target) continue;
      target.x = origin.x + deltaX;
      target.y = origin.y + deltaY;
    }
    renderCanvasOnly();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    state.nodeDrag = null;
    if (moved) {
      state.canvasDirty = true;
      scheduleCanvasSave();
    }
    render();
    scheduleAutoRefresh();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function screenToWorld(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.viewport.x) / state.viewport.scale,
    y: (clientY - rect.top - state.viewport.y) / state.viewport.scale,
  };
}

function worldToScreen(x, y) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: rect.left + state.viewport.x + x * state.viewport.scale,
    y: rect.top + state.viewport.y + y * state.viewport.scale,
  };
}

function findPortAtScreen(clientX, clientY) {
  const tolerance = 18;
  let best = null;
  for (const node of state.canvas.nodes) {
    const ports = [
      { port: "in", ...worldToScreen(node.x, node.y + NODE_PORT_Y) },
      { port: "out", ...worldToScreen(node.x + NODE_WIDTH, node.y + NODE_PORT_Y) },
    ];
    for (const candidate of ports) {
      const distance = Math.hypot(candidate.x - clientX, candidate.y - clientY);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { node, port: candidate.port, distance };
      }
    }
  }
  return best;
}

function nodePortInsertPosition(node, port) {
  return {
    x: port === "in" ? node.x - NODE_WIDTH - CONTEXT_NODE_GAP : node.x + NODE_WIDTH + CONTEXT_NODE_GAP,
    y: node.y,
  };
}

function openCanvasContextMenu(clientX, clientY, worldPoint, connection = null) {
  state.contextPoint = worldPoint;
  state.contextConnection = connection;
  const menu = $("#contextMenu");
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.hidden = false;
}

function addNodeFromContext(type) {
  const connection = state.contextConnection;
  const position = state.contextPoint || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const node = addNode(type, defaultNodeData(type), position, { render: false });
  if (connection) {
    if (connection.port === "out") upsertEdge(connection.nodeId, node.id);
    if (connection.port === "in") upsertEdge(node.id, connection.nodeId);
    state.selectedEdgeId = null;
    clearConnectSources();
  }
  hideContextMenu();
  setStatus(connection ? "节点已添加并自动连线。" : "节点已添加。", "ok");
  render();
  saveCanvas({ silent: true }).catch((error) => setStatus(`节点已添加，但保存失败：${error.message}`, "bad"));
}

function zoomAt(clientX, clientY, direction) {
  const rect = canvasEl.getBoundingClientRect();
  const before = screenToWorld(clientX, clientY);
  const nextScale = Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, state.viewport.scale * (direction > 0 ? 0.9 : 1.1)));
  state.viewport.scale = nextScale;
  state.viewport.x = clientX - rect.left - before.x * nextScale;
  state.viewport.y = clientY - rect.top - before.y * nextScale;
  renderCanvasOnly();
  setStatus(`缩放 ${Math.round(state.viewport.scale * 100)}%`);
}

function applyViewportToBounds(bounds, options = {}) {
  const rect = canvasEl.getBoundingClientRect();
  const {
    padding = 80,
    maxScale = 1.5,
    minScale = 0.04,
    preferScaleOne = false,
  } = options;
  const { minX, minY, maxX, maxY } = bounds;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  let scale = Math.min(maxScale, Math.max(minScale, Math.min((rect.width - padding) / width, (rect.height - padding) / height)));
  if (preferScaleOne) scale = Math.min(1, scale);
  state.viewport.scale = scale;
  state.viewport.x = (rect.width - width * scale) / 2 - minX * scale;
  state.viewport.y = (rect.height - height * scale) / 2 - minY * scale;
}

function fitToNodes(options = {}) {
  if (!state.canvas.nodes.length) {
    state.viewport = { x: 0, y: 0, scale: 1 };
    render();
    if (!options.silent) setStatus("画布已重置。");
    return;
  }
  applyViewportToBounds(renderedNodeBounds() || canvasNodeBounds());
  render();
  if (!options.silent) setStatus(`已适配全部节点，缩放 ${Math.round(state.viewport.scale * 100)}%`);
}

function resetView() {
  if (!state.canvas.nodes.length) {
    state.viewport = { x: 0, y: 0, scale: 1 };
    renderCanvasOnly();
    setStatus("视图已重置。");
    return;
  }
  applyViewportToBounds(renderedNodeBounds() || canvasNodeBounds(), { maxScale: 1, preferScaleOne: true });
  render();
  setStatus("视图已回到默认查看位置。");
}

function beginCanvasPan(event) {
  event.preventDefault();
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    originX: state.viewport.x,
    originY: state.viewport.y,
    moved: false,
  };
}

function hideContextMenu() {
  const menu = $("#contextMenu");
  if (menu) menu.hidden = true;
  state.contextConnection = null;
  state.contextPoint = null;
}

function renderCanvasOnly() {
  canvasEl.innerHTML = "";
  worldEl = document.createElement("div");
  worldEl.className = "world";
  worldEl.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.scale})`;
  worldEl.style.transformOrigin = "0 0";
  worldEl.appendChild(renderEdges());
  for (const node of state.canvas.nodes) worldEl.appendChild(renderNode(node));
  canvasEl.appendChild(worldEl);
  const marquee = marqueeScreenRect();
  if (marquee && marquee.width > 2 && marquee.height > 2) {
    const box = document.createElement("div");
    box.className = "selection-marquee";
    box.style.left = `${marquee.left}px`;
    box.style.top = `${marquee.top}px`;
    box.style.width = `${marquee.width}px`;
    box.style.height = `${marquee.height}px`;
    canvasEl.appendChild(box);
  }
}

function renderToolbarState() {
  const toggle = $("#toggleMarqueeMode");
  if (toggle) toggle.classList.toggle("active", state.selectionMode);
  const selectedCount = selectedNodeIds().length;
  const selectedGeneratorCount = selectedGeneratorNodes().length;
  ["#alignLeft", "#alignTop"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = selectedCount < 2;
  });
  ["#distributeHorizontal", "#distributeVertical"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = selectedCount < 3;
  });
  const bulkButton = $("#bulkSubmitSelected");
  if (bulkButton) {
    bulkButton.disabled = !selectedGeneratorCount || state.bulkSubmit.processing;
    bulkButton.classList.toggle("active", state.bulkSubmit.active);
    bulkButton.textContent = state.bulkSubmit.active
      ? `批量队列 ${state.bulkSubmit.queue.length}`
      : selectedGeneratorCount > 1
        ? `批量提交 ${selectedGeneratorCount}`
        : "批量提交";
  }
  const bulkStatus = $("#bulkSubmitStatus");
  if (bulkStatus) {
    if (state.bulkSubmit.active) {
      bulkStatus.textContent = bulkSubmitStateText();
    } else if (selectedGeneratorCount) {
      bulkStatus.textContent = `已选 ${selectedGeneratorCount} 个生成节点`;
    } else {
      bulkStatus.textContent = activeLovartJobCount() ? `Lovart 活跃 ${activeLovartJobCount()}/${BULK_SUBMIT_LOVART_ACTIVE_LIMIT}` : "";
    }
  }
}

function renderTags() {
  const box = $("#tagList");
  if (!state.tags.length) {
    const shotHint = state.shots.length
      ? `<p class="hint">已导入 ${state.shots.length} 个分镜，暂未发现 @资产 标签。</p>`
      : `<p class="hint">还没有项目标签。导入分镜后会自动汇总。</p>`;
    box.innerHTML = shotHint;
    return;
  }
  const sortedTags = [...state.tags].sort((a, b) => {
    const aBound = (a.bound_asset_ids || []).length ? 1 : 0;
    const bBound = (b.bound_asset_ids || []).length ? 1 : 0;
    if (aBound !== bBound) return aBound - bBound;
    return String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
  });
  const unboundCount = sortedTags.filter((tag) => !(tag.bound_asset_ids || []).length).length;
  box.innerHTML = `
    <div class="tag-summary">
      <span>标签 ${sortedTags.length}</span>
      <span class="${unboundCount ? "bad" : "ok"}">${unboundCount ? `待绑定 ${unboundCount}` : "已全部绑定"}</span>
    </div>
  ` + sortedTags.map((tag) => {
    const boundNames = (tag.bound_asset_ids || []).map((id) => assetById(id)?.name).filter(Boolean);
    const hasBindings = boundNames.length > 0;
    return `
      <details class="tag-card" ${!hasBindings ? "open" : ""}>
        <summary>
          <strong>${escapeHtml(tag.label)}</strong>
          <span class="shot-status-row">
            <span class="shot-status ${hasBindings ? "done" : "blocked"}">${hasBindings ? `已绑 ${boundNames.length}` : "待绑定"}</span>
            <span class="shot-status waiting">分镜 ${escapeHtml(String((tag.referenced_by_shot_ids || []).length))}</span>
          </span>
        </summary>
        <div class="hint">引用分镜：${escapeHtml((tag.referenced_by_shot_ids || []).join(", ") || "无")}</div>
        <div class="hint">${escapeHtml(boundNames.join(", ") || "还没绑定资产")}</div>
        <div class="tag-card-actions">
          <button data-open-tag-picker="${tag.tag_id}">${hasBindings ? "重选资产" : "去绑定资产"}</button>
          <button data-normalize-tag="${tag.tag_id}">统一名字</button>
        </div>
        <label class="field compact">
          <span>别名（逗号分隔）</span>
          <input data-tag-aliases="${tag.tag_id}" value="${escapeHtml((tag.aliases || []).join(", "))}" placeholder="例如：弗兰克, 老弗兰克">
        </label>
      </details>
    `;
  }).join("");

  box.querySelectorAll("[data-open-tag-picker]").forEach((button) => {
    button.addEventListener("click", () => openTagPicker(button.dataset.openTagPicker));
  });
  box.querySelectorAll("[data-tag-aliases]").forEach((input) => {
    const save = async () => {
      const tag = state.tags.find((item) => item.tag_id === input.dataset.tagAliases);
      if (!tag) return;
      tag.aliases = input.value.split(",").map((item) => item.trim()).filter(Boolean);
      await saveShotsAndTagsFromTable({ silent: true });
      setStatus(`${tag.label} 的别名已保存。`, "ok");
    };
    input.addEventListener("blur", save);
    input.addEventListener("change", save);
  });
  box.querySelectorAll("[data-normalize-tag]").forEach((button) => {
    button.addEventListener("click", () => normalizeTagAcrossShots(button.dataset.normalizeTag));
  });
}

function renderTagPickerPreview(asset) {
  const box = $("#tagPickerPreview");
  if (!box) return;
  if (!asset) {
    box.innerHTML = "把鼠标停在资产上预览。";
    return;
  }
  const media = asset.kind === "video"
    ? `<video src="${asset.url}" controls></video>`
    : asset.url
      ? `<img src="${asset.url}" alt="${escapeHtml(asset.name)}">`
      : "";
  box.innerHTML = `
    <strong>${escapeHtml(asset.name)}</strong>
    ${media}
    <div class="hint">${escapeHtml(asset.asset_category || asset.kind || "asset")}</div>
  `;
}

function renderProjectPicker() {
  const rootInput = $("#projectRootInput");
  const list = $("#projectPickerList");
  if (!rootInput || !list) return;
  rootInput.value = state.settings?.project_root || "";
  if (!state.availableProjects.length) {
    list.innerHTML = `<p class="hint">这个目录里还没有项目。直接在右侧输入新项目名称即可。</p>`;
    return;
  }
  list.innerHTML = state.availableProjects.map((project) => `
    <div class="project-picker-item">
      <strong>${escapeHtml(project.name || project.project_id)}</strong>
      <div class="hint">${escapeHtml(project.project_id)}</div>
      <div class="hint">${project.updated_at ? `最近更新：${escapeHtml(formatTimeLabel(project.updated_at))}` : ""}</div>
      <button data-open-project="${escapeHtml(project.project_id)}">打开这个项目</button>
    </div>
  `).join("");
  list.querySelectorAll("[data-open-project]").forEach((button) => {
    button.addEventListener("click", async () => {
      closeProjectPicker();
      await loadProject(button.dataset.openProject);
    });
  });
}

async function openProjectPicker() {
  const result = await api("/api/projects");
  state.availableProjects = result.projects || [];
  state.settings = { ...(state.settings || {}), project_root: result.project_root };
  $("#projectCreateName").value = "";
  $("#projectPickerModal").hidden = false;
  renderProjectPicker();
}

function closeProjectPicker() {
  $("#projectPickerModal").hidden = true;
}

async function createProjectFromPicker() {
  const name = $("#projectCreateName").value.trim();
  if (!name) {
    setStatus("先输入一个新项目名称。", "bad");
    return;
  }
  closeProjectPicker();
  await loadProject(name);
}

function renderTagPicker() {
  const tag = state.tags.find((item) => item.tag_id === state.pendingTagPickerTagId);
  const list = $("#tagPickerList");
  if (!tag || !list) return;
  const assets = libraryAssets();
  $("#tagPickerTitle").textContent = `${tag.label} 绑定资产`;
  if (!assets.length) {
    list.innerHTML = `<p class="hint">还没有标记为“资产”的素材。</p>`;
    renderTagPickerPreview(null);
    return;
  }
  list.innerHTML = assets.map((asset) => `
    <label class="tag-picker-item ${state.pendingTagPickerSelection.includes(asset.asset_id) ? "selected" : ""}" data-hover-asset="${asset.asset_id}">
      ${asset.url ? `<img src="${asset.url}" alt="${escapeHtml(asset.name)}">` : ""}
      <strong>${escapeHtml(asset.name)}</strong>
      <div class="hint">${escapeHtml(asset.asset_category || asset.kind || "asset")}</div>
      <input type="checkbox" data-pick-asset="${asset.asset_id}" ${state.pendingTagPickerSelection.includes(asset.asset_id) ? "checked" : ""}>
    </label>
  `).join("");
  list.querySelectorAll("[data-pick-asset]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const assetId = event.target.dataset.pickAsset;
      if (event.target.checked) {
        state.pendingTagPickerSelection = Array.from(new Set([...state.pendingTagPickerSelection, assetId]));
      } else {
        state.pendingTagPickerSelection = state.pendingTagPickerSelection.filter((id) => id !== assetId);
      }
      renderTagPicker();
    });
  });
  list.querySelectorAll("[data-hover-asset]").forEach((item) => {
    item.addEventListener("mouseenter", () => renderTagPickerPreview(assetById(item.dataset.hoverAsset)));
  });
  renderTagPickerPreview(assetById(state.pendingTagPickerSelection[0]) || assets[0] || null);
}

function openTagPicker(tagId) {
  const tag = state.tags.find((item) => item.tag_id === tagId);
  if (!tag) return;
  state.pendingTagPickerTagId = tagId;
  state.pendingTagPickerSelection = [...(tag.bound_asset_ids || [])].filter((id) => libraryAssets().some((asset) => asset.asset_id === id));
  $("#tagPickerModal").hidden = false;
  renderTagPicker();
}

function closeTagPicker() {
  state.pendingTagPickerTagId = null;
  state.pendingTagPickerSelection = [];
  $("#tagPickerModal").hidden = true;
}

async function saveTagPicker() {
  const tag = state.tags.find((item) => item.tag_id === state.pendingTagPickerTagId);
  if (!tag) return;
  tag.bound_asset_ids = [...state.pendingTagPickerSelection];
  await api("/api/tags/save", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, tags: state.tags }),
  });
  closeTagPicker();
  renderTags();
  setStatus(`${tag.label} 的资产绑定已保存。`, "ok");
}

function renderAssets() {
  const box = $("#assetList");
  if (!box) return;
  const section = $("#assetSection");
  if (section?.classList.contains("collapsed")) {
    box.innerHTML = "";
    return;
  }
  const visibleAssets = state.canvas.assets.filter((asset) => asset.is_library_asset || !["image", "video"].includes(asset.kind));
  if (!visibleAssets.length) {
    box.innerHTML = `<p class="hint">这里现在只显示已标记为资产的图片/视频。导入本地素材会默认进来；其他结果可在节点右侧补标。</p>`;
    return;
  }
  const nodeCountByAsset = new Map();
  for (const node of state.canvas.nodes) {
    const assetId = node.data?.asset_id;
    if (!assetId) continue;
    nodeCountByAsset.set(assetId, (nodeCountByAsset.get(assetId) || 0) + 1);
  }
  const boundCountByAsset = new Map();
  for (const tag of state.tags) {
    for (const assetId of tag.bound_asset_ids || []) {
      boundCountByAsset.set(assetId, (boundCountByAsset.get(assetId) || 0) + 1);
    }
  }
  box.innerHTML = visibleAssets.map((asset) => `
    <div class="asset-card">
      <div class="asset-card-top">
        ${asset.url && asset.kind === "image" ? `<img class="asset-preview-thumb" src="${asset.url}" alt="${escapeHtml(asset.name)}">` : ""}
        <input class="asset-name-input" data-rename-asset="${asset.asset_id}" value="${escapeHtml(asset.name)}" aria-label="资产名称">
        <div class="hint">${escapeHtml(asset.kind)} · 节点 ${nodeCountByAsset.get(asset.asset_id) || 0} · 标签 ${boundCountByAsset.get(asset.asset_id) || 0}</div>
        ${asset.is_library_asset ? `<span class="asset-badge">资产 · ${escapeHtml(asset.asset_category || "other")}</span>` : `<span class="hint">未标记为资产</span>`}
        <div class="asset-meta-controls">
          <button data-toggle-library-asset="${asset.asset_id}">${asset.is_library_asset ? "取消资产标记" : "标记为资产"}</button>
          <select data-asset-category="${asset.asset_id}" ${asset.is_library_asset ? "" : "disabled"}>
            ${["character", "scene", "prop", "other"].map((category) => `<option value="${category}" ${String(asset.asset_category || "other") === category ? "selected" : ""}>${category}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="asset-actions">
        <button data-add-asset-node="${asset.asset_id}">放到画布</button>
        <button data-delete-asset="${asset.asset_id}">${state.pendingDeleteAssetId === asset.asset_id ? "确认删除" : "删除资产"}</button>
      </div>
    </div>
  `).join("");
  box.querySelectorAll("[data-add-asset-node]").forEach((button) => {
    button.addEventListener("click", () => {
      const asset = assetById(button.dataset.addAssetNode);
      if (asset) addAssetNode(asset);
    });
  });
  box.querySelectorAll("[data-delete-asset]").forEach((button) => {
    button.addEventListener("click", () => {
      const assetId = button.dataset.deleteAsset;
      if (state.pendingDeleteAssetId !== assetId) {
        state.pendingDeleteAssetId = assetId;
        renderAssets();
        setStatus("再次点击“确认删除”才会移除资产。", "bad");
        return;
      }
      state.pendingDeleteAssetId = null;
      deleteAsset(assetId);
    });
  });
  box.querySelectorAll("[data-toggle-library-asset]").forEach((button) => {
    button.addEventListener("click", async () => {
      const asset = assetById(button.dataset.toggleLibraryAsset);
      if (!asset) return;
      await updateAssetMeta(asset.asset_id, {
        is_library_asset: !asset.is_library_asset,
        asset_category: asset.asset_category || "other",
      });
    });
  });
  box.querySelectorAll("[data-asset-category]").forEach((select) => {
    select.addEventListener("change", async () => {
      const asset = assetById(select.dataset.assetCategory);
      if (!asset) return;
      await updateAssetMeta(asset.asset_id, {
        is_library_asset: asset.is_library_asset,
        asset_category: select.value,
      });
    });
  });
  box.querySelectorAll("[data-rename-asset]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      const asset = assetById(input.dataset.renameAsset);
      if (asset && input.value.trim() && input.value.trim() !== asset.name) {
        renameAsset(asset.asset_id, input.value.trim());
      } else if (asset) {
        input.value = asset.name;
      }
    });
  });
}

function renderAssetLibrary() {
  const modelSelect = $("#assetLibraryModel");
  if (modelSelect) {
    const models = state.params?.image?.models || ["agent-auto"];
    modelSelect.innerHTML = models.map((model) => {
      const label = model === "agent-auto" ? "自动选择" : (state.params?.model_meta?.[model]?.label || model);
      const selected = (state.assetLibrary.image_model || "agent-auto") === model;
      return `<option value="${escapeHtml(model)}" ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }
  const status = $("#assetLibraryStatus");
  const box = $("#assetLibraryList");
  if (!box) return;
  if (!state.assetLibrary.templates.length) {
    box.innerHTML = `<p class="hint">还没有资产模板。导入固定格式 Markdown 后会在这里列出。</p>`;
    status.textContent = state.assetLibrary.global_rules ? "已导入全局规则，但还没有资产模板。" : "";
    return;
  }
  status.textContent = `已导入 ${state.assetLibrary.templates.length} 个资产模板。`;
  box.innerHTML = state.assetLibrary.templates.map((template) => {
    const node = findAssetTemplateNode(template.template_id);
    const generatedNames = (template.generated_asset_ids || []).map((assetId) => assetById(assetId)?.name).filter(Boolean);
    return `
      <div class="asset-library-card">
        <div class="asset-library-head">
          <div>
            <strong>${escapeHtml(template.label)}</strong>
            <div class="asset-library-meta">
              <span>${escapeHtml(template.category)}</span>
              <span>${escapeHtml(template.default_size)}</span>
              ${template.filename ? `<span>${escapeHtml(template.filename)}</span>` : ""}
              ${template.source_file ? `<span>${escapeHtml(template.source_file)}</span>` : ""}
              <span>${escapeHtml(template.status || "idle")}</span>
            </div>
          </div>
          ${generatedNames.length ? `<span class="asset-badge">${escapeHtml(generatedNames[generatedNames.length - 1])}</span>` : ""}
        </div>
        <label class="field compact">
          <span>资产提示词全文</span>
          <textarea class="library-prompt-view" readonly>${escapeHtml(template.source_body)}</textarea>
        </label>
        ${template.failure_reason ? `<div class="bad">${escapeHtml(template.failure_reason)}</div>` : ""}
        <div class="asset-library-actions">
          <button data-create-template-node="${template.template_id}">${node ? "定位节点" : "创建节点"}</button>
          <button data-submit-template="${template.template_id}" ${node ? "" : "disabled"}>提交生成</button>
        </div>
      </div>
    `;
  }).join("");
  box.querySelectorAll("[data-create-template-node]").forEach((button) => {
    button.addEventListener("click", async () => {
      const template = state.assetLibrary.templates.find((item) => item.template_id === button.dataset.createTemplateNode);
      if (!template) return;
      if (findAssetTemplateNode(template.template_id)) {
        setSingleNodeSelection(findAssetTemplateNode(template.template_id).id);
        render();
        return;
      }
      await createAssetTemplateNodes([template.template_id]);
    });
  });
  box.querySelectorAll("[data-submit-template]").forEach((button) => {
    button.addEventListener("click", async () => {
      const template = state.assetLibrary.templates.find((item) => item.template_id === button.dataset.submitTemplate);
      const node = template ? findAssetTemplateNode(template.template_id) : null;
      if (!node) {
        setStatus("先创建这个资产节点，再提交生成。", "bad");
        return;
      }
      await submitGeneration(node.id);
    });
  });
}

function shotHasResult(shotId, kind) {
  const role = kind === "image" ? "image_result" : "video_result";
  return state.canvas.nodes.some((node) =>
    node.data?.shot_id === shotId
    && node.data?.shot_role === role
    && node.data?.asset_id
  );
}

function latestShotJob(shotId, kind) {
  return state.jobs
    .filter((job) => job.kind === kind && (job.shot_ids || []).includes(shotId))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0];
}

function statusInfoFromJob(job) {
  if (!job) return null;
  if (job.last_lovart_reply_status === "sending") {
    return { label: "回复中", tone: "running", job };
  }
  if (job.status === "running" && job.last_lovart_reply) {
    return { label: "已回复·生成中", tone: "running", job };
  }
  const map = {
    queued: ["等待", "waiting"],
    running: ["生成中", "running"],
    needs_input: ["待回复", "blocked"],
    pending_confirmation: ["待确认", "blocked"],
    rate_limited: ["并发限制", "blocked"],
    failed: ["失败", "failed"],
    completed: ["已完成", "done"],
    downloaded: ["已完成", "done"],
    cancelled: ["已取消", "failed"],
  };
  const [label, tone] = map[job.status] || [job.status || "未知", "waiting"];
  return { label, tone, job };
}

function jobNeedsLovartReply(job) {
  if (!job || job.platform === "jimeng_cli" || !job.lovart_thread_id) return false;
  if (job.status === "needs_input") return true;
  return job.status === "failed" && /你希望如何处理|请选择|请确认|确认此|确认.*生成|是否开始|是否|要继续|继续生成|如何处理|\?|？/i.test(String(job.failure_reason || ""));
}

function jobLooksLikePlanConfirmation(job) {
  return /请确认|确认此|确认.*生成|是否开始/.test(String(job?.failure_reason || ""));
}

function formatJobReplyTime(job) {
  if (!job?.last_lovart_reply_at) return "";
  const date = new Date(job.last_lovart_reply_at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function jobReplyNote(job) {
  if (!job?.last_lovart_reply) return null;
  const time = formatJobReplyTime(job);
  const suffix = `${time ? `${time} · ` : ""}${job.last_lovart_reply}`;
  if (job.last_lovart_reply_status === "sending") {
    return { text: `正在发送给 Lovart：${suffix}`, tone: "pending" };
  }
  if (job.last_lovart_reply_status === "failed") {
    return { text: `回复发送失败：${suffix}`, tone: "bad" };
  }
  if (job.status === "running") {
    return { text: `已发出回复，等待 Lovart 返回：${suffix}`, tone: "pending" };
  }
  return { text: `已回复 Lovart：${suffix}`, tone: "ok" };
}

function shotPartStatus(shot, kind) {
  const prompt = kind === "image" ? shot.image_prompt : shot.video_prompt;
  if (!String(prompt || "").trim()) return { label: "无", tone: "empty" };
  if (shotHasResult(shot.shot_id, kind)) return { label: "已完成", tone: "done" };
  const jobInfo = statusInfoFromJob(latestShotJob(shot.shot_id, kind));
  if (jobInfo) return jobInfo;
  const nodeRole = kind === "image" ? "image" : "video";
  if (findShotNode(shot.shot_id, nodeRole)) return { label: "待提交", tone: "ready" };
  return { label: "未建节点", tone: "waiting" };
}

function renderShotStatusPill(label, info) {
  return `<span class="shot-status ${escapeHtml(info.tone)}">${label}：${escapeHtml(info.label)}</span>`;
}

function shotStatusSummary() {
  const summary = { total: state.shots.length, imageDone: 0, videoDone: 0, failed: 0, running: 0, blocked: 0 };
  for (const shot of state.shots) {
    const image = shotPartStatus(shot, "image");
    const video = shotPartStatus(shot, "video");
    if (image.tone === "done") summary.imageDone += 1;
    if (video.tone === "done") summary.videoDone += 1;
    if (image.tone === "failed" || video.tone === "failed") summary.failed += 1;
    if (image.tone === "running" || video.tone === "running") summary.running += 1;
    if (image.tone === "blocked" || video.tone === "blocked") summary.blocked += 1;
  }
  return summary;
}

function renderShotTable() {
  const box = $("#shotTable");
  if (!state.shots.length) {
    box.innerHTML = `<p class="hint">导入分镜后，这里会显示分镜控制表。</p>`;
    return;
  }
  const summary = shotStatusSummary();
  const availableVideoModels = Array.from(new Set([
    ...(state.params?.video?.models || []).filter((model) => model && model !== "agent-auto"),
    ...Object.values(JIMENG_VIDEO_MODELS).flat(),
  ]));
  box.innerHTML = `
    <div class="shot-summary">
      <span>分镜 ${summary.total}</span>
      <span>图片完成 ${summary.imageDone}</span>
      <span>视频完成 ${summary.videoDone}</span>
      ${summary.running ? `<span>生成中 ${summary.running}</span>` : ""}
      ${summary.blocked ? `<span class="bad">待处理 ${summary.blocked}</span>` : ""}
      ${summary.failed ? `<span class="bad">失败 ${summary.failed}</span>` : ""}
    </div>
  ` + state.shots.map((shot, index) => {
    const imageStatus = shotPartStatus(shot, "image");
    const videoStatus = shotPartStatus(shot, "video");
    return `
    <details class="shot-card" data-shot-detail="${escapeHtml(shot.shot_id)}" ${state.openShotIds.includes(shot.shot_id) ? "open" : ""}>
      <summary>
        <div class="shot-summary-head">
          <div class="shot-title">分镜 ${escapeHtml(shot.shot_id)}</div>
          <div class="shot-status-row">
            ${shot.continuous ? `<span class="shot-status ready">连续镜头</span>` : ""}
            ${renderShotStatusPill("图", imageStatus)}
            ${renderShotStatusPill("视频", videoStatus)}
          </div>
        </div>
      </summary>
      <div class="shot-summary">
        <span>衔接：${escapeHtml(transitionLabel(shot.transition))}</span>
        <span>平台：${escapeHtml(platformLabel(shot.platform))}</span>
        <span>模型：${escapeHtml(shotModelLabel(shot.video_model))}</span>
        ${shot.duration ? `<span>时长：${escapeHtml(shot.duration)}</span>` : ""}
      </div>
      <details class="shot-params">
        <summary>修改分镜参数</summary>
        <div class="shot-inline-fields shot-inline-fields-wide">
        <label class="field"><span>分镜号</span><input data-shot-index="${index}" data-shot-field="shot_id" value="${escapeHtml(shot.shot_id)}"></label>
        <label class="field"><span>衔接方式</span>
          <select data-shot-index="${index}" data-shot-field="transition">
            <option value="new_frame" ${shot.transition === "new_frame" ? "selected" : ""}>新建首帧</option>
            <option value="continue_prev_tail" ${shot.transition === "continue_prev_tail" ? "selected" : ""}>接上一尾帧</option>
            <option value="video_direct" ${shot.transition === "video_direct" ? "selected" : ""}>视频直出</option>
          </select>
        </label>
        <label class="field"><span>平台</span>
          <select data-shot-index="${index}" data-shot-field="platform">
            ${GENERATION_PLATFORMS.map((platform) => `<option value="${platform.value}" ${normalizePlatform(shot.platform) === platform.value ? "selected" : ""}>${escapeHtml(platform.label)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>视频模型</span>
          <select data-shot-index="${index}" data-shot-field="video_model">
            <option value="" ${!shot.video_model ? "selected" : ""}>自动</option>
            ${availableVideoModels.map((model) => `<option value="${escapeHtml(model)}" ${shot.video_model === model ? "selected" : ""}>${escapeHtml(shotModelLabel(model))}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>时长</span><input data-shot-index="${index}" data-shot-field="duration" value="${escapeHtml(shot.duration || "")}" placeholder="例如 10s"></label>
        </div>
      </details>
      <label class="field"><span>图片提示词</span><textarea class="shot-prompt-textarea" data-shot-index="${index}" data-shot-field="image_prompt">${escapeHtml(shot.image_prompt || "")}</textarea></label>
      <label class="field"><span>视频提示词</span><textarea class="shot-prompt-textarea" data-shot-index="${index}" data-shot-field="video_prompt">${escapeHtml(shot.video_prompt || "")}</textarea></label>
      <div class="hint">标签：${escapeHtml((shot.tag_refs || []).join(", ") || "无")}</div>
      <div class="shot-actions">
        <button data-copy-shot="${index}" data-copy-field="image_prompt">复制图片词</button>
        <button data-copy-shot="${index}" data-copy-field="video_prompt">复制视频词</button>
        <button data-create-shot-nodes="${index}">${escapeHtml(workflowPreset().applySingleLabel)}</button>
      </div>
    </details>
  `}).join("");

  box.querySelectorAll("[data-shot-field]").forEach((input) => {
    const applyFieldChange = (event) => {
      const shot = state.shots[Number(input.dataset.shotIndex)];
      shot[input.dataset.shotField] = event.target.value;
      if (input.dataset.shotField === "transition") {
        shot.continuous = event.target.value === "continue_prev_tail";
        if (event.target.value === "video_direct" && !String(shot.video_model || "").trim()) {
          const normalized = normalizeShotPlatformAndModel(shot.platform, "", "video_direct", getPreferredSeedancePlatform());
          shot.platform = normalized.platform;
          shot.video_model = normalized.video_model;
        }
      }
      if (input.dataset.shotField === "video_prompt") {
        shot.duration = extractDurationFromPrompt(event.target.value) || shot.duration || "";
      }
      const normalized = normalizeShotPlatformAndModel(
        shot.platform,
        String(shot.video_model || "").trim(),
        shot.transition,
        getPreferredSeedancePlatform()
      );
      shot.platform = normalized.platform;
      shot.video_model = normalized.video_model;
      const prompt = [shot.image_prompt, shot.video_prompt].filter(Boolean).join("\n\n");
      shot.prompt = prompt;
      shot.tag_refs = tagRefsForPrompt(prompt);
    };
    input.addEventListener("input", (event) => {
      applyFieldChange(event);
      fitTextareaToContent(input);
    });
    input.addEventListener("change", (event) => {
      applyFieldChange(event);
      fitTextareaToContent(input);
    });
    input.addEventListener("blur", saveShotsAndTagsFromTable);
  });
  requestAnimationFrame(() => fitShotPromptTextareas(box));

  box.querySelectorAll("[data-shot-detail]").forEach((detail) => {
    detail.addEventListener("toggle", () => {
      rememberOpenId("openShotIds", detail.dataset.shotDetail, detail.open);
      if (detail.open) requestAnimationFrame(() => fitShotPromptTextareas(detail));
    });
  });

  box.querySelectorAll("[data-copy-shot]").forEach((button) => {
    button.addEventListener("click", async () => {
      const shot = state.shots[Number(button.dataset.copyShot)];
      const text = shot[button.dataset.copyField] || "";
      await navigator.clipboard.writeText(text);
      setStatus("提示词已复制。", "ok");
    });
  });

  box.querySelectorAll("[data-create-shot-nodes]").forEach((button) => {
    button.addEventListener("click", async () => {
      await safeCreateShotNodes([Number(button.dataset.createShotNodes)]);
    });
  });
}

function renderWorkflowList() {
  const box = $("#workflowList");
  if (!box) return;
  const workflow = workflowPreset();
  box.innerHTML = `
    <article class="workflow-card" data-workflow-id="${escapeHtml(workflow.id)}">
      <strong>${escapeHtml(workflow.label)}</strong>
      <p class="hint">${escapeHtml(workflow.description)}</p>
      <div class="workflow-meta">
        ${workflow.summary.map((item) => `<span class="workflow-chip">${escapeHtml(item)}</span>`).join("")}
      </div>
      <div class="workflow-actions">
        <button id="applyDefaultWorkflow">${escapeHtml(workflow.applyAllLabel)}</button>
      </div>
    </article>
  `;
  $("#applyDefaultWorkflow")?.addEventListener("click", () => safeCreateShotNodes([], workflow.id));
}

function rebuildTagsFromShots(previousTags = state.tags) {
  const previous = new Map(previousTags.map((tag) => [tag.label, tag]));
  const refs = new Map();
  for (const shot of state.shots) {
    for (const tag of shot.tag_refs || []) {
      if (!refs.has(tag)) refs.set(tag, []);
      refs.get(tag).push(shot.shot_id);
    }
  }
  return Array.from(refs.entries()).map(([label, shotIds]) => {
    const old = previous.get(label);
    return {
      tag_id: old?.tag_id || uid("tag"),
      label,
      referenced_by_shot_ids: Array.from(new Set(shotIds)),
      bound_asset_ids: old?.bound_asset_ids || [],
      aliases: Array.isArray(old?.aliases) ? old.aliases : [],
    };
  });
}

async function saveShotsAndTagsFromTable(options = {}) {
  const silent = Boolean(options.silent);
  for (const shot of state.shots) {
    shot.image_prompt = normalizeInlineTagSpacing(collapseBrokenAsciiTags(shot.image_prompt || ""));
    shot.video_prompt = normalizeInlineTagSpacing(collapseBrokenAsciiTags(shot.video_prompt || ""));
    shot.duration = extractDurationFromPrompt(shot.video_prompt || "") || String(shot.duration || "").trim();
    const normalized = normalizeShotPlatformAndModel(
      shot.platform,
      String(shot.video_model || "").trim(),
      shot.transition,
      getPreferredSeedancePlatform()
    );
    shot.platform = normalized.platform;
    shot.video_model = normalized.video_model;
    const prompt = [shot.image_prompt, shot.video_prompt].filter(Boolean).join("\n\n");
    shot.prompt = prompt;
    shot.tag_refs = tagRefsForPrompt(prompt);
  }
  state.tags = rebuildTagsFromShots();
  const data = await api("/api/shots/save", {
    method: "POST",
    body: JSON.stringify({
      project_id: state.projectId,
      shots: state.shots,
      tags: state.tags,
      seedance_platform: getPreferredSeedancePlatform(),
    }),
  });
  state.shots = data.shots;
  state.tags = data.tags;
  renderTags();
  renderShotTable();
  if (!silent) setStatus("分镜表和标签已保存。", "ok");
}

function normalizeInlineTagSpacing(text) {
  return String(text || "")
    .replace(/@([A-Za-z][A-Za-z0-9_\-·]*)(?=[\p{Script=Han}])/gu, "@$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([，。！？；：,])/g, "$1");
}

function collapseBrokenAsciiTags(text) {
  return String(text || "").replace(/@([A-Za-z](?:[A-Za-z0-9_\-·]|\s+[A-Za-z0-9_\-·])*)/gu, (match, body) => {
    const collapsed = body.replace(/\s+/g, "");
    return `@${collapsed}`;
  });
}

function replaceAliasesWithTag(text, aliases, label) {
  const canonical = String(label || "").replace(/^@/, "").trim() || label;
  let next = String(text || "");
  for (const alias of [...new Set(aliases.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    next = next.replace(aliasMatchRegex(alias), (...args) => {
      const match = args[0];
      const source = args[args.length - 1];
      const offset = args[args.length - 2];
      const captures = args.slice(1, -2);
      const prefix = captures.length > 1 ? (captures[0] || "") : "";
      const replacementTarget = captures.length > 1 ? (captures[1] || match) : match;
      const prev = source[offset - 1] || "";
      const valueOffset = captures.length > 1 ? offset + prefix.length : offset;
      const after = source[valueOffset + replacementTarget.length] || "";
      if (prev === "@") return match;
      const leading = prev && /[\p{L}\p{N}]/u.test(prev) ? " " : "";
      const trailing = after && /[\p{L}\p{N}]/u.test(after) ? " " : "";
      return `${prefix}${leading}${canonical}${trailing}`;
    });
  }
  return normalizeInlineTagSpacing(next);
}

async function normalizeTagAcrossShots(tagId) {
  const tag = state.tags.find((item) => item.tag_id === tagId);
  if (!tag) return;
  const aliases = (tag.aliases || []).map((item) => item.trim()).filter(Boolean);
  if (!aliases.length) {
    setStatus(`先给 ${tag.label} 填一个别名，再批量替换。`, "bad");
    return;
  }
  let changed = 0;
  for (const shot of state.shots) {
    const nextImage = replaceAliasesWithTag(shot.image_prompt || "", aliases, tag.label);
    const nextVideo = replaceAliasesWithTag(shot.video_prompt || "", aliases, tag.label);
    if (nextImage !== (shot.image_prompt || "") || nextVideo !== (shot.video_prompt || "")) {
      changed += 1;
      shot.image_prompt = nextImage;
      shot.video_prompt = nextVideo;
      const prompt = [shot.image_prompt, shot.video_prompt].filter(Boolean).join("\n\n");
      shot.prompt = prompt;
      shot.tag_refs = tagRefsForPrompt(prompt);
    }
  }
  await saveShotsAndTagsFromTable({ silent: true });
  renderShotTable();
  setStatus(changed ? `${tag.label} 已批量替换 ${changed} 条分镜。` : `${tag.label} 没找到需要替换的内容。`, changed ? "ok" : "");
}

async function importShotsFile(file) {
  const base64 = await fileToBase64(file);
  const isHtml = /\.(html?|xhtml)$/i.test(file.name || "");
  const data = await api(isHtml ? "/api/shots/parse-html" : "/api/shots/parse-xlsx", {
    method: "POST",
    body: JSON.stringify({
      project_id: state.projectId,
      base64,
      seedance_platform: getPreferredSeedancePlatform(),
    }),
  });
  const preferredSeedancePlatform = await chooseSeedancePlatformForImport(data.shots || []);
  setPreferredSeedancePlatform(preferredSeedancePlatform);
  const incoming = applySeedancePlatformToImportedShots(data.shots || [], preferredSeedancePlatform);
  const existingMap = new Map(state.shots.map((shot) => [shot.shot_id, shot]));
  const conflicts = incoming.filter((shot) => existingMap.has(shot.shot_id)).map((next) => ({
    current: existingMap.get(next.shot_id),
    next,
  }));
  const appended = incoming.filter((shot) => !existingMap.has(shot.shot_id));
  if (!conflicts.length) {
    state.shots = [...state.shots, ...incoming];
    await saveShotsAndTagsFromTable();
    $("#shotsImportStatus").textContent = `已从${isHtml ? "网页 HTML" : "Excel"}导入 ${incoming.length} 条分镜。`;
    return;
  }
  state.pendingShotImport = {
    base: [...state.shots],
    appended,
    conflicts,
    decisions: [],
  };
  state.pendingShotConflictIndex = 0;
  $("#shotsImportStatus").textContent = `发现 ${conflicts.length} 条重复分镜，正在逐条确认。`;
  openShotConflict();
}

function renderShotConflict() {
  const payload = state.pendingShotImport;
  if (!payload) return;
  const current = payload.conflicts[state.pendingShotConflictIndex];
  if (!current) return;
  $("#shotConflictBody").innerHTML = `
    <div class="hint">重复分镜 ${escapeHtml(current.current.shot_id)}（${state.pendingShotConflictIndex + 1}/${payload.conflicts.length}）</div>
    <div class="compare-grid">
      <div class="compare-card">
        <strong>当前项目里的内容</strong>
        <div>衔接方式：${escapeHtml(transitionLabel(current.current.transition))}</div>
        <div>平台：${escapeHtml(platformLabel(current.current.platform))}</div>
        <div>视频模型：${escapeHtml(shotModelLabel(current.current.video_model))}</div>
        <div>图片提示词：${escapeHtml(current.current.image_prompt || "空")}</div>
        <div>视频提示词：${escapeHtml(current.current.video_prompt || "空")}</div>
      </div>
      <div class="compare-card">
        <strong>这次导入的新内容</strong>
        <div>衔接方式：${escapeHtml(transitionLabel(current.next.transition))}</div>
        <div>平台：${escapeHtml(platformLabel(current.next.platform))}</div>
        <div>视频模型：${escapeHtml(shotModelLabel(current.next.video_model))}</div>
        <div>图片提示词：${escapeHtml(current.next.image_prompt || "空")}</div>
        <div>视频提示词：${escapeHtml(current.next.video_prompt || "空")}</div>
      </div>
    </div>
  `;
}

function openShotConflict() {
  $("#shotConflictModal").hidden = false;
  renderShotConflict();
}

function closeShotConflict() {
  $("#shotConflictModal").hidden = true;
  state.pendingShotImport = null;
  state.pendingShotConflictIndex = 0;
}

async function applyShotConflictDecision(action) {
  const payload = state.pendingShotImport;
  if (!payload) return;
  const current = payload.conflicts[state.pendingShotConflictIndex];
  payload.decisions.push({ action, shot: current.next });
  state.pendingShotConflictIndex += 1;
  if (state.pendingShotConflictIndex < payload.conflicts.length) {
    renderShotConflict();
    return;
  }
  const merged = new Map(payload.base.map((shot) => [shot.shot_id, shot]));
  for (const shot of payload.appended) merged.set(shot.shot_id, shot);
  for (const decision of payload.decisions) {
    if (decision.action === "overwrite") merged.set(decision.shot.shot_id, decision.shot);
  }
  state.shots = Array.from(merged.values());
  closeShotConflict();
  await saveShotsAndTagsFromTable();
  $("#shotsImportStatus").textContent = `已导入 ${payload.appended.length + payload.decisions.filter((item) => item.action === "overwrite").length} 条分镜，跳过 ${payload.decisions.filter((item) => item.action === "skip").length} 条重复分镜。`;
}

async function safeCreateShotNodes(indexes, workflowId = DEFAULT_WORKFLOW_ID) {
  const workflow = workflowPreset(workflowId);
  try {
    setStatus(`正在应用${workflow.label}...`);
    await createShotNodes(indexes, workflow.id);
  } catch (error) {
    setStatus(`${workflow.label}应用失败：${error.message}`, "bad");
  }
}

async function createShotNodes(indexes = state.shots.map((_, index) => index), workflowId = DEFAULT_WORKFLOW_ID) {
  const workflow = workflowPreset(workflowId);
  if (!state.shots.length) {
    setStatus("先导入分镜，再生成节点。", "bad");
    return;
  }
  const targetIndexes = Array.isArray(indexes) && indexes.length ? indexes : state.shots.map((_, index) => index);
  await saveShotsAndTagsFromTable();
  const bounds = canvasNodeBounds();
  const startX = bounds.maxX + 120;
  const startY = Math.max(40, bounds.minY);
  const assetColumnX = startX;
  const imageColumnX = startX + 320;
  const videoColumnX = startX + 840;
  let createdOrUpdated = 0;
  let missingBindings = 0;

  targetIndexes.forEach((index, row) => {
    const shot = state.shots[index];
    if (!shot) return;
    const imagePrompt = (shot.image_prompt || "").trim();
    const videoPrompt = (shot.video_prompt || "").trim();
    const hasImage = Boolean(imagePrompt);
    const hasVideo = Boolean(videoPrompt);
    if (!hasImage && !hasVideo) return;

    const y = startY + row * 260;
    const imageAssetIds = boundAssetIdsForPrompt(imagePrompt);
    const videoAssetIds = boundAssetIdsForPrompt(videoPrompt);
    const assetIds = Array.from(new Set([...imageAssetIds, ...videoAssetIds]));
    if ((shot.tag_refs || []).length && !assetIds.length) missingBindings += 1;
    const assetNodeById = new Map(assetIds.map((assetId, assetIndex) => [
      assetId,
      ensureAssetNode(assetId, { x: assetColumnX, y: y + assetIndex * 118 }),
    ]).filter(([, node]) => Boolean(node)));

    const needsImageNode = shot.transition === "new_frame" && hasImage;
    const imageNode = needsImageNode
      ? upsertShotGeneratorNode(
          "imageGen",
          shot,
          "image",
          { x: imageColumnX, y },
          imagePrompt,
          defaultImageParameters(),
          `分镜 ${shot.shot_id} 图片`,
          workflow
        )
      : null;
    const videoNode = hasVideo
      ? upsertShotGeneratorNode(
          "videoGen",
          shot,
          "video",
          { x: videoColumnX, y },
          videoPrompt,
          defaultVideoParameters(shot),
          `分镜 ${shot.shot_id} 视频`,
          workflow
        )
      : null;
    if (videoNode) {
      videoNode.data.transition = shot.transition || "new_frame";
      videoNode.data.continuous = Boolean(shot.continuous);
      videoNode.data.expected_prev_shot_id = shot.transition === "continue_prev_tail" ? (state.shots[index - 1]?.shot_id || "") : "";
      if (shot.duration) {
        videoNode.data.common_parameters = { ...(videoNode.data.common_parameters || {}), duration: shot.duration };
      }
      if (shot.video_model) {
        videoNode.data.common_parameters = { ...(videoNode.data.common_parameters || {}), model: shot.video_model };
      }
    }

    if (imageNode && videoNode) {
      state.canvas.edges = state.canvas.edges.filter((edge) => !(edge.source === imageNode.id && edge.target === videoNode.id));
    }
    if (imageNode) {
      for (const assetId of imageAssetIds) {
        const assetNode = assetNodeById.get(assetId);
        if (assetNode) upsertEdge(assetNode.id, imageNode.id);
      }
    }
    if (videoNode) {
      const videoTargets = imageNode ? videoAssetIds : Array.from(new Set([...imageAssetIds, ...videoAssetIds]));
      for (const assetId of videoTargets) {
        const assetNode = assetNodeById.get(assetId);
        if (assetNode) upsertEdge(assetNode.id, videoNode.id);
      }
    }
    createdOrUpdated += [imageNode, videoNode].filter(Boolean).length;
  });

  await saveCanvas();
  fitToNodes();
  render();
  const missingText = missingBindings ? `，${missingBindings} 个分镜有标签但还没绑定资产` : "";
  setStatus(`已应用${workflow.label}，生成/更新 ${createdOrUpdated} 个节点${missingText}。`, missingBindings ? "bad" : "ok");
}

function renderInspector() {
  const box = $("#inspector");
  const node = selectedNode();
  if (!node && state.selectedEdgeId) {
    box.className = "inspector";
    box.innerHTML = `
      <p class="hint">已选择一条连线。</p>
      <button id="deleteSelectedEdge">${state.pendingDeleteEdgeId === state.selectedEdgeId ? "确认删除连线" : "删除连线"}</button>
    `;
    $("#deleteSelectedEdge").addEventListener("click", () => deleteEdge());
    return;
  }
  if (!node) {
    box.className = "inspector empty";
    box.textContent = "选择一个节点查看设置。";
    setInspectorEditing(false);
    return;
  }

  const isGenerator = ["imageGen", "videoGen"].includes(node.type);
  const isMemo = node.type === "memo";
  const videoAsset = videoAssetForNode(node);
  const currentGeneratorParams = isGenerator ? generatorParameters(node.data || {}) : {};
  const generatorParams = isGenerator ? renderGeneratorFields(node) : "";
  const referenceAssetFields = isGenerator ? renderReferenceAssetFields(node) : "";
  const submitPreview = isGenerator ? buildSubmissionPreview(node) : null;
  const generatorSummary = isGenerator
    ? `<div class="hint">平台：${escapeHtml(platformLabel(node.data?.platform))} · 当前设置：${escapeHtml(formatGeneratorParameters(currentGeneratorParams) || "未设置")}</div>`
    : "";
  const submitButton = isGenerator
    ? `<button class="primary" id="submitGeneration">${state.pendingForceSubmitNodeId === node.id ? "仍然提交一条" : "提交生成任务"}</button><div id="submitFeedback" class="inline-feedback"></div>`
    : "";
  const videoTools = videoAsset
    ? `<button id="openVideoPreview">放大预览</button><button id="captureLastFrame">提取静帧</button>`
    : "";
  const promptField = ["text", "imageGen", "videoGen"].includes(node.type)
    ? `<label class="field"><span>${node.type === "text" ? "文本提示词" : "补充提示词"}</span><textarea id="nodeText" class="node-prompt-textarea">${escapeHtml(node.type === "text" ? node.data.text || "" : node.data.prompt || "")}</textarea></label>`
    : "";
  const memoField = isMemo ? `
    <div class="field">
      <span>复盘内容</span>
      <div class="memo-toolbar">
        <button type="button" data-memo-command="bold"><strong>B</strong></button>
        <button type="button" data-memo-command="italic"><em>I</em></button>
        <input id="memoColor" type="color" value="#111827">
        <select id="memoFontSize">
          <option value="3">正文</option>
          <option value="4">稍大</option>
          <option value="5">标题</option>
        </select>
      </div>
      <div id="memoEditor" class="memo-editor" contenteditable="true">${sanitizeMemoHtml(node.data?.html || "")}</div>
    </div>
  ` : "";
  const asset = node.data.asset_id ? assetById(node.data.asset_id) : null;
  const assetMetaControls = asset ? `
    <div class="field compact">
      <span>资产标记</span>
      <button id="toggleInspectorAsset">${asset.is_library_asset ? "取消资产标记" : "标记为资产"}</button>
    </div>
    <label class="field compact">
      <span>资产分类</span>
      <select id="inspectorAssetCategory" ${asset.is_library_asset ? "" : "disabled"}>
        ${["character", "scene", "prop", "other"].map((category) => `<option value="${category}" ${String(asset.asset_category || "other") === category ? "selected" : ""}>${category}</option>`).join("")}
      </select>
    </label>
  ` : "";
  const shotMeta = node.data.transition
    ? `<div class="hint">工作流：${escapeHtml(node.data.workflow_label || workflowPreset().label)} · 平台：${escapeHtml(platformLabel(node.data.platform))} · 衔接方式：${escapeHtml(transitionLabel(node.data.transition))}${node.data.expected_prev_shot_id ? ` · 上一分镜 ${escapeHtml(node.data.expected_prev_shot_id)}` : ""}</div>`
    : "";
  const memoMeta = isMemo
    ? `<div class="hint">关联节点：${memoLinkedNodes(node).length} 个。把别的节点连到这个备忘录，就会进入项目复盘。</div>`
    : "";

  box.className = "inspector";
  box.innerHTML = `
    <label class="field"><span>节点名称</span><input id="nodeTitle" value="${escapeHtml(node.data.title || nodeTitle(node))}"></label>
    ${shotMeta}
    ${memoMeta}
    ${promptField}
    ${memoField}
    ${generatorSummary}
    ${submitButton}
    ${generatorParams ? `
      <details class="submit-preview-card" open>
        <summary>生成设置</summary>
        ${generatorParams}
      </details>
    ` : ""}
    ${submitPreview ? `
      <details class="submit-preview-card">
        <summary>本次提交预览</summary>
        <div class="hint">平台：${escapeHtml(platformLabel(submitPreview.platform))}</div>
        <div class="hint">通用设置：${escapeHtml(commonParameterSummary(submitPreview) || "未设置")}</div>
        <div class="hint">${escapeHtml(platformLabel(submitPreview.platform))} 专属：${escapeHtml(platformParameterSummary(submitPreview.platform, submitPreview) || "无")}</div>
        <div class="hint">参考素材：${escapeHtml(submitPreview.assets.length ? submitPreview.assets.map((item) => assetDisplayName(item.asset)).join(", ") : "无")}</div>
        <label class="field compact"><span>最终提示词</span><textarea class="submit-preview-text" readonly>${escapeHtml(submitPreview.finalPrompt)}</textarea></label>
      </details>
    ` : ""}
    ${referenceAssetFields || ""}
    ${assetMetaControls}
    ${videoTools}
    <button id="deleteNode">${state.pendingDeleteNodeId === node.id ? "确认删除节点" : "删除节点"}</button>
    ${node.data.asset_id ? `<button id="deleteAssetFromNode">删除这个资产</button>` : ""}
  `;
  box.onfocusin = () => setInspectorEditing(true);
  box.onfocusout = () => {
    requestAnimationFrame(() => {
      if (!box.contains(document.activeElement)) setInspectorEditing(false);
    });
  };
  box.oninput = () => markInspectorInteraction();

  $("#nodeTitle").addEventListener("input", (event) => {
    patchNodeData(node.id, { title: event.target.value });
    const nodeEl = canvasEl.querySelector(`[data-id="${node.id}"] .node-header strong`);
    if (nodeEl) nodeEl.textContent = event.target.value || nodeTitle(node);
  });
  const text = $("#nodeText");
  if (text) {
    fitTextareaToContent(text);
    text.addEventListener("input", (event) => {
      patchNodeData(node.id, node.type === "text" ? { text: event.target.value } : { prompt: event.target.value });
      fitTextareaToContent(text);
    });
    text.addEventListener("blur", () => renderCanvasOnly());
  }
  const memoEditor = $("#memoEditor");
  if (memoEditor) {
    memoEditor.addEventListener("input", () => {
      patchNodeData(node.id, { html: sanitizeMemoHtml(memoEditor.innerHTML) });
      renderCanvasOnly();
    });
    memoEditor.addEventListener("blur", () => saveCanvas().catch(() => {}));
    document.querySelectorAll("[data-memo-command]").forEach((button) => {
      button.addEventListener("click", () => {
        memoEditor.focus();
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(button.dataset.memoCommand, false);
        patchNodeData(node.id, { html: sanitizeMemoHtml(memoEditor.innerHTML) });
        renderCanvasOnly();
      });
    });
    $("#memoColor")?.addEventListener("input", (event) => {
      memoEditor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("foreColor", false, event.target.value);
      patchNodeData(node.id, { html: sanitizeMemoHtml(memoEditor.innerHTML) });
      renderCanvasOnly();
    });
    $("#memoFontSize")?.addEventListener("change", (event) => {
      memoEditor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("fontSize", false, event.target.value);
      patchNodeData(node.id, { html: sanitizeMemoHtml(memoEditor.innerHTML) });
      renderCanvasOnly();
    });
  }
  bindGeneratorFields(node);
  $("#deleteNode").addEventListener("click", () => deleteNode(node.id));
  const previewButton = $("#openVideoPreview");
  if (previewButton) previewButton.addEventListener("click", () => openVideoPreview(node.id));
  const captureButton = $("#captureLastFrame");
  if (captureButton) captureButton.addEventListener("click", () => captureVideoFrame(node.id, false));
  const toggleAssetButton = $("#toggleInspectorAsset");
  if (toggleAssetButton && asset) {
    toggleAssetButton.addEventListener("click", () => updateAssetMeta(asset.asset_id, {
      is_library_asset: !asset.is_library_asset,
      asset_category: $("#inspectorAssetCategory")?.value || asset.asset_category || "other",
    }));
  }
  const inspectorCategory = $("#inspectorAssetCategory");
  if (inspectorCategory && asset) {
    inspectorCategory.addEventListener("change", () => updateAssetMeta(asset.asset_id, {
      is_library_asset: asset.is_library_asset,
      asset_category: inspectorCategory.value,
    }));
  }
  const deleteAssetButton = $("#deleteAssetFromNode");
  if (deleteAssetButton) deleteAssetButton.addEventListener("click", () => deleteAsset(node.data.asset_id));
  const submit = $("#submitGeneration");
  if (submit) submit.addEventListener("click", () => submitGeneration(node.id, submit));
}

function renderGeneratorFields(node) {
  const normalized = normalizeGeneratorData(node.data || {});
  const platform = normalized.platform;
  const availablePlatforms = GENERATION_PLATFORMS;
  const safePlatform = availablePlatforms.some((item) => item.value === platform) ? platform : availablePlatforms[0].value;
  const platformOptions = availablePlatforms.map((item) => `<option value="${item.value}" ${safePlatform === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const selected = generatorParameters(normalized);
  const meta = state.params?.model_meta || {};
  const isVideo = node.type === "videoGen";
  const isJimengVideo = safePlatform === "jimeng_cli" && isVideo;
  const isJimengImage = safePlatform === "jimeng_cli" && !isVideo;
  const jimengMode = isJimengVideo
    ? (JIMENG_VIDEO_MODES.some((item) => item.value === selected.mode) ? selected.mode : (selected.mode || "text2video"))
    : "";
  const jimengImageMode = isJimengImage
    ? (JIMENG_IMAGE_MODES.some((item) => item.value === selected.mode) ? selected.mode : (selected.mode || "text2image"))
    : "";
  let modelOptions = "";
  let sizeOptions = "";
  let durationField = "";
  let featureOptions = "";
  let modelValue = selected.model || "";
  let sizeValue = selected.size || "";
  let durationValue = selected.duration || "";
  let featureValue = selected.feature || "auto";
  let needsMotion = false;
  let needsEdit = false;
  if (isJimengVideo) {
    const models = jimengVideoModeOptions(jimengMode);
    modelValue = models.includes(selected.model) ? selected.model : models[0];
    sizeValue = selected.size || (jimengMode === "image2video" ? "" : "16:9");
    const durationRange = jimengDurationRange(jimengMode, modelValue);
    durationValue = String(parseDurationNumber(selected.duration, durationRange.min));
    modelOptions = models.map((model) => `<option value="${escapeHtml(model)}" ${modelValue === model ? "selected" : ""}>${escapeHtml(model)}</option>`).join("");
    sizeOptions = jimengMode === "image2video"
      ? ""
      : ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"].map((size) => `<option value="${escapeHtml(size)}" ${sizeValue === size ? "selected" : ""}>${escapeHtml(size)}</option>`).join("");
    durationField = `
      <label class="field compact generator-field-third">
        <span>视频时长</span>
        <input id="paramDuration" type="number" min="${durationRange.min}" max="${durationRange.max}" step="1" value="${escapeHtml(durationValue)}">
        <div class="hint">支持 ${durationRange.min}-${durationRange.max} 秒</div>
      </label>
    `;
  } else if (isJimengImage) {
    const models = jimengImageModeOptions(jimengImageMode);
    modelValue = models.includes(selected.model) ? selected.model : models[0];
    const sizeChoices = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
    sizeValue = sizeChoices.includes(selected.size) ? selected.size : (selected.size || "1:1");
    modelOptions = models.map((model) => `<option value="${escapeHtml(model)}" ${modelValue === model ? "selected" : ""}>${escapeHtml(shotModelLabel(model))}</option>`).join("");
    sizeOptions = sizeChoices.map((size) => `<option value="${escapeHtml(size)}" ${sizeValue === size ? "selected" : ""}>${escapeHtml(size)}</option>`).join("");
  } else {
    const params = state.params?.[node.type === "imageGen" ? "image" : "video"];
    if (!params) return "";
    modelValue = params.models.includes(selected.model) ? selected.model : params.models[0];
    const sizeChoices = (params.sizes || (isVideo ? ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] : []));
    sizeValue = sizeChoices.includes(selected.size) ? selected.size : (sizeChoices[0] || "");
    const durationRange = isVideo ? lovartDurationRange(modelValue) : { min: 5, max: 15 };
    durationValue = String(parseDurationNumber(selected.duration, durationRange.min));
    const featureList = meta[modelValue]?.features || [{ value: "auto", label: "自动" }];
    featureValue = featureList.some((feature) => feature.value === selected.feature) ? selected.feature : featureList[0].value;
    modelOptions = params.models.map((model) => {
      const label = model === "agent-auto" ? "自动选择" : (meta[model]?.label || model);
      return `<option value="${escapeHtml(model)}" ${modelValue === model ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    sizeOptions = sizeChoices.map((size) => `<option value="${escapeHtml(size)}" ${sizeValue === size ? "selected" : ""}>${escapeHtml(size)}</option>`).join("");
    durationField = isVideo ? `
      <label class="field compact generator-field-third">
        <span>视频时长</span>
        <input id="paramDuration" type="number" min="${durationRange.min}" max="${durationRange.max}" step="1" value="${escapeHtml(durationValue)}">
        <div class="hint">当前模型支持 ${durationRange.min}-${durationRange.max} 秒</div>
      </label>
    ` : "";
    featureOptions = featureList.map((feature) => `<option value="${escapeHtml(feature.value)}" ${featureValue === feature.value ? "selected" : ""}>${escapeHtml(feature.label)}</option>`).join("");
    needsMotion = featureValue === "motion_control";
    needsEdit = featureValue === "video_edit" || featureValue === "image_edit";
  }
  const jimengResolutionValue = selected.video_resolution || "720p";
  const jimengModeOptions = JIMENG_VIDEO_MODES.map((item) => `<option value="${item.value}" ${jimengMode === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const jimengResolutionOptions = ["720p", "1080p"].map((item) => `<option value="${item}" ${jimengResolutionValue === item ? "selected" : ""}>${item}</option>`).join("");
  const jimengImageResolutionValue = selected.resolution_type || "2k";
  const jimengImageModeOptionsHtml = JIMENG_IMAGE_MODES.map((item) => `<option value="${item.value}" ${jimengImageMode === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const jimengImageResolutionOptionsHtml = jimengImageResolutionOptions(jimengImageMode, modelValue).map((item) => `<option value="${item}" ${jimengImageResolutionValue === item ? "selected" : ""}>${item}</option>`).join("");
  return `
    <div class="generator-settings-grid">
      <label class="field compact generator-field-wide"><span>模型</span><select id="paramModel">${modelOptions}</select></label>
      <label class="field compact generator-field-third"><span>平台</span><select id="paramPlatform">${platformOptions}</select></label>
      ${sizeOptions ? `<label class="field compact generator-field-third"><span>${isVideo ? "视频比例" : "图片比例"}</span><select id="paramSize">${sizeOptions}</select></label>` : (isJimengVideo ? `<div class="hint generator-field-wide">单图生视频的画幅由首帧图片决定。</div>` : "")}
      ${durationField}
      ${isJimengVideo ? `
        <label class="field compact generator-field-half"><span>视频模式</span><select id="paramMode">${jimengModeOptions}</select></label>
        <label class="field compact generator-field-half"><span>分辨率</span><select id="paramResolution">${jimengResolutionOptions}</select></label>
        ${jimengMode === "multimodal2video" ? `<div class="hint generator-field-wide">这条可接多张图片、视频、音频。至少一张图片或一个视频；如果连的是 URL 素材，提交时会先转成本地文件再交给即梦。</div>` : ""}
      ` : isJimengImage ? `
        <label class="field compact generator-field-half"><span>图片模式</span><select id="paramMode">${jimengImageModeOptionsHtml}</select></label>
        <label class="field compact generator-field-half"><span>分辨率</span><select id="paramResolution">${jimengImageResolutionOptionsHtml}</select></label>
        ${jimengImageMode === "text2image"
          ? `<div class="hint generator-field-wide">文生图不吃参考图；如果你要用图片参考，请切到图生图。</div>`
          : `<div class="hint generator-field-wide">图生图支持 1-10 张图片；如果连的是 URL 图片，提交时会先转成本地文件再交给即梦。</div>`}
      ` : `
        <label class="field compact generator-field-third"><span>功能</span><select id="paramFeature">${featureOptions}</select></label>
        ${needsMotion ? `<label class="field compact generator-field-wide"><span>动作控制</span><textarea id="paramMotion" placeholder="例如：镜头缓慢前推，人物向右转身，手臂自然摆动">${escapeHtml(selected.motion_control || "")}</textarea></label>` : ""}
        ${needsEdit ? `<label class="field compact generator-field-wide"><span>编辑要求</span><textarea id="paramEdit" placeholder="说明要保留什么、修改什么">${escapeHtml(selected.edit_instruction || "")}</textarea></label>` : ""}
      `}
    </div>
  `;
}

function bindGeneratorFields(node) {
  if (!["imageGen", "videoGen"].includes(node.type)) return;
  const normalized = normalizeGeneratorData(node.data || {});
  const nextCommon = { ...(normalized.common_parameters || {}) };
  const nextPlatformParameters = {
    ...(normalized.platform_parameters || {}),
    [normalized.platform]: { ...(normalized.platform_parameters?.[normalized.platform] || {}) },
  };
  let changed = false;
  const platform = $("#paramPlatform");
  const model = $("#paramModel");
  const feature = $("#paramFeature");
  const size = $("#paramSize");
  const duration = $("#paramDuration");
  const mode = $("#paramMode");
  const resolution = $("#paramResolution");
  const motion = $("#paramMotion");
  const edit = $("#paramEdit");
  if (node.type === "imageGen" && normalized.platform === "lovart") {
    const preferredImageModel = firstAvailableModel("image", "generate_image_nano_banana_pro");
    if (!nextCommon.model || nextCommon.model === "agent-auto") {
      nextCommon.model = preferredImageModel;
      changed = true;
    }
  } else if (node.type === "imageGen" && normalized.platform === "jimeng_cli") {
    const jimengMode = nextPlatformParameters.jimeng_cli?.mode || "text2image";
    if (!nextCommon.model || !jimengImageModeOptions(jimengMode).includes(nextCommon.model)) {
      nextCommon.model = "5.0";
      changed = true;
    }
    if (!nextCommon.size) {
      nextCommon.size = "1:1";
      changed = true;
    }
    if (!nextPlatformParameters.jimeng_cli?.mode) {
      nextPlatformParameters.jimeng_cli.mode = "text2image";
      changed = true;
    }
    if (!nextPlatformParameters.jimeng_cli?.resolution_type) {
      nextPlatformParameters.jimeng_cli.resolution_type = "2k";
      changed = true;
    }
  }
  if (model && !nextCommon.model) {
    nextCommon.model = model.value;
    changed = true;
  }
  if (model && nextCommon.model && !Array.from(model.options).some((option) => option.value === nextCommon.model)) {
    nextCommon.model = model.value;
    changed = true;
  }
  if (size && !nextCommon.size) {
    nextCommon.size = size.value;
    changed = true;
  }
  if (size && nextCommon.size && !Array.from(size.options).some((option) => option.value === nextCommon.size)) {
    nextCommon.size = size.value;
    changed = true;
  }
  if (duration && !nextCommon.duration) {
    nextCommon.duration = formatDurationValue(duration.value);
    changed = true;
  }
  if (duration && nextCommon.duration && parseDurationNumber(nextCommon.duration, NaN) !== parseDurationNumber(duration.value, NaN)) {
    nextCommon.duration = formatDurationValue(duration.value);
    changed = true;
  }
  if (feature && !nextPlatformParameters[normalized.platform]?.feature) {
    nextPlatformParameters[normalized.platform].feature = feature.value;
    changed = true;
  }
  if (feature && nextPlatformParameters[normalized.platform]?.feature && !Array.from(feature.options).some((option) => option.value === nextPlatformParameters[normalized.platform].feature)) {
    nextPlatformParameters[normalized.platform].feature = feature.value;
    changed = true;
  }
  if (changed) {
    patchNodeData(node.id, {
      platform: normalized.platform,
      common_parameters: nextCommon,
      platform_parameters: nextPlatformParameters,
    });
  }

  const bindCommon = (el, key) => {
    if (!el) return;
    el.addEventListener("change", (event) => {
      const current = normalizeGeneratorData(selectedNode()?.id === node.id ? selectedNode().data : node.data);
      const value = key === "duration" ? formatDurationValue(event.target.value) : event.target.value;
      const patch = {
        common_parameters: { ...(current.common_parameters || {}), [key]: value },
      };
      if (key === "model" && node.type === "videoGen") {
        const recommended = recommendedVideoBehavior(current.platform, value);
        patch.platform_parameters = {
          ...(current.platform_parameters || {}),
          [current.platform]: {
            ...(current.platform_parameters?.[current.platform] || {}),
            ...(recommended.feature ? { feature: recommended.feature } : {}),
            ...(recommended.mode ? { mode: recommended.mode } : {}),
          },
        };
      } else if (key === "model" && node.type === "imageGen" && current.platform === "jimeng_cli") {
        const currentMode = current.platform_parameters?.jimeng_cli?.mode || "text2image";
        const validResolutions = jimengImageResolutionOptions(currentMode, value);
        const currentResolution = current.platform_parameters?.jimeng_cli?.resolution_type || "2k";
        patch.platform_parameters = {
          ...(current.platform_parameters || {}),
          jimeng_cli: {
            ...(current.platform_parameters?.jimeng_cli || {}),
            resolution_type: validResolutions.includes(currentResolution) ? currentResolution : validResolutions[0],
          },
        };
      }
      patchNodeData(node.id, patch);
      if (key === "model") renderInspector();
    });
  };
  const bindPlatform = (el, key) => {
    if (!el) return;
    el.addEventListener("change", (event) => {
      const current = normalizeGeneratorData(selectedNode()?.id === node.id ? selectedNode().data : node.data);
      patchNodeData(node.id, {
        platform_parameters: {
          ...(current.platform_parameters || {}),
          [current.platform]: {
            ...(current.platform_parameters?.[current.platform] || {}),
            [key]: event.target.value,
          },
        },
      });
      if (key === "feature" || key === "mode" || key === "resolution_type" || key === "video_resolution") renderInspector();
    });
  };
  const bindPlatformText = (el, key) => {
    if (!el) return;
    el.addEventListener("input", (event) => {
      const current = normalizeGeneratorData(selectedNode()?.id === node.id ? selectedNode().data : node.data);
      patchNodeData(node.id, {
        platform_parameters: {
          ...(current.platform_parameters || {}),
          [current.platform]: {
            ...(current.platform_parameters?.[current.platform] || {}),
            [key]: event.target.value,
          },
        },
      });
    });
  };
  if (platform) {
    platform.addEventListener("change", (event) => {
      const current = normalizeGeneratorData(selectedNode()?.id === node.id ? selectedNode().data : node.data);
      const nextPlatform = normalizePlatform(event.target.value);
      const currentParams = generatorParameters(current);
      const split = splitParametersByPlatform(nextPlatform, currentParams);
      const recommended = node.type === "videoGen" ? recommendedVideoBehavior(nextPlatform, currentParams.model) : {};
      const nextCommon = { ...(current.common_parameters || {}), ...split.common };
      const nextPlatformSpecific = {
        ...(split.platformSpecific[nextPlatform] || {}),
        ...(current.platform_parameters?.[nextPlatform] || {}),
      };
      if (node.type === "imageGen") {
        if (nextPlatform === "jimeng_cli") {
          nextCommon.model = "5.0";
          nextCommon.size = nextCommon.size || "1:1";
          nextPlatformSpecific.mode = "text2image";
          nextPlatformSpecific.resolution_type = "2k";
          delete nextPlatformSpecific.feature;
          delete nextPlatformSpecific.motion_control;
          delete nextPlatformSpecific.edit_instruction;
        } else {
          nextCommon.model = firstAvailableModel("image", "generate_image_nano_banana_pro");
          nextPlatformSpecific.feature = nextPlatformSpecific.feature || "auto";
          delete nextPlatformSpecific.mode;
          delete nextPlatformSpecific.resolution_type;
          delete nextPlatformSpecific.video_resolution;
        }
      }
      patchNodeData(node.id, {
        platform: nextPlatform,
        common_parameters: nextCommon,
        platform_parameters: {
          ...(current.platform_parameters || {}),
          [nextPlatform]: {
            ...nextPlatformSpecific,
            ...(recommended.feature ? { feature: recommended.feature } : {}),
            ...(recommended.mode ? { mode: recommended.mode } : {}),
          },
        },
      });
      renderInspector();
    });
  }
  bindCommon(model, "model");
  bindPlatform(feature, "feature");
  bindCommon(size, "size");
  bindCommon(duration, "duration");
  bindPlatform(mode, "mode");
  if (resolution) {
    bindPlatform(resolution, node.type === "imageGen" && normalized.platform === "jimeng_cli" ? "resolution_type" : "video_resolution");
  }
  bindPlatformText(motion, "motion_control");
  bindPlatformText(edit, "edit_instruction");
  document.querySelectorAll("[data-asset-role]").forEach((select) => {
    select.addEventListener("change", (event) => {
      const assetId = select.dataset.assetRole;
      const nextRoles = { ...(node.data.asset_roles || {}) };
      nextRoles[assetId] = event.target.value;
      if (event.target.value === "first_frame") {
        Object.keys(nextRoles).forEach((id) => {
          if (id !== assetId && nextRoles[id] === "first_frame") nextRoles[id] = "auto";
        });
      }
      patchNodeData(node.id, { asset_roles: nextRoles });
      renderInspector();
    });
  });
}

function renderJobs() {
  const box = $("#jobList");
  if (!state.jobs.length) {
    box.innerHTML = `<p class="hint">还没有任务。先提一条图片或视频生成任务。</p>`;
    return;
  }
  const jobs = state.jobs.slice().reverse();
  const queryableRunning = runningJobsForAutoRefresh();
  const queryStatus = autoQuerySummary();
  const summary = {
    total: jobs.length,
    running: jobs.filter((job) => job.status === "running").length,
    blocked: jobs.filter((job) => ["needs_input", "pending_confirmation", "rate_limited"].includes(job.status)).length,
    failed: jobs.filter((job) => job.status === "failed").length,
    done: jobs.filter((job) => ["downloaded", "completed"].includes(job.status)).length,
  };
  box.innerHTML = `
    <div class="job-summary">
      <span>任务 ${summary.total}</span>
      ${summary.running ? `<span>生成中 ${summary.running}</span>` : ""}
      ${summary.blocked ? `<span class="bad">待处理 ${summary.blocked}</span>` : ""}
      ${summary.failed ? `<span class="bad">失败 ${summary.failed}</span>` : ""}
      ${summary.done ? `<span class="ok">完成 ${summary.done}</span>` : ""}
      ${queryableRunning.length ? `<button type="button" class="job-summary-action" id="refreshRunningJobs">刷新全部生成中</button>` : ""}
    </div>
    ${queryStatus ? `<div class="job-auto-query">${escapeHtml(queryStatus)}</div>` : ""}
  ` + jobs.map((job) => {
    const replyNote = jobReplyNote(job);
    return `
    <details class="job-card" data-job-detail="${escapeHtml(job.job_id)}" ${state.openJobIds.includes(job.job_id) ? "open" : ""}>
      <summary>
        <span class="status-pill ${escapeHtml(statusInfoFromJob(job)?.tone || "waiting")}">${escapeHtml(statusInfoFromJob(job)?.label || job.status)}</span>
        <span>
          <strong>${escapeHtml(job.asset_template_label ? `资产 ${job.asset_template_label}` : (job.shot_ids?.length ? `分镜 ${job.shot_ids.join(", ")}` : "无分镜"))}</strong>
        </span>
        <span class="job-kind">${job.kind === "image" ? "图片" : "视频"} · ${platformLabel(job.platform)}</span>
      </summary>
      <div class="job-detail">
        <div class="job-primary-actions">
          ${job.status === "rate_limited" ? `<button data-mark-handled-job="${job.job_id}">已在平台处理</button>` : ""}
          ${job.status === "pending_confirmation" ? `<button data-confirm-job="${job.job_id}">确认并继续</button>` : ""}
          ${((job.lovart_thread_id || job.jimeng_submit_id) && job.status !== "downloaded") ? `<button data-refresh-job="${job.job_id}">刷新结果</button>` : ""}
        </div>
        ${jobNeedsLovartReply(job) ? `
          <div class="job-reply-box">
            <label class="field compact">
              <span>回复 Lovart</span>
              <textarea data-job-reply-message="${job.job_id}" placeholder="例如：选择方案 2，去掉人物参考图，仅使用场景图继续生成。">${escapeHtml(job.last_lovart_reply || "")}</textarea>
            </label>
            <div class="job-reply-actions">
              ${jobLooksLikePlanConfirmation(job) ? `<button data-reply-job="${job.job_id}" data-default-reply="确认此方案，请开始生成。">确认方案并生成</button>` : ""}
              <button data-reply-job="${job.job_id}">发送回复并继续</button>
              <span class="job-reply-status" data-job-reply-status="${job.job_id}"></span>
            </div>
          </div>
        ` : ""}
        ${replyNote ? `<div class="job-replied-note ${escapeHtml(replyNote.tone)}">${escapeHtml(replyNote.text)}</div>` : ""}
        ${job.asset_template_label ? `<div>资产模板：${escapeHtml(job.asset_template_label)}</div>` : ""}
        <div>分镜：${escapeHtml(job.shot_ids?.length ? job.shot_ids.join(", ") : "未关联")}</div>
        <div>平台：${escapeHtml(platformLabel(job.platform))}</div>
        <div>类型：${job.kind === "image" ? "图片生成" : "视频生成"}</div>
        <div>通用设置：${escapeHtml(commonParameterSummary(job.parameters || {}) || "未设置")}</div>
        <div>${escapeHtml(platformLabel(job.platform))} 专属：${escapeHtml(platformParameterSummary(job.platform, job.parameters || {}) || "无")}</div>
        <details>
          <summary>提交提示词</summary>
          <textarea class="job-command-view" readonly>${escapeHtml(job.submitted_prompt || job.prompt || "")}</textarea>
        </details>
        ${visibleSubmittedCommand(job) ? `
          <details>
            <summary>平台提交内容</summary>
            <textarea class="job-command-view" readonly>${escapeHtml(visibleSubmittedCommand(job))}</textarea>
          </details>
        ` : ""}
        ${job.lovart_project_id ? `<div>Lovart 项目：${escapeHtml(job.lovart_project_id)}</div>` : ""}
        ${job.lovart_thread_id ? `<div>Thread：${escapeHtml(job.lovart_thread_id)}</div>` : ""}
        ${job.jimeng_submit_id ? `<div>Submit ID：${escapeHtml(job.jimeng_submit_id)}</div>` : ""}
        ${job.failure_reason ? `<div class="bad">${escapeHtml(job.failure_reason)}</div>` : ""}
      </div>
    </details>
  `;
  }).join("");
  box.querySelectorAll("[data-refresh-job]").forEach((button) => {
    button.addEventListener("click", () => refreshJob(button.dataset.refreshJob));
  });
  $("#refreshRunningJobs")?.addEventListener("click", () => {
    refreshRunningJobsNow().catch((error) => setStatus(error.message, "bad"));
  });
  box.querySelectorAll("[data-confirm-job]").forEach((button) => {
    button.addEventListener("click", () => confirmJob(button.dataset.confirmJob));
  });
  box.querySelectorAll("[data-reply-job]").forEach((button) => {
    button.addEventListener("click", () => replyJob(button.dataset.replyJob, button.dataset.defaultReply || "", button));
  });
  box.querySelectorAll("[data-mark-handled-job]").forEach((button) => {
    button.addEventListener("click", () => markRateLimitedHandled(button.dataset.markHandledJob));
  });
  box.querySelectorAll("[data-job-detail]").forEach((detail) => {
    detail.addEventListener("toggle", () => {
      rememberOpenId("openJobIds", detail.dataset.jobDetail, detail.open);
    });
  });
}

function renderReview() {
  const box = $("#reviewList");
  if (!box) return;
  const memoNodes = state.canvas.nodes.filter((node) => node.type === "memo");
  if (!memoNodes.length) {
    box.innerHTML = `<p class="hint">还没有项目复盘。先添加一个备忘录节点，再把它和相关节点连起来。</p>`;
    return;
  }
  box.innerHTML = memoNodes.map((memoNode) => {
    const linked = memoLinkedNodes(memoNode);
    const linkedMedia = linked.filter((node) => {
      const asset = node.data?.asset_id ? assetById(node.data.asset_id) : null;
      return asset?.kind === "image" || asset?.kind === "video";
    });
    return `
      <details class="review-card" open>
        <summary>
          <strong>${escapeHtml(nodeTitle(memoNode))}</strong>
          <span class="hint">关联 ${linked.length} 个节点</span>
        </summary>
        <div class="review-body">
          <div class="review-note">${sanitizeMemoHtml(memoNode.data?.html || "") || `<p class="hint">还没写复盘内容。</p>`}</div>
          <div class="review-section">
            <strong>关联节点</strong>
            ${linked.length ? linked.map((node) => `
              <div class="review-linked-card">
                <div class="review-linked-head">
                  <span>${escapeHtml(nodeTitle(node))}</span>
                  <span class="hint">${escapeHtml(nodeTypeLabel(node.type))}</span>
                </div>
                ${renderAssociatedNodeSummary(node)}
              </div>
            `).join("") : `<div class="hint">还没有关联节点。</div>`}
          </div>
          <div class="review-section">
            <strong>关联图片 / 视频</strong>
            ${linkedMedia.length ? `<div class="review-media-grid">${linkedMedia.map((node) => `
              <div class="review-media-card">
                <div class="hint">${escapeHtml(nodeTitle(node))}</div>
                ${renderAssociatedNodeSummary(node)}
              </div>
            `).join("")}</div>` : `<div class="hint">还没有关联图片或视频。</div>`}
          </div>
        </div>
      </details>
    `;
  }).join("");
}

function renderRightPanels() {
  const collapseRight = state.rightTab === "inspector" && !selectedNodeIds().length;
  document.body.classList.toggle("right-collapsed", collapseRight);
  document.querySelectorAll("[data-right-panel]").forEach((section) => {
    section.hidden = section.dataset.rightPanel !== state.rightTab;
  });
  document.querySelectorAll("[data-right-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.rightTab === state.rightTab);
  });
}

function renderParams() {
  const box = $("#lovartParams");
  if (!state.params) {
    box.textContent = "参数同步中，不影响画布操作。";
    return;
  }
  box.innerHTML = `
    <div>适配状态：${state.params.adapter_status === "skill_configured" ? "已接入 Lovart skill" : "Lovart skill 未安装"}</div>
    <div>模型来源：${state.params.source === "query-mode" ? "Lovart 同步" : "本地备用"}</div>
    ${state.params.mode ? `<div>生成模式：${escapeHtml(state.params.mode)}</div>` : ""}
    ${state.params.command ? `<div>命令：${escapeHtml(state.params.command)}</div>` : ""}
    <div>图片模型：${state.params.image.models.length - 1} 个</div>
    <div>视频模型：${state.params.video.models.length - 1} 个</div>
  `;
}

function render() {
  renderRightPanels();
  renderToolbarState();
  renderCanvasOnly();
  renderAssetLibrary();
  renderTags();
  renderAssets();
  renderWorkflowList();
  renderShotTable();
  renderInspector();
  renderJobs();
  renderReview();
  renderParams();
  scheduleAutoRefresh();
}

function sanitizeShotsForState(shots = []) {
  return shots.map((shot) => {
    const image_prompt = normalizeInlineTagSpacing(collapseBrokenAsciiTags(shot.image_prompt || ""));
    const video_prompt = normalizeInlineTagSpacing(collapseBrokenAsciiTags(shot.video_prompt || ""));
    const duration = String(shot.duration || extractDurationFromPrompt(video_prompt) || "").trim();
    const size = String(shot.size || extractAspectRatioFromPrompt(video_prompt) || "").trim();
    const normalized = normalizeShotPlatformAndModel(
      shot.platform,
      String(shot.video_model || "").trim(),
      shot.transition,
      getPreferredSeedancePlatform()
    );
    const prompt = [image_prompt, video_prompt].filter(Boolean).join("\n\n");
    const providedTags = Array.isArray(shot.tag_refs)
      ? Array.from(new Set(shot.tag_refs.map((item) => String(item || "").trim()).filter(Boolean)))
      : null;
    return {
      ...shot,
      image_prompt,
      video_prompt,
      platform: normalized.platform,
      video_model: normalized.video_model,
      duration,
      size,
      prompt,
      tag_refs: providedTags?.length ? providedTags : tagRefsForPrompt(prompt),
    };
  });
}

async function loadProject(name = state.projectId) {
  if (state.autoRefreshTimer) {
    clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (state.syncJobsTimer) {
    clearTimeout(state.syncJobsTimer);
    state.syncJobsTimer = null;
  }
  if (state.canvasSaveTimer) {
    clearTimeout(state.canvasSaveTimer);
    state.canvasSaveTimer = null;
  }
  state.autoRefreshingJobId = null;
  state.canvasDirty = false;
  const data = await api(`/api/project?project_id=${encodeURIComponent(name)}`);
  state.project = data.project;
  state.projectId = data.project.project_id;
  rememberLastProjectId(state.projectId);
  state.canvas = data.canvas;
  state.shots = sanitizeShotsForState(data.shots || []);
  state.tags = rebuildTagsFromShots(data.tags || []);
  state.jobs = data.jobs;
  state.assetLibrary = data.asset_library || { global_rules: "", templates: [], image_model: "agent-auto" };
  const draft = readCanvasDraft(state.projectId);
  if (draft?.canvas) {
    state.canvas = mergeCanvasDraftWithServer(draft.canvas, state.canvas);
    state.canvasDirty = true;
  }
  clearNodeSelection();
  clearConnectSources();
  state.selectedEdgeId = null;
  $("#projectLabel").textContent = "分镜、素材和任务都保存在这个项目里";
  $("#projectName").value = state.projectId;
  setStatus(draft?.canvas ? "项目已加载，并恢复了一份未同步的本地备份。" : "项目已加载。", "ok");
  render();
  if (draft?.canvas) {
    renderCanvasDraftNotice(draft);
    saveCanvas({ silent: true }).catch((error) => {
      setStatus(`本地备份已恢复，但同步失败：${error.message}`, "bad");
    });
  } else {
    renderCanvasDraftNotice(null);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => fitToNodes({ silent: true })));
}

function upsertJob(job) {
  const index = state.jobs.findIndex((item) => item.job_id === job.job_id);
  if (index >= 0) state.jobs[index] = { ...state.jobs[index], ...job };
  else state.jobs.unshift(job);
}

function renderJobStateOnly() {
  renderToolbarState();
  renderShotTable();
  renderJobs();
  renderReview();
}

async function syncJobsState(silent = false) {
  if (state.canvasDirty || canvasInteractionBusy() || inspectorRecentlyActive() || isEditingElement(document.activeElement)) return;
  const data = await api(`/api/jobs/state?project_id=${encodeURIComponent(state.projectId)}`);
  state.jobs = data.jobs || [];
  state.canvas = data.canvas || state.canvas;
  state.assetLibrary = data.asset_library || state.assetLibrary;
  render();
  if (!silent) setStatus("任务状态已更新。", "ok");
  if (state.bulkSubmit.active) {
    processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
  }
}

async function saveCanvas(options = {}) {
  saveCanvasDraft("before_server_save");
  try {
    await api("/api/canvas/save", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, canvas: state.canvas }),
    });
    state.canvasDirty = false;
    clearCanvasDraft();
    if (!options.silent) setStatus("画布已保存。", "ok");
  } catch (error) {
    state.canvasDirty = true;
    saveCanvasDraft("server_save_failed", { showNotice: true });
    throw new Error(`服务器保存失败，已保留本地备份：${error.message}`);
  }
}

function scheduleCanvasSave(delay = 600) {
  saveCanvasDraft("auto_pending", { showNotice: false });
  if (state.canvasSaveTimer) clearTimeout(state.canvasSaveTimer);
  state.canvasSaveTimer = setTimeout(async () => {
    state.canvasSaveTimer = null;
    if (!state.canvasDirty) return;
    try {
      await saveCanvas({ silent: true });
    } catch (error) {
      setStatus(`自动保存失败：${error.message}`, "bad");
    }
  }, delay);
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  $("#lovartSkillPath").value = state.settings.lovart_skill_path || "";
  const status = $("#lovartKeyStatus");
  const keyReady = state.settings.lovart_access_key_set && state.settings.lovart_secret_key_set;
  const skillReady = Boolean(state.settings.lovart_skill_exists);
  const keyText = keyReady
    ? `已保存：Access ${state.settings.lovart_access_key_preview}，Secret ${state.settings.lovart_secret_key_preview}`
    : "还没完整保存 Access Key 和 Secret Key。";
  const skillText = state.settings.lovart_skill_path
    ? `Skill 路径：${state.settings.lovart_skill_exists ? "已找到" : "未找到"}`
    : "Skill 路径：未填写";
  const pythonText = state.settings.python_command ? `Python：${state.settings.python_command}` : "";
  status.textContent = [keyText, skillText, pythonText].filter(Boolean).join(" | ");
  status.className = `hint ${keyReady && skillReady ? "ok" : "bad"}`;
}

async function saveProjectRoot() {
  const projectRoot = $("#projectRootInput").value.trim();
  if (!projectRoot) {
    setStatus("项目保存目录不能为空。", "bad");
    return;
  }
  const result = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ project_root: projectRoot }),
  });
  state.settings = { ...(state.settings || {}), project_root: result.project_root };
  $("#projectRootInput").value = result.project_root;
  setStatus("项目保存目录已保存。新建/打开项目会使用这个目录。", "ok");
  if ($("#projectPickerModal") && !$("#projectPickerModal").hidden) {
    const projects = await api("/api/projects");
    state.availableProjects = projects.projects || [];
    state.settings = { ...(state.settings || {}), project_root: projects.project_root };
    renderProjectPicker();
  }
}

async function saveLovartKey() {
  const accessKey = $("#lovartAccessKey").value.trim();
  const secretKey = $("#lovartSecretKey").value.trim();
  const skillPath = $("#lovartSkillPath").value.trim();
  const hasSavedKeys = state.settings?.lovart_access_key_set && state.settings?.lovart_secret_key_set;
  const hasNewKeys = Boolean(accessKey && secretKey);
  if (!hasSavedKeys && !hasNewKeys) {
    setStatus("第一次配置时，请同时填写 Access Key 和 Secret Key。", "bad");
    return;
  }
  if ((accessKey && !secretKey) || (!accessKey && secretKey)) {
    setStatus("如果要更新密钥，请同时填写 Access Key 和 Secret Key。", "bad");
    return;
  }
  if (!skillPath) {
    setStatus("请填写 Lovart skill 路径。", "bad");
    return;
  }
  const payload = { lovart_skill_path: skillPath };
  if (hasNewKeys) {
    payload.lovart_access_key = accessKey;
    payload.lovart_secret_key = secretKey;
  }
  const result = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  $("#lovartAccessKey").value = "";
  $("#lovartSecretKey").value = "";
  $("#lovartSkillPath").value = result.lovart_skill_path || skillPath;
  await loadSettings();
  if (result.lovart_skill_exists) {
    setStatus("Lovart 配置已保存，skill 路径可用。", "ok");
  } else {
    setStatus("Lovart 配置已保存，但 skill 路径还没找到。请检查 agent_skill.py 路径。", "bad");
  }
}

async function saveAssetLibrary() {
  const data = await api("/api/asset-library/save", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, asset_library: state.assetLibrary }),
  });
  state.assetLibrary = data.asset_library;
}

async function importAssetLibraryFile(file) {
  const base64 = await fileToBase64(file);
  const data = await api("/api/asset-library/import", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, base64 }),
  });
  state.assetLibrary = data.asset_library;
  renderAssetLibrary();
  setStatus(`已导入 ${state.assetLibrary.templates.length} 个资产模板。`, "ok");
}

async function importAssetLibraryJsonlFile(file) {
  const base64 = await fileToBase64(file);
  const data = await api("/api/asset-library/import-jsonl", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, base64 }),
  });
  state.assetLibrary = data.asset_library;
  renderAssetLibrary();
  setStatus(`已导入 ${state.assetLibrary.templates.length} 个 JSONL 资产模板。`, "ok");
}

async function createAssetTemplateNodes(templateIds = state.assetLibrary.templates.map((item) => item.template_id)) {
  const templates = state.assetLibrary.templates.filter((item) => templateIds.includes(item.template_id));
  if (!templates.length) {
    setStatus("先导入资产模板。", "bad");
    return;
  }
  const bounds = canvasNodeBounds();
  const startX = bounds.maxX + 180;
  const startY = Math.max(40, bounds.minY);
  const categoryColumns = { character: 0, scene: 1, prop: 2, other: 3 };
  const categoryCounts = { character: 0, scene: 0, prop: 0, other: 0 };
  let changed = 0;
  for (const template of templates) {
    const category = template.category || "other";
    const column = categoryColumns[category] ?? 3;
    const row = categoryCounts[category] || 0;
    const node = upsertAssetTemplateNode(template, {
      x: startX + column * 320,
      y: startY + row * 220,
    });
    categoryCounts[category] = row + 1;
    template.status = template.generated_asset_ids?.length ? template.status : "queued";
    changed += node ? 1 : 0;
  }
  await saveAssetLibrary();
  await saveCanvas();
  render();
  fitToNodes();
  setStatus(`已生成/更新 ${changed} 个资产图片节点。接下来可逐条提交生成。`, "ok");
}

function folderImportDepth(file) {
  const relativePath = String(file.webkitRelativePath || "");
  if (!relativePath) return 0;
  const parts = relativePath.split("/").filter(Boolean);
  return Math.max(0, parts.length - 2);
}

async function importAsset(file, options = {}) {
  const base64 = await fileToBase64(file);
  const data = await api("/api/assets/import", {
    method: "POST",
    body: JSON.stringify({
      project_id: state.projectId,
      file_name: file.name,
      mime: file.type || "application/octet-stream",
      base64,
      is_library_asset: true,
      asset_category: "other",
    }),
  });
  state.canvas = { ...state.canvas, assets: data.canvas?.assets || state.canvas.assets };
  state.pendingDeleteAssetId = null;
  const node = addAssetNode(data.asset);
  if (options.focus !== false) {
    ensureLeftSectionExpanded("assets");
    focusNode(node);
  }
  return { asset: data.asset, node };
}

async function importAssetFiles(files, options = {}) {
  const allFiles = Array.from(files || []).filter((file) => file && file.size >= 0);
  if (!allFiles.length) return;
  const maxDepth = options.folder ? 2 : Infinity;
  const allowedFiles = allFiles.filter((file) => folderImportDepth(file) <= maxDepth);
  const skipped = allFiles.length - allowedFiles.length;
  if (!allowedFiles.length) {
    setStatus("没有可导入的素材。文件夹导入只读取两级内的文件。", "bad");
    return;
  }
  setStatus(`正在导入 ${allowedFiles.length} 个素材...`);
  const imported = [];
  for (const file of allowedFiles) {
    const result = await importAsset(file, { focus: false });
    imported.push(result);
  }
  ensureLeftSectionExpanded("assets");
  const lastNode = imported[imported.length - 1]?.node;
  if (lastNode) focusNode(lastNode);
  await saveCanvas();
  const skippedText = skipped ? `，跳过 ${skipped} 个超过两级的文件` : "";
  setStatus(`已导入 ${imported.length} 个素材${skippedText}。已默认标记为资产并放到画布。`, "ok");
}

async function importRemoteAsset() {
  const urlInput = $("#remoteAssetUrl");
  const nameInput = $("#remoteAssetName");
  const remoteUrl = urlInput.value.trim();
  const name = nameInput.value.trim();
  if (!remoteUrl) {
    setStatus("先粘贴角色库图片 URL。", "bad");
    return;
  }
  const data = await api("/api/assets/url", {
    method: "POST",
    body: JSON.stringify({
      project_id: state.projectId,
      url: remoteUrl,
      name,
      is_library_asset: true,
      asset_category: "character",
    }),
  });
  state.canvas = data.canvas;
  state.pendingDeleteAssetId = null;
  const node = addAssetNode(data.asset);
  ensureLeftSectionExpanded("assets");
  focusNode(node);
  urlInput.value = "";
  nameInput.value = "";
  await saveCanvas();
  setStatus(`已导入 URL 素材：${data.asset.name}。已默认标记为资产，可直接去做标签绑定。`, "ok");
}

async function submitGeneration(nodeId, button = null) {
  const feedback = $("#submitFeedback");
  const forceDuplicate = state.pendingForceSubmitNodeId === nodeId;
  const originalText = button?.textContent || (forceDuplicate ? "仍然提交一条" : "提交生成任务");
  if (button) {
    button.disabled = true;
    button.textContent = "提交中...";
  }
  if (feedback) {
    feedback.textContent = "正在保存画布并提交生成任务。";
    feedback.className = "inline-feedback";
  }
  try {
    await saveCanvas();
    setStatus("正在提交生成任务...");
    const result = await api("/api/jobs/submit", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, node_id: nodeId, force_duplicate: forceDuplicate }),
    });
    if (!result.ok) {
      const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
      state.jobs = fresh.jobs;
      state.project = fresh.project;
      state.assetLibrary = fresh.asset_library || state.assetLibrary;
      if (result.duplicate_pending) {
        state.pendingForceSubmitNodeId = nodeId;
      } else {
        state.pendingForceSubmitNodeId = null;
      }
      renderJobs();
      renderInspector();
      const message = result.blocked
        ? `提交已暂停：还有 ${result.blockers.length} 个任务需要先处理。`
        : result.duplicate_pending
          ? "这条节点已有进行中的任务。若你就是要补发一条，再点一次“仍然提交一条”。"
        : (result.error || "生成任务失败，失败原因已保存。");
      setStatus(message, "bad");
      if (button) {
        button.disabled = false;
        button.textContent = result.duplicate_pending ? "仍然提交一条" : "重新提交";
      }
      if (feedback) {
        feedback.textContent = message;
        feedback.className = `inline-feedback ${result.duplicate_pending ? "" : "bad"}`.trim();
      }
      return;
    }
    state.pendingForceSubmitNodeId = null;
    if (result.job) upsertJob(result.job);
    renderJobs();
    renderInspector();
    scheduleAutoRefresh();
    const queuedForTail = result.job?.status === "queued" && result.job?.queue_reason === "waiting_prev_tail";
    const successMessage = queuedForTail
      ? (result.job?.failure_reason || "任务已进入任务记录，正在等待上一分镜尾帧。")
      : "任务已进入任务记录，平台处理中。";
    setStatus(successMessage, "ok");
    if (feedback) {
      feedback.textContent = successMessage;
      feedback.className = "inline-feedback ok";
    }
  } catch (error) {
    state.pendingForceSubmitNodeId = null;
    setStatus(error.message, "bad");
    if (button) {
      button.disabled = false;
      button.textContent = "重新提交";
    }
    if (feedback) {
      feedback.textContent = error.message;
      feedback.className = "inline-feedback bad";
    }
    return;
  }
  if (button) {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function runningJobsForAutoRefresh() {
  return state.jobs.filter((job) => job.status === "running" && (job.lovart_thread_id || job.jimeng_submit_id) && !state.jobActionLocks.has(job.job_id));
}

function runningJobsMissingPlatformHandle() {
  return state.jobs.filter((job) => job.status === "running" && !job.lovart_thread_id && !job.jimeng_submit_id);
}

function runningJobsWaitingForThread() {
  return state.jobs.filter((job) => (
    job.status === "running" && !job.lovart_thread_id && !job.jimeng_submit_id
  ) || (
    job.status === "queued" && job.queue_reason === "waiting_prev_tail"
  ));
}

function autoQuerySummary() {
  const queryable = runningJobsForAutoRefresh().length;
  const missingHandle = runningJobsMissingPlatformHandle().length;
  const parts = [];
  if (queryable) parts.push(`自动查询中：${queryable} 个，每 12 秒轮询`);
  if (state.autoRefreshingJobId) parts.push(`正在查 ${state.autoRefreshingJobId}`);
  if (missingHandle) parts.push(`${missingHandle} 个缺少平台会话，无法查询`);
  return parts.join("；");
}

function canvasInteractionBusy() {
  return Boolean(state.pan || state.marquee || state.nodeDrag || state.leftPanelResize);
}

function scheduleAutoRefresh() {
  if (state.canvasDirty || canvasInteractionBusy() || inspectorRecentlyActive()) {
    if (!state.autoRefreshTimer && !state.syncJobsTimer) {
      state.syncJobsTimer = setTimeout(() => {
        state.syncJobsTimer = null;
        scheduleAutoRefresh();
      }, 1500);
    }
    return;
  }
  if (state.autoRefreshTimer) {
    clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (state.syncJobsTimer) {
    clearTimeout(state.syncJobsTimer);
    state.syncJobsTimer = null;
  }
  if (state.autoRefreshingJobId) return;
  if (runningJobsForAutoRefresh().length) {
    state.autoRefreshTimer = setTimeout(() => {
      autoRefreshRunningJobs().catch((error) => {
        console.error(error);
      });
    }, 12000);
    return;
  }
  if (runningJobsWaitingForThread().length) {
    state.syncJobsTimer = setTimeout(() => {
      syncJobsState(true).catch((error) => {
        console.error(error);
      });
    }, 1500);
  }
}

async function autoRefreshRunningJobs() {
  if (state.autoRefreshingJobId) return;
  if (canvasInteractionBusy() || inspectorRecentlyActive()) {
    scheduleAutoRefresh();
    return;
  }
  const job = runningJobsForAutoRefresh()
    .slice()
    .sort((a, b) => String(a.updated_at || a.created_at || "").localeCompare(String(b.updated_at || b.created_at || "")))[0];
  if (!job) return;
  state.autoRefreshingJobId = job.job_id;
  try {
    await refreshJob(job.job_id, { silent: true, source: "auto" });
  } finally {
    state.autoRefreshingJobId = null;
    scheduleAutoRefresh();
  }
}

async function refreshRunningJobsNow() {
  const jobs = runningJobsForAutoRefresh().slice();
  if (!jobs.length) {
    const missing = runningJobsMissingPlatformHandle().length;
    setStatus(missing ? `${missing} 个生成中任务缺少平台会话 ID，无法查询，建议重新提交。` : "当前没有可查询的生成中任务。", missing ? "bad" : "");
    return;
  }
  setStatus(`正在查询 ${jobs.length} 个生成中任务...`);
  for (const job of jobs) {
    await refreshJob(job.job_id, { silent: true, source: "manual_all" });
  }
  setStatus(`已查询 ${jobs.length} 个生成中任务。`, "ok");
  scheduleAutoRefresh();
}

async function refreshJob(jobId, options = {}) {
  const silent = Boolean(options.silent);
  if (state.jobActionLocks.has(jobId)) return;
  state.jobActionLocks.add(jobId);
  if (!silent) setStatus("正在刷新平台结果...");
  try {
    const result = await api("/api/jobs/refresh", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, job_id: jobId }),
    });
    const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
    state.jobs = fresh.jobs;
    state.canvas = fresh.canvas;
    state.project = fresh.project;
    state.assetLibrary = fresh.asset_library || state.assetLibrary;
    if (silent && !result.ok) {
      renderJobStateOnly();
    } else {
      render();
    }
    if (!result.ok) {
      if (!silent) {
        setStatus(result.error || "平台还没有可下载结果。", "bad");
      }
      return;
    }
    if (!silent) {
      setStatus("平台结果已下载并挂回画布。", "ok");
    } else if ((result.assets || []).length) {
      setStatus("平台结果已自动下载并挂回画布。", "ok");
    }
    if (state.bulkSubmit.active) {
      processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
    }
  } finally {
    state.jobActionLocks.delete(jobId);
  }
}

async function confirmJob(jobId) {
  if (state.jobActionLocks.has(jobId)) return;
  state.jobActionLocks.add(jobId);
  setStatus("正在确认 Lovart 高消耗任务...");
  try {
    const result = await api("/api/jobs/confirm", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, job_id: jobId }),
    });
    const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
    state.jobs = fresh.jobs;
    state.canvas = fresh.canvas;
    state.project = fresh.project;
    state.assetLibrary = fresh.asset_library || state.assetLibrary;
    render();
    if (!result.ok) {
      setStatus(result.error || "Lovart 确认后还没有可下载结果。", "bad");
      return;
    }
    if (result.pending) {
      setStatus("Lovart 已确认，平台继续生成中。你可以继续提交别的任务。", "ok");
      return;
    }
    setStatus((result.assets || []).length ? "Lovart 已确认并下载结果。" : "Lovart 已确认，这条结果之前已经拿回来了。", "ok");
    if (state.bulkSubmit.active) {
      processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
    }
  } finally {
    state.jobActionLocks.delete(jobId);
  }
}

function setJobReplyFeedback(jobId, message, tone = "") {
  const el = document.querySelector(`[data-job-reply-status="${CSS.escape(jobId)}"]`);
  if (!el) return;
  el.textContent = message || "";
  el.className = `job-reply-status ${tone}`.trim();
}

async function replyJob(jobId, defaultMessage = "", triggerButton = null) {
  if (state.jobActionLocks.has(jobId)) return;
  const textarea = document.querySelector(`[data-job-reply-message="${CSS.escape(jobId)}"]`);
  const message = String(textarea?.value || defaultMessage || "").trim();
  if (!message) {
    setStatus("先写一句给 Lovart 的处理方式。", "bad");
    textarea?.focus();
    return;
  }
  state.jobActionLocks.add(jobId);
  const originalButtonText = triggerButton?.textContent || "";
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "发送中...";
  }
  setJobReplyFeedback(jobId, "正在发送到 Lovart...");
  setStatus("正在把处理方式发回 Lovart...");
  try {
    const result = await api("/api/jobs/reply", {
      method: "POST",
      body: JSON.stringify({ project_id: state.projectId, job_id: jobId, message }),
    });
    const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
    state.jobs = fresh.jobs;
    state.canvas = fresh.canvas;
    state.project = fresh.project;
    state.assetLibrary = fresh.asset_library || state.assetLibrary;
    render();
    if (!result.ok) {
      setJobReplyFeedback(jobId, "发送失败", "bad");
      setStatus(result.error || "Lovart 回复后还没有可下载结果。", "bad");
      return;
    }
    if (result.pending) {
      setStatus("Lovart 已收到处理方式，继续生成中。", "ok");
      return;
    }
    setStatus((result.assets || []).length ? "Lovart 已继续生成并下载结果。" : "Lovart 已处理，这条结果之前已经拿回来了。", "ok");
    if (state.bulkSubmit.active) {
      processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
    }
  } finally {
    state.jobActionLocks.delete(jobId);
    if (triggerButton?.isConnected) {
      triggerButton.disabled = false;
      triggerButton.textContent = originalButtonText;
    }
  }
}

async function markRateLimitedHandled(jobId) {
  const result = await api("/api/jobs/mark-handled", {
    method: "POST",
    body: JSON.stringify({ project_id: state.projectId, job_id: jobId }),
  });
  const fresh = await api(`/api/project?project_id=${encodeURIComponent(state.projectId)}`);
  state.jobs = fresh.jobs;
  state.assetLibrary = fresh.asset_library || state.assetLibrary;
  renderJobs();
  setStatus(result.ok ? "并发限制已标记为处理完成，可以重新提交。" : "状态更新失败。", result.ok ? "ok" : "bad");
  if (state.bulkSubmit.active) {
    processBulkSubmitQueue().catch((error) => stopBulkSubmit(error.message));
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("DOMContentLoaded", async () => {
  const contextMenu = $("#contextMenu");
  applyLeftPanelWidth(leftPanelWidth());
  bindLeftPanelResize();
  setPreferredSeedancePlatform(getPreferredSeedancePlatform());
  applyLeftSectionState();
  window.addEventListener("resize", () => {
    renderCanvasOnly();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.canvasDirty && !readCanvasDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  $("#toggleLeftPanel").addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("left-collapsed");
    $("#toggleLeftPanel").textContent = collapsed ? "显示左栏" : "隐藏左栏";
    hideContextMenu();
    renderCanvasOnly();
  });
  document.querySelectorAll("[data-toggle-section]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.toggleSection === "assets") state.pendingDeleteAssetId = null;
      toggleLeftSection(button.dataset.toggleSection);
    });
  });
  $("#createProject").addEventListener("click", openProjectPicker);
  $("#saveProjectRoot").addEventListener("click", saveProjectRoot);
  $("#saveCanvas").addEventListener("click", () => {
    saveCanvas().catch((error) => setStatus(error.message, "bad"));
  });
  $("#restoreCanvasDraft")?.addEventListener("click", () => {
    restoreCanvasDraft().catch((error) => setStatus(`恢复本地备份失败：${error.message}`, "bad"));
  });
  $("#discardCanvasDraft")?.addEventListener("click", () => {
    clearCanvasDraft();
    setStatus("已忽略本地备份。", "ok");
  });
  $("#assetFile").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) await importAssetFiles(files);
    event.target.value = "";
  });
  $("#assetFolder")?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) await importAssetFiles(files, { folder: true });
    event.target.value = "";
  });
  $("#openShotsImport")?.addEventListener("click", () => {
    ensureLeftSectionExpanded("shot-import");
    scrollToLeftSection("shot-import");
    $("#shotsFile")?.click();
  });
  $("#openProjectTags")?.addEventListener("click", () => {
    ensureLeftSectionExpanded("project-tags");
    scrollToLeftSection("project-tags");
  });
  $("#openAssetsPanel")?.addEventListener("click", () => {
    ensureLeftSectionExpanded("assets");
    scrollToLeftSection("assets");
  });
  $("#importRemoteAsset").addEventListener("click", () => importRemoteAsset());
  $("#remoteAssetUrl").addEventListener("keydown", (event) => {
    if (event.key === "Enter") importRemoteAsset();
  });
  $("#remoteAssetName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") importRemoteAsset();
  });
  $("#shotsFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importShotsFile(file);
    event.target.value = "";
  });
  $("#seedancePlatformPreference")?.addEventListener("change", (event) => {
    setPreferredSeedancePlatform(event.target.value);
    state.shots = sanitizeShotsForState(state.shots || []);
    renderShotTable();
    setStatus(`Seedance 默认平台已改成 ${platformLabel(getPreferredSeedancePlatform())}。`, "ok");
  });
  $("#assetLibraryFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importAssetLibraryFile(file);
    event.target.value = "";
  });
  $("#assetLibraryJsonlFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importAssetLibraryJsonlFile(file);
    event.target.value = "";
  });
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => addNode(button.dataset.add, defaultNodeData(button.dataset.add)));
  });
  document.querySelectorAll("[data-context-add]").forEach((button) => {
    button.addEventListener("click", () => {
      addNodeFromContext(button.dataset.contextAdd);
    });
  });
  document.querySelectorAll("[data-right-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.rightTab = button.dataset.rightTab;
      render();
    });
  });
  $("#createAssetNodes").addEventListener("click", () => createAssetTemplateNodes());
  $("#assetLibraryModel").addEventListener("change", async (event) => {
    state.assetLibrary.image_model = event.target.value;
    await saveAssetLibrary();
    renderAssetLibrary();
    setStatus("资产库统一图片模型已保存。", "ok");
  });
  $("#saveLovartKey").addEventListener("click", saveLovartKey);
  $("#toggleMarqueeMode").addEventListener("click", () => {
    hideContextMenu();
    toggleSelectionMode();
  });
  $("#connectMode").addEventListener("click", () => {
    hideContextMenu();
    startConnectFromSelection();
  });
  $("#bulkSubmitSelected").addEventListener("click", () => {
    hideContextMenu();
    startBulkSubmitSelected();
  });
  $("#deleteEdge").addEventListener("click", () => {
    hideContextMenu();
    if (!state.selectedEdgeId) return setStatus("先点击选择一条连线。", "bad");
    deleteEdge();
  });
  $("#alignLeft").addEventListener("click", () => {
    hideContextMenu();
    alignSelectedNodes("x");
  });
  $("#alignTop").addEventListener("click", () => {
    hideContextMenu();
    alignSelectedNodes("y");
  });
  $("#distributeHorizontal").addEventListener("click", () => {
    hideContextMenu();
    distributeSelectedNodes("x");
  });
  $("#distributeVertical").addEventListener("click", () => {
    hideContextMenu();
    distributeSelectedNodes("y");
  });
  document.querySelectorAll("[data-close-preview]").forEach((button) => {
    button.addEventListener("click", closeVideoPreview);
  });
  document.querySelectorAll("[data-close-shot-conflict]").forEach((button) => {
    button.addEventListener("click", closeShotConflict);
  });
  document.querySelectorAll("[data-close-seedance-import]").forEach((button) => {
    button.addEventListener("click", () => closeSeedanceImportModal());
  });
  document.querySelectorAll("[data-close-tag-picker]").forEach((button) => {
    button.addEventListener("click", closeTagPicker);
  });
  document.querySelectorAll("[data-close-project-picker]").forEach((button) => {
    button.addEventListener("click", closeProjectPicker);
  });
  $("#shotConflictApply").addEventListener("click", () => applyShotConflictDecision("overwrite"));
  $("#shotConflictSkip").addEventListener("click", () => applyShotConflictDecision("skip"));
  $("#seedanceImportLovart")?.addEventListener("click", () => closeSeedanceImportModal("lovart"));
  $("#seedanceImportJimeng")?.addEventListener("click", () => closeSeedanceImportModal("jimeng_cli"));
  $("#tagPickerSave").addEventListener("click", saveTagPicker);
  $("#projectCreateConfirm").addEventListener("click", createProjectFromPicker);
  $("#capturePreviewFrame").addEventListener("click", () => {
    if (!state.previewVideoNodeId) return setStatus("先打开一个视频预览。", "bad");
    captureVideoFrame(state.previewVideoNodeId, true);
  });
  $("#clearSelection").addEventListener("click", () => {
    hideContextMenu();
    clearPendingCanvasDelete();
    clearNodeSelection();
    state.selectedEdgeId = null;
    clearConnectSources();
    state.marquee = null;
    setStatus("已取消选择。");
    render();
  });
  $("#zoomOut").addEventListener("click", () => {
    hideContextMenu();
    const rect = canvasEl.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
  });
  $("#zoomIn").addEventListener("click", () => {
    hideContextMenu();
    const rect = canvasEl.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, -1);
  });
  $("#fitCanvas").addEventListener("click", () => {
    hideContextMenu();
    fitToNodes();
  });
  $("#resetView").addEventListener("click", () => {
    hideContextMenu();
    resetView();
  });
  canvasEl.addEventListener("click", () => {
    if (state.suppressCanvasClick) {
      state.suppressCanvasClick = false;
      return;
    }
    clearNodeSelection();
    state.selectedEdgeId = null;
    clearConnectSources();
    contextMenu.hidden = true;
    render();
  });
  canvasEl.addEventListener("contextmenu", (event) => {
    const portHit = findPortAtScreen(event.clientX, event.clientY);
    if (!portHit && event.target !== canvasEl && event.target !== worldEl) return;
    event.preventDefault();
    state.selectionMode = false;
    state.marquee = null;
    renderToolbarState();
    if (portHit) {
      openCanvasContextMenu(
        event.clientX,
        event.clientY,
        nodePortInsertPosition(portHit.node, portHit.port),
        { nodeId: portHit.node.id, port: portHit.port }
      );
      return;
    }
    openCanvasContextMenu(event.clientX, event.clientY, screenToWorld(event.clientX, event.clientY));
  });
  canvasEl.addEventListener("wheel", (event) => {
    hideContextMenu();
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY);
  }, { passive: false });
  canvasEl.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvasEl.addEventListener("pointerdown", (event) => {
    if (event.button === 1) {
      hideContextMenu();
      beginCanvasPan(event);
      return;
    }
    if (event.target !== canvasEl && event.target !== worldEl) return;
    hideContextMenu();
    if (event.button === 2) return;
    if (state.selectionMode || event.shiftKey) {
      state.marquee = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
        moved: false,
      };
      renderCanvasOnly();
      return;
    }
    beginCanvasPan(event);
  });
  window.addEventListener("pointermove", (event) => {
    if (state.marquee) {
      state.marquee.currentX = event.clientX;
      state.marquee.currentY = event.clientY;
      state.marquee.moved = state.marquee.moved
        || Math.abs(event.clientX - state.marquee.startX) > 3
        || Math.abs(event.clientY - state.marquee.startY) > 3;
      renderCanvasOnly();
      return;
    }
    if (!state.pan) return;
    state.viewport.x = state.pan.originX + event.clientX - state.pan.startX;
    state.viewport.y = state.pan.originY + event.clientY - state.pan.startY;
    state.pan.moved = state.pan.moved
      || Math.abs(event.clientX - state.pan.startX) > 3
      || Math.abs(event.clientY - state.pan.startY) > 3;
    renderCanvasOnly();
  });
  window.addEventListener("pointerup", () => {
    if (state.marquee) {
      if (state.marquee.moved) {
        applyMarqueeSelection();
        state.suppressCanvasClick = true;
        setStatus(`已框选 ${selectedNodeIds().length} 个节点。`, "ok");
      }
      state.marquee = null;
      render();
      return;
    }
    if (state.pan?.moved) state.suppressCanvasClick = true;
    state.pan = null;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      if (!$("#videoPreviewModal")?.hidden) closeVideoPreview();
    }
    const editing = isEditingElement(event.target) || isEditingElement(document.activeElement);
    if (!editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        hideContextMenu();
        toggleSelectionMode();
        return;
      }
      if (key === "c") {
        event.preventDefault();
        hideContextMenu();
        startConnectFromSelection();
        return;
      }
      if (key === "f") {
        event.preventDefault();
        hideContextMenu();
        fitToNodes();
        return;
      }
    }
    if ((event.key === "Backspace" || event.key === "Delete") && inspectorRecentlyActive()) {
      return;
    }
    if (!editing && (event.key === "Backspace" || event.key === "Delete") && state.selectedNodeId) {
      event.preventDefault();
      deleteNode(state.selectedNodeId);
    } else if (!editing && (event.key === "Backspace" || event.key === "Delete") && state.selectedEdgeId) {
      event.preventDefault();
      deleteEdge(state.selectedEdgeId);
    }
  });

  try {
    await loadSettings();
    await loadProject(await initialProjectId());
    api("/api/lovart/parameters")
      .then((params) => {
        state.params = params;
        renderParams();
        renderInspector();
      })
      .catch((error) => {
        setStatus(`项目已打开，Lovart 参数稍后再同步：${error.message}`, "bad");
        renderParams();
      });
  } catch (error) {
    setStatus(error.message, "bad");
    render();
  }
});
