const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

process.env.AI_VIDEO_PROJECTS_DIR = path.join(__dirname, "projects");

const {
  assetsFromLovartResult,
  assetTemplateOutputName,
  blockingJobs,
  buildJimengReferencePrompt,
  buildReferencePromptText,
  buildTags,
  canStartQueuedJob,
  cleanGeneratedAssets,
  connectImageResultsToShotVideo,
  createProject,
  defaultPromptFeedbackPresets,
  deleteQueuedJobFromProject,
  deleteShotsFromProject,
  deepSeekHttpErrorMessage,
  extractJsonObject,
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
  parseShotlistHtml,
  parseAssetLibraryJsonl,
  parseShots,
  pruneDormantJobsForTarget,
  rateLimitHandledReason,
  recordProcessedDownloads,
  requeueFailedJobFromProject,
  safeName,
  saveScript,
  uniquePath,
} = require("./server");

const shots = parseShots(`1 | @女医生 | @门诊室
2 |  | @女医生
3\t@男患者\t@门诊室`);

assert.equal(shots.length, 3);
assert.deepEqual(shots[0].tag_refs, ["@女医生", "@门诊室"]);
assert.equal(shots[1].image_prompt, "");
assert.equal(shots[1].video_prompt, "@女医生");

const mixedLanguageTagShots = parseShots("1 | @Jack Blackwood 黑木伍德 | @Misty Dock 雾港码头");
assert.deepEqual(mixedLanguageTagShots[0].tag_refs, ["@Jack Blackwood 黑木伍德", "@Misty Dock 雾港码头"]);

const tags = buildTags(shots, [
  {
    tag_id: "tag_existing",
    label: "@女医生",
    referenced_by_shot_ids: [],
    bound_asset_ids: ["asset_1"],
  },
]);

const doctor = tags.find((tag) => tag.label === "@女医生");
assert.equal(doctor.tag_id, "tag_existing");
assert.deepEqual(doctor.bound_asset_ids, ["asset_1"]);
assert.deepEqual(doctor.referenced_by_shot_ids, ["1", "2"]);

assert.equal(safeName('a/b:c*?"<>|'), "a_b_c______");
const appSource = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
const tagHelperSource = appSource.slice(appSource.indexOf("function tagsFromText"), appSource.indexOf("function firstAvailableModel"));
const tagHelperContext = { result: null };
vm.runInNewContext(`${tagHelperSource}
result = tagRefsForPrompt("@里奥父亲\\n看向门口", [
  { label: "@里奥", aliases: [] },
  { label: "@里奥父亲", aliases: [] },
]);`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["@里奥父亲"]);
vm.runInNewContext(`${tagHelperSource}
result = tagRefsForPrompt("@Night Beach Camp — fog rolls in", [
  { label: "@Night", aliases: [] },
  { label: "@Night Beach Camp", aliases: [] },
]);`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["@Night Beach Camp — fog rolls in"]);
vm.runInNewContext(`${tagHelperSource}
result = tagRefsForPrompt("@Jack Blackwood 黑木伍德\\n【镜头1】他站在码头。", []);`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["@Jack Blackwood 黑木伍德"]);
vm.runInNewContext(`${tagHelperSource}
result = [
  exactTagBindingName("@里奥"),
  exactTagBindingName("里奥"),
  exactTagBindingName("  @Night Beach Camp  "),
];`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["里奥", "里奥", "Night Beach Camp"]);

const autoBindSource = appSource
  .slice(appSource.indexOf("async function autoBindTagsByExactAssetName"), appSource.indexOf("function renderTagPickerPreview"))
  .replace("async function autoBindTagsByExactAssetName", "function autoBindTagsByExactAssetName")
  .replace("await api(", "api(");
const autoBindContext = {
  result: null,
  state: {
    projectId: "测试项目",
    canvas: {
      assets: [{ asset_id: "asset_1", name: "original-file-name.png", is_library_asset: true }],
      nodes: [{ id: "node_1", type: "image", data: { asset_id: "asset_1", title: "里奥" } }],
    },
    tags: [{ tag_id: "tag_1", label: "@里奥", bound_asset_ids: [] }],
  },
  exactTagBindingName: (text) => String(text || "").trim().replace(/^@/, "").trim(),
  api: () => ({ ok: true }),
  renderTags() {},
  renderToolbarState() {},
  renderInspector() {},
  alert() {},
};
vm.runInNewContext(`
function libraryAssets() { return state.canvas.assets.filter((asset) => asset.is_library_asset); }
function assetById(assetId) { return state.canvas.assets.find((asset) => asset.asset_id === assetId); }
function setStatus(message, kind) { result = { message, kind, tags: state.tags }; }
${autoBindSource}
autoBindTagsByExactAssetName();`, autoBindContext);
assert.deepEqual(autoBindContext.state.tags[0].bound_asset_ids, ["asset_1"]);
assert.match(autoBindContext.result.message, /节点名称/);

const seedanceImportSource = appSource.slice(appSource.indexOf("function isKlingModelName"), appSource.indexOf("function splitParametersByPlatform"));
const seedanceImportContext = { result: null };
vm.runInNewContext(`
function normalizePlatform(value) { return value === "jimeng_cli" ? "jimeng_cli" : "lovart"; }
function extractDurationFromPrompt() { return ""; }
function extractAspectRatioFromPrompt() { return ""; }
${seedanceImportSource}
result = applySeedancePlatformToImportedShots([
  {
    shot_id: "1",
    platform: "lovart",
    transition: "video_direct",
    video_model: "generate_video_seedance_v2_0",
    video_prompt: "@里奥\\n8秒。16:9。",
  },
], "jimeng_cli")[0];`, seedanceImportContext);
assert.equal(seedanceImportContext.result.platform, "jimeng_cli");
assert.equal(seedanceImportContext.result.video_model, "seedance2.0");

const statusHelperSource = appSource.slice(appSource.indexOf("function statusInfoFromJob"), appSource.indexOf("function jobFailureReason"));
const statusHelperContext = { result: null };
vm.runInNewContext(`${statusHelperSource}
result = statusInfoFromJob({ status: "running", platform: "lovart" });`, statusHelperContext);
assert.equal(statusHelperContext.result.label, "提交中");
vm.runInNewContext(`${statusHelperSource}
result = statusInfoFromJob({ status: "running", platform: "lovart", lovart_thread_id: "thread_1" });`, statusHelperContext);
assert.equal(statusHelperContext.result.label, "生成中");

const generatorUpsertSource = `
const GENERATION_PLATFORMS = [{ value: "lovart" }, { value: "jimeng_cli" }];
const state = {
  canvas: {
    nodes: [
      {
        id: "video_gen_1",
        type: "videoGen",
        x: 0,
        y: 0,
        data: {
          shot_id: "1",
          shot_role: "video",
          platform: "lovart",
          common_parameters: { model: "generate_video_seedance_v2_0_fast", duration: "5s" },
          platform_parameters: { lovart: { feature: "all_reference" } },
        },
      },
    ],
    edges: [],
  },
};
function uid(prefix) { return prefix + "_test"; }
function workflowPreset() { return { id: "story", label: "故事工作流" }; }
function normalizePlatform(value) { return GENERATION_PLATFORMS.some((item) => item.value === value) ? value : "lovart"; }
${appSource.slice(appSource.indexOf("function splitParametersByPlatform"), appSource.indexOf("function defaultImageParameters"))}
${appSource.slice(appSource.indexOf("function findShotNode"), appSource.indexOf("function upsertEdge"))}
${appSource.slice(appSource.indexOf("function upsertShotGeneratorNode"), appSource.indexOf("function upsertAssetTemplateNode"))}
const updated = upsertShotGeneratorNode(
  "videoGen",
  { shot_id: "1", platform: "jimeng_cli" },
  "video",
  { x: 100, y: 100 },
  "next prompt",
  { platform: "jimeng_cli", model: "seedance2.0", duration: "8s", mode: "multimodal2video", video_resolution: "720p" },
  "分镜 1 视频"
);
result = {
  platform: updated.data.platform,
  model: updated.data.common_parameters.model,
  duration: updated.data.common_parameters.duration,
  mode: updated.data.platform_parameters.jimeng_cli.mode,
  lovartFeature: updated.data.platform_parameters.lovart.feature,
};
`;
const generatorUpsertContext = { result: null };
vm.runInNewContext(generatorUpsertSource, generatorUpsertContext);
assert.deepEqual(generatorUpsertContext.result, {
  platform: "jimeng_cli",
  model: "seedance2.0",
  duration: "8s",
  mode: "multimodal2video",
  lovartFeature: "all_reference",
});

const lovartReferenceText = buildReferencePromptText("image", [
  {
    asset_kind: "image",
    asset_name: "leo_father.png",
    primary_tag_label: "@里奥父亲",
    tag_labels: ["@里奥父亲"],
    reference_role: "character_reference",
  },
  {
    asset_kind: "image",
    asset_name: "leo.png",
    primary_tag_label: "@里奥",
    tag_labels: ["@里奥"],
    reference_role: "character_reference",
  },
]);
assert.match(lovartReferenceText, /附件1 \/ 图片1 = @里奥父亲 \/ leo_father\.png（角色参考）/);
assert.match(lovartReferenceText, /附件2 \/ 图片2 = @里奥 \/ leo\.png（角色参考）/);
assert.ok(!lovartReferenceText.includes("角色1参考"));
const tailFrameReferenceText = buildReferencePromptText("video", [
  {
    asset_kind: "image",
    asset_name: "tail.png",
    primary_tag_label: "@上一镜尾帧",
    tag_labels: ["@上一镜尾帧"],
    reference_role: "tail_frame",
  },
]);
assert.match(tailFrameReferenceText, /附件1 \/ 图片1 = @上一镜尾帧 \/ tail\.png（尾帧参考）/);
assert.match(tailFrameReferenceText, /不要当成首帧/);
const jimengReferenceText = buildJimengReferencePrompt([
  {
    asset: { kind: "image" },
    asset_name: "tail.png",
    primary_tag_label: "@上一镜尾帧",
    reference_role: "tail_frame",
  },
], "multimodal2video");
assert.match(jimengReferenceText, /@图片1=上一镜尾帧（尾帧参考）/);
const jimengRoleOnlyReferenceText = buildJimengReferencePrompt([
  {
    asset: { kind: "image" },
    asset_name: "",
    primary_tag_label: "",
    reference_role: "character_reference",
  },
  {
    asset: { kind: "image" },
    asset_name: "",
    primary_tag_label: "",
    reference_role: "scene_reference",
  },
  {
    asset: { kind: "image" },
    asset_name: "",
    primary_tag_label: "",
    reference_role: "first_frame",
  },
], "multimodal2video");
assert.match(jimengRoleOnlyReferenceText, /@图片1=角色参考/);
assert.match(jimengRoleOnlyReferenceText, /@图片2=场景参考/);
assert.match(jimengRoleOnlyReferenceText, /@图片3=首帧参考/);
const jimengGeneratedFrameReferenceText = buildJimengReferencePrompt([
  {
    asset: { kind: "image", name: "分镜分镜01-3-14_静帧" },
    asset_name: "分镜分镜01-3-14_静帧",
    primary_tag_label: "",
    reference_role: "first_frame",
  },
], "multimodal2video");
assert.match(jimengGeneratedFrameReferenceText, /@图片1=首帧参考/);
assert.ok(!jimengGeneratedFrameReferenceText.includes("分镜分镜01-3-14_静帧"));
assert.equal(rateLimitHandledReason({ platform: "lovart" }), "Lovart 并发限制已标记为处理完成，可重新提交任务。");
assert.equal(isJimengFinalGenerationFailure("generation failed: final generation failed"), true);
const jimengRetryNowMs = Date.parse("2026-06-05T12:01:00.000Z");
assert.equal(
  canAutoRetryJimengJob(
    { platform: "jimeng_cli", auto_retry_count: 1, submitted_at: "2026-06-05T12:00:30.000Z" },
    "generation failed: final generation failed",
    { nowMs: jimengRetryNowMs }
  ),
  true
);
assert.equal(
  canAutoRetryJimengJob(
    { platform: "jimeng_cli", auto_retry_count: 0, submitted_at: "2026-06-05T11:58:59.000Z" },
    "generation failed: final generation failed",
    { nowMs: jimengRetryNowMs }
  ),
  false
);
assert.equal(canAutoRetryJimengJob({ platform: "jimeng_cli", auto_retry_count: 0 }, "generation failed: final generation failed", { nowMs: jimengRetryNowMs }), false);
assert.equal(canAutoRetryJimengJob({ platform: "jimeng_cli", auto_retry_count: 2, submitted_at: "2026-06-05T12:00:30.000Z" }, "generation failed: final generation failed", { nowMs: jimengRetryNowMs }), false);
assert.equal(canAutoRetryJimengJob({ platform: "lovart", auto_retry_count: 0, submitted_at: "2026-06-05T12:00:30.000Z" }, "generation failed: final generation failed", { nowMs: jimengRetryNowMs }), false);
assert.equal(isJimengVipModel("seedance2.0fast_vip"), true);
assert.equal(isJimengVipModel("seedance2.0fast"), false);
assert.match(jimengQueryTimeoutPendingReason(120000), /继续自动查询，不判定失败/);
const jimengRateLimitedJob = { status: "rate_limited", platform: "jimeng_cli" };
const activeJimengJob = { status: "running", platform: "jimeng_cli", jimeng_submit_id: "submit_1", parameters: { model: "seedance2.0fast" } };
const activeJimengSlowJob = { status: "running", platform: "jimeng_cli", jimeng_submit_id: "submit_2", parameters: { model: "seedance2.0" } };
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast" }, [jimengRateLimitedJob, activeJimengJob]), true);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0" }, [jimengRateLimitedJob, activeJimengJob]), false);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast" }, [jimengRateLimitedJob]), false);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast_vip" }), false);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "lovart", model: "generate_video_seedance_v2_0_fast" }), false);
assert.equal(blockingJobs([jimengRateLimitedJob], { platform: "jimeng_cli", model: "seedance2.0_vip" }).length, 0);
assert.equal(canStartQueuedJob([activeJimengJob], { platform: "jimeng_cli", parameters: { model: "seedance2.0fast" } }), false);
assert.equal(canStartQueuedJob([activeJimengJob], { platform: "jimeng_cli", parameters: { model: "seedance2.0" } }), true);
assert.equal(canStartQueuedJob([activeJimengJob, activeJimengSlowJob], { platform: "jimeng_cli", parameters: { model: "seedance2.0" } }), false);
assert.equal(canStartQueuedJob([activeJimengJob], { platform: "jimeng_cli", parameters: { model: "seedance2.0fast_vip" } }), true);
assert.equal(
  canStartQueuedJob(
    Array.from({ length: 8 }, (_, index) => ({ job_id: `lovart_${index}`, status: "running", platform: "lovart", lovart_thread_id: `thread_${index}` })),
    { platform: "lovart" }
  ),
  true
);
assert.equal(
  canStartQueuedJob(
    [
      ...Array.from({ length: 8 }, (_, index) => ({ job_id: `lovart_${index}`, status: "running", platform: "lovart", lovart_thread_id: `thread_${index}` })),
      { job_id: "submitting_lovart", status: "running", platform: "lovart" },
    ],
    { platform: "lovart" }
  ),
  false
);
assert.equal(
  canStartQueuedJob(
    Array.from({ length: 9 }, (_, index) => ({ job_id: `lovart_${index}`, status: "running", platform: "lovart", lovart_thread_id: `thread_${index}` })),
    { platform: "lovart" }
  ),
  false
);
assert.equal(
  canStartQueuedJob(
    [
      { job_id: "hit_limit", status: "rate_limited", platform: "lovart" },
      { job_id: "active_lovart", status: "running", platform: "lovart" },
    ],
    { platform: "lovart" }
  ),
  false
);
assert.deepEqual(
  pruneDormantJobsForTarget([
    { job_id: "old_wait", target_node_id: "node_1", status: "queued" },
    { job_id: "old_failed", target_node_id: "node_1", status: "failed" },
    { job_id: "active", target_node_id: "node_1", status: "running" },
    { job_id: "other", target_node_id: "node_2", status: "queued" },
  ], "node_1").map((job) => job.job_id),
  ["active", "other"]
);

const jsonlLibrary = parseAssetLibraryJsonl(`{"asset":"Jack Blackwood","category":"character","filename":"jack_blackwood.png","use":"Main character identity anchor for ship, beach, jungle, and camp scenes.","prompt":"portrait prompt","negative":"bad hands","source_file":"01_角色资产.md"}`);
assert.equal(jsonlLibrary.templates.length, 1);
assert.equal(jsonlLibrary.templates[0].label, "jack_blackwood");
assert.equal(jsonlLibrary.templates[0].filename, "jack_blackwood.png");
assert.ok(jsonlLibrary.templates[0].source_body.includes("portrait prompt"));
assert.ok(jsonlLibrary.templates[0].source_body.includes("Negative prompt: bad hands"));
assert.equal(assetTemplateOutputName({ asset_template_label: "jack_blackwood.png", asset_template_filename: "jack_blackwood.png" }), "jack_blackwood");

const htmlShots = parseShotlistHtml(`
  <h2 class="block-title">Episode 1 — Fog Island</h2>
  <tr data-scene="9" data-plan="WS"><td>9.1</td><td class="c-prompt" rowspan="2">
    <div class="prompt-head"><b>提示词 11</b> <span>[ECU→WS · rope knot]</span></div>
    <div class="prompt-block">@Night Beach Camp
【镜头1】动作：Billy消失，只留下绳结。
8秒。21:9。</div>
  </td></tr>
`, "lovart");
assert.equal(htmlShots.length, 1);
assert.equal(htmlShots[0].shot_id, "分镜1-9-11");
assert.equal(htmlShots[0].transition, "video_direct");
assert.equal(htmlShots[0].image_prompt, "");
assert.equal(htmlShots[0].duration, "8s");
assert.equal(htmlShots[0].size, "21:9");
assert.equal(htmlShots[0].video_model, "generate_video_seedance_v2_0_fast");

const modelAwareHtmlShots = parseShotlistHtml(`
  <h2 class="block-title">Episode 7</h2>
  <tr data-scene="1" data-plan="CU">
    <td class="c-num">01</td>
    <td><span>CU</span></td>
    <td class="c-model"><span class="field-pill">Kling3 Omni</span></td>
    <td class="c-link"><span class="link-pill">视频直出</span></td>
    <td class="c-prompt"><div class="prompt-head"><b>提示词 1</b></div><div class="prompt-block">@里奥 close beat.
7秒。21:9。</div></td>
  </tr>
  <tr data-scene="1" data-plan="PAN">
    <td class="c-num">02</td>
    <td><span>PAN</span></td>
    <td class="c-model"><span class="field-pill">Seedance2.0</span></td>
    <td class="c-link"><span class="link-pill">接上一尾帧</span></td>
    <td class="c-prompt"><div class="prompt-head"><b>提示词 2</b></div><div class="prompt-block">@外围药草地 action chain.
8秒。21:9。</div></td>
  </tr>
`, "jimeng_cli");
assert.equal(modelAwareHtmlShots[0].video_model, "generate_video_kling_v3_omni");
assert.equal(modelAwareHtmlShots[0].platform, "lovart");
assert.equal(modelAwareHtmlShots[0].transition, "video_direct");
assert.equal(modelAwareHtmlShots[1].video_model, "seedance2.0");
assert.equal(modelAwareHtmlShots[1].platform, "jimeng_cli");
assert.equal(modelAwareHtmlShots[1].transition, "continue_prev_tail");
assert.equal(modelAwareHtmlShots[1].expected_prev_shot_id, "分镜7-1-1");

const imagePromptHtmlShots = parseShotlistHtml(`
  <h2 class="block-title">Episode 3</h2>
  <tr data-scene="2" data-plan="WS">
    <td class="c-num">01</td>
    <td class="c-model"><span class="field-pill">Seedance2.0</span></td>
    <td class="c-link"><span class="link-pill">新建首帧</span></td>
    <td class="c-image-prompt">
      <div class="image-prompt-head"><b>图片提示词 1</b></div>
      <div class="image-prompt-block">@测试首帧骑手石门
A lone rider before a broken stone gate, 16:9 first frame.</div>
    </td>
    <td class="c-prompt">
      <div class="prompt-head"><b>提示词 1</b></div>
      <div class="prompt-block">@测试首帧骑手石门
从新建首帧开始生成视频。8秒。16:9。</div>
    </td>
  </tr>
`, "lovart");
assert.equal(imagePromptHtmlShots.length, 1);
assert.equal(imagePromptHtmlShots[0].shot_id, "分镜3-2-1");
assert.match(imagePromptHtmlShots[0].image_prompt, /A lone rider before a broken stone gate/);
assert.match(imagePromptHtmlShots[0].video_prompt, /从新建首帧开始生成视频/);
assert.deepEqual(imagePromptHtmlShots[0].tag_refs, ["@测试首帧骑手石门"]);

const sectionHtmlShots = parseShotlistHtml(`
  <h2 class="block-title">Episode 1 — Fog Island</h2>
  <section class="scene" id="sc9">
    <tr data-scene="9"><td class="c-prompt">
      <div class="prompt-head"><b>提示词 11</b></div>
      <div class="prompt-block">@Night Beach Camp — foggy camp.
8秒。21:9。</div>
    </td></tr>
  </section>
  <section class="scene" id="sc10">
    <tr data-scene="10"><td class="c-prompt">
      <div class="prompt-head"><b>提示词 12</b></div>
      <div class="prompt-block">@Fog Island Aerial — fog island.
10秒。21:9。</div>
    </td></tr>
  </section>
`, "lovart");
assert.equal(sectionHtmlShots.length, 2);
assert.equal(sectionHtmlShots[1].shot_id, "分镜1-10-12");
assert.ok(sectionHtmlShots[0].tag_refs.includes("@Night Beach Camp — foggy camp."));
assert.ok(!sectionHtmlShots[0].tag_refs.includes("@Night"));

const project = createProject("测试项目");
assert.equal(project.project.project_id, "测试项目");
for (const fileName of ["project.json", "canvas.json", "shots.json", "tags.json", "jobs.json", "prompt_context.json", "script.json", "asset_library.json"]) {
  assert.ok(fs.existsSync(path.join(__dirname, "projects", "测试项目", fileName)));
}
for (const dirName of ["input", "images", "videos", "thumbnails", "logs"]) {
  assert.ok(fs.existsSync(path.join(__dirname, "projects", "测试项目", dirName)));
}

const dir = path.join(__dirname, "projects", "测试项目", "images");
const first = path.join(dir, "分镜1.png");
fs.writeFileSync(first, "x");
assert.equal(path.basename(uniquePath(dir, "分镜1.png")), "分镜1_2.png");

const loaded = loadProject("测试项目");
assert.ok(Array.isArray(loaded.canvas.nodes));
assert.ok(Array.isArray(loaded.prompt_context.learnings));
assert.deepEqual(loaded.prompt_context.feedback_presets, defaultPromptFeedbackPresets());
assert.ok(Array.isArray(loaded.script.segments));

fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "canvas.json"), JSON.stringify({
  nodes: [
    { id: "img_a", type: "image", data: { asset_id: "asset_a" } },
    { id: "video_gen", type: "videoGen", data: {} },
    { id: "generated_result", type: "image", data: { asset_id: "asset_generated_result", source_job_id: "job_result" } },
  ],
  edges: [
    { id: "old_manual_edge", source: "img_a", target: "video_gen" },
    { id: "generated_edge", source: "generated_result", target: "video_gen" },
  ],
  assets: [
    { asset_id: "asset_a", name: "参考图", kind: "image", source: "input" },
    { asset_id: "asset_generated_result", name: "生成结果", kind: "image", source: "generated" },
  ],
}, null, 2));
const mergedAfterEdgeDelete = mergeCanvasForSave("测试项目", {
  nodes: [
    { id: "img_a", type: "image", data: { asset_id: "asset_a" } },
    { id: "video_gen", type: "videoGen", data: {} },
  ],
  edges: [],
  assets: [{ asset_id: "asset_a", name: "参考图", kind: "image", source: "input" }],
});
assert.ok(!mergedAfterEdgeDelete.edges.some((edge) => edge.id === "old_manual_edge"));
assert.ok(mergedAfterEdgeDelete.edges.some((edge) => edge.id === "generated_edge"));

const reusableFile = path.join(__dirname, "projects", "测试项目", "input", "里奥.png");
fs.writeFileSync(reusableFile, "reusable image");
fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "canvas.json"), JSON.stringify({
  nodes: [
    { id: "control_1", type: "globalControl", x: 10, y: 20, data: { title: "统一风格", text: "cinematic light" } },
    { id: "done_1", type: "image", x: 300, y: 20, data: { asset_id: "asset_generated" } },
  ],
  edges: [],
  assets: [
    { asset_id: "asset_reuse", name: "里奥", kind: "image", source: "input", is_library_asset: true, asset_category: "character", file_path: reusableFile },
    { asset_id: "asset_generated", name: "旧成品", kind: "image", source: "generated" },
  ],
}, null, 2));
fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "tags.json"), JSON.stringify([
  { tag_id: "tag_leo", label: "@里奥", referenced_by_shot_ids: ["1"], bound_asset_ids: ["asset_reuse"] },
], null, 2));
fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "asset_library.json"), JSON.stringify({
  global_rules: "reuse rules",
  image_model: "agent-auto",
  templates: [{ template_id: "tpl_1", name: "角色模板" }],
}, null, 2));
fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "jobs.json"), JSON.stringify([{ job_id: "old_job", status: "downloaded" }], null, 2));
fs.writeFileSync(path.join(__dirname, "projects", "测试项目", "shots.json"), JSON.stringify([{ shot_id: "1" }], null, 2));
const reusePack = exportProjectReusePackage("测试项目");
assert.equal(reusePack.package_type, "ai_video_reuse_pack");
assert.ok(reusePack.assets.some((asset) => asset.asset_id === "asset_reuse"));
assert.ok(!reusePack.assets.some((asset) => asset.asset_id === "asset_generated"));
assert.equal(reusePack.files.length, 1);
assert.equal(reusePack.global_controls.length, 1);
const importedReuse = importProjectReusePackage(reusePack, "复用包导入测试");
assert.equal(importedReuse.jobs.length, 0);
assert.equal(importedReuse.shots.length, 0);
assert.equal(importedReuse.canvas.nodes.filter((node) => node.type === "globalControl").length, 1);
assert.equal(importedReuse.tags[0].bound_asset_ids[0], "asset_reuse");
assert.ok(fs.existsSync(importedReuse.canvas.assets[0].file_path));

const savedScript = saveScript("测试项目", {
  source_text: "第一场\n角色进入门诊室。",
  segments: [{ segment_id: "scriptseg_1", title: "分镜1", text: "角色进入门诊室。", created_at: "now" }],
  bindings: [{ shot_id: "1", segment_id: "scriptseg_1" }],
});
assert.equal(savedScript.segments.length, 1);
assert.equal(savedScript.bindings[0].shot_id, "1");

createProject("删除分镜测试");
const deleteProjectDir = path.join(__dirname, "projects", "删除分镜测试");
fs.writeFileSync(path.join(deleteProjectDir, "shots.json"), JSON.stringify([
  { shot_id: "1", image_prompt: "@里奥 image", video_prompt: "@里奥 video", tag_refs: ["@里奥"] },
  { shot_id: "2", image_prompt: "@玛雅 image", video_prompt: "@玛雅 video", tag_refs: ["@玛雅"] },
], null, 2));
fs.writeFileSync(path.join(deleteProjectDir, "canvas.json"), JSON.stringify({
  nodes: [
    { id: "image_gen_1", type: "imageGen", data: { shot_id: "1", shot_role: "image" } },
    { id: "video_result_1", type: "video", data: { shot_id: "1", asset_id: "asset_done_1" } },
    { id: "image_gen_2", type: "imageGen", data: { shot_id: "2", shot_role: "image" } },
    { id: "control_1", type: "globalControl", data: { title: "全局控制" } },
  ],
  edges: [
    { id: "edge_1", source: "control_1", target: "image_gen_1" },
    { id: "edge_2", source: "control_1", target: "image_gen_2" },
  ],
  assets: [
    { asset_id: "asset_done_1", name: "分镜1成片", kind: "video", source: "generated" },
    { asset_id: "asset_input", name: "里奥", kind: "image", source: "input" },
  ],
}, null, 2));
fs.writeFileSync(path.join(deleteProjectDir, "jobs.json"), JSON.stringify([
  { job_id: "job_done_1", status: "downloaded", target_node_id: "image_gen_1", shot_ids: ["1"], output_asset_ids: ["asset_done_1"] },
  { job_id: "job_done_2", status: "downloaded", target_node_id: "image_gen_2", shot_ids: ["2"] },
], null, 2));
fs.writeFileSync(path.join(deleteProjectDir, "tags.json"), JSON.stringify([
  { tag_id: "tag_leo", label: "@里奥", referenced_by_shot_ids: ["1"], bound_asset_ids: ["asset_input"] },
  { tag_id: "tag_maya", label: "@玛雅", referenced_by_shot_ids: ["2"], bound_asset_ids: [] },
], null, 2));
fs.writeFileSync(path.join(deleteProjectDir, "prompt_context.json"), JSON.stringify({
  learnings: [],
  feedback_presets: defaultPromptFeedbackPresets(),
  revisions: [
    { revision_id: "rev_1", shot_id: "1" },
    { revision_id: "rev_2", shot_id: "2" },
  ],
}, null, 2));
fs.writeFileSync(path.join(deleteProjectDir, "script.json"), JSON.stringify({
  source_text: "script",
  segments: [
    { segment_id: "seg_1", text: "shot 1" },
    { segment_id: "seg_2", text: "shot 2" },
  ],
  bindings: [
    { shot_id: "1", segment_id: "seg_1" },
    { shot_id: "2", segment_id: "seg_2" },
  ],
}, null, 2));
const deletedShots = deleteShotsFromProject("删除分镜测试", ["1"]);
assert.equal(deletedShots.counts.shots, 1);
assert.equal(deletedShots.counts.nodes, 2);
assert.deepEqual(deletedShots.data.shots.map((shot) => shot.shot_id), ["2"]);
assert.deepEqual(deletedShots.data.canvas.nodes.map((node) => node.id).sort(), ["control_1", "image_gen_2"]);
assert.deepEqual(deletedShots.data.canvas.edges.map((edge) => edge.id), ["edge_2"]);
assert.ok(!deletedShots.data.canvas.assets.some((asset) => asset.asset_id === "asset_done_1"));
assert.deepEqual(deletedShots.data.jobs.map((job) => job.job_id), ["job_done_2"]);
assert.deepEqual(deletedShots.data.tags.map((tag) => tag.label), ["@玛雅"]);
assert.deepEqual(deletedShots.data.prompt_context.revisions.map((revision) => revision.revision_id), ["rev_2"]);
assert.deepEqual(deletedShots.data.script.bindings.map((binding) => binding.shot_id), ["2"]);
assert.deepEqual(deletedShots.data.script.segments.map((segment) => segment.segment_id), ["seg_2"]);

createProject("删除待提交任务测试");
const queuedJobProjectDir = path.join(__dirname, "projects", "删除待提交任务测试");
fs.writeFileSync(path.join(queuedJobProjectDir, "jobs.json"), JSON.stringify([
  { job_id: "job_queued", status: "queued", asset_template_id: "tpl_queued" },
  { job_id: "job_running", status: "running", target_node_id: "video_gen_1" },
], null, 2));
fs.writeFileSync(path.join(queuedJobProjectDir, "asset_library.json"), JSON.stringify({
  templates: [
    { template_id: "tpl_queued", status: "queued", failure_reason: "waiting" },
  ],
}, null, 2));
const deletedQueuedJob = deleteQueuedJobFromProject("删除待提交任务测试", "job_queued");
assert.equal(deletedQueuedJob.ok, true);
assert.deepEqual(deletedQueuedJob.jobs.map((job) => job.job_id), ["job_running"]);
assert.equal(deletedQueuedJob.asset_library.templates[0].status, "idle");
assert.equal(deletedQueuedJob.asset_library.templates[0].failure_reason, "");
const rejectedRunningJobDelete = deleteQueuedJobFromProject("删除待提交任务测试", "job_running");
assert.equal(rejectedRunningJobDelete.ok, false);
assert.match(rejectedRunningJobDelete.error, /只能删除待提交任务/);
assert.deepEqual(loadProject("删除待提交任务测试").jobs.map((job) => job.job_id), ["job_running"]);

fs.writeFileSync(path.join(queuedJobProjectDir, "jobs.json"), JSON.stringify([
  {
    job_id: "job_failed",
    status: "failed",
    platform: "jimeng_cli",
    target_node_id: "video_gen_1",
    failure_reason: "generation failed: final generation failed",
    auto_retry_count: 2,
    jimeng_submit_id: "old_submit",
    submitted_at: "2026-06-05T12:00:30.000Z",
    output_asset_ids: ["asset_old"],
    processed_download_keys: ["download_old"],
  },
], null, 2));
const requeuedFailedJob = requeueFailedJobFromProject("删除待提交任务测试", "job_failed");
assert.equal(requeuedFailedJob.ok, true);
assert.equal(requeuedFailedJob.job.status, "queued");
assert.equal(requeuedFailedJob.job.auto_retry_count, 0);
assert.equal(requeuedFailedJob.job.jimeng_submit_id, undefined);
assert.equal(requeuedFailedJob.job.submitted_at, undefined);
assert.deepEqual(requeuedFailedJob.job.output_asset_ids, []);
assert.deepEqual(requeuedFailedJob.job.processed_download_keys, []);
assert.equal(requeuedFailedJob.job.manual_retry_count, 1);

const optimized = normalizePromptOptimization({ revised_image_prompt: "new image" }, { image_prompt: "old image", video_prompt: "old video" });
assert.equal(optimized.revised_image_prompt, "new image");
assert.equal(optimized.revised_video_prompt, "old video");
assert.deepEqual(optimized.project_learning_suggestions, []);
const tagPreserved = normalizePromptOptimization(
  { revised_image_prompt: "new image", revised_video_prompt: "new video" },
  { image_prompt: "@女医生 old image", video_prompt: "@门诊室 old video", model: "generate_video_seedance_v2_0_fast" }
);
assert.ok(tagPreserved.revised_image_prompt.startsWith("@女医生"));
assert.ok(tagPreserved.revised_video_prompt.startsWith("@门诊室"));
assert.match(tagPreserved.warnings.join("\n"), /自动补回/);
const klingNoTagBackfill = normalizePromptOptimization(
  { revised_video_prompt: "natural language video" },
  { video_prompt: "@女医生 old video", model: "generate_video_kling_v2_6" }
);
assert.equal(klingNoTagBackfill.revised_video_prompt, "natural language video");
assert.throws(() => extractJsonObject("not json"), /模型返回格式异常|Unexpected token/);
assert.equal(normalizeDeepSeekBaseUrl("http://api.deepseek.com/"), "https://api.deepseek.com");
assert.equal(normalizeDeepSeekBaseUrl("api.deepseek.com/v1/"), "https://api.deepseek.com/v1");
assert.match(
  deepSeekHttpErrorMessage(301, { raw: "<html><h1>301 Moved Permanently</h1><center>openresty</center></html>" }, { location: "https://api.deepseek.com/chat/completions" }),
  /Base URL/
);

const dedupeJob = { kind: "image", shot_ids: ["1"], processed_download_keys: [] };
const downloadedFile = path.join(dir, "lovart_tmp.png");
fs.writeFileSync(downloadedFile, "x");
const firstPassAssets = assetsFromLovartResult("测试项目", dedupeJob, {
  downloaded: [{ local_path: downloadedFile, url: "https://example.com/a.png" }],
});
assert.equal(firstPassAssets.length, 1);
recordProcessedDownloads(dedupeJob, firstPassAssets);
const cleanFirstPass = cleanGeneratedAssets(firstPassAssets);
assert.ok(!("download_key" in cleanFirstPass[0]));
const secondPassAssets = assetsFromLovartResult("测试项目", dedupeJob, {
  downloaded: [{ local_path: cleanFirstPass[0].file_path, url: "https://example.com/a.png" }],
});
assert.equal(secondPassAssets.length, 0);

const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-video-projects-"));
process.env.AI_VIDEO_PROJECTS_DIR = customRoot;
const customProject = createProject("自定义目录项目");
assert.equal(customProject.project.project_id, "自定义目录项目");
assert.ok(fs.existsSync(path.join(customRoot, "自定义目录项目", "project.json")));
delete process.env.AI_VIDEO_PROJECTS_DIR;

const flowCanvas = {
  nodes: [
    { id: "image_gen_1", type: "imageGen", x: 0, y: 0, data: { shot_id: "1", shot_role: "image" } },
    { id: "video_gen_1", type: "videoGen", x: 300, y: 0, data: { shot_id: "1", shot_role: "video" } },
  ],
  edges: [{ id: "old_edge", source: "image_gen_1", target: "video_gen_1" }],
  assets: [],
};
const resultNodes = placeResultNodes(
  flowCanvas,
  [{ asset_id: "asset_generated", name: "分镜1首帧", kind: "image" }],
  flowCanvas.nodes[0],
  { job_id: "job_1", kind: "image", shot_ids: ["1"] }
);
flowCanvas.nodes.push(...resultNodes);
connectImageResultsToShotVideo(flowCanvas, { kind: "image", shot_ids: ["1"] }, resultNodes);
assert.ok(flowCanvas.edges.some((edge) => edge.source === resultNodes[0].id && edge.target === "video_gen_1"));
assert.ok(!flowCanvas.edges.some((edge) => edge.source === "image_gen_1" && edge.target === "video_gen_1"));

console.log("All tests passed.");
