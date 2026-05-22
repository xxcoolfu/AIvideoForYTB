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
  buildReferencePromptText,
  buildTags,
  canStartQueuedJob,
  cleanGeneratedAssets,
  connectImageResultsToShotVideo,
  createProject,
  defaultPromptFeedbackPresets,
  deepSeekHttpErrorMessage,
  extractJsonObject,
  exportProjectReusePackage,
  importProjectReusePackage,
  isJimengVipModel,
  jobBlocksSubmission,
  loadProject,
  normalizeDeepSeekBaseUrl,
  normalizePromptOptimization,
  placeResultNodes,
  parseShotlistHtml,
  parseAssetLibraryJsonl,
  parseShots,
  pruneDormantJobsForTarget,
  rateLimitHandledReason,
  recordProcessedDownloads,
  safeName,
  saveScript,
  uniquePath,
} = require("./server");

const shots = parseShots(`1 | @女医生 在 @门诊室 看病例 | @女医生 抬头问话
2 |  | @女医生 问 @男患者
3\t@男患者 焦虑地看向 @门诊室\t@男患者 低头叹气`);

assert.equal(shots.length, 3);
assert.deepEqual(shots[0].tag_refs, ["@女医生", "@门诊室"]);
assert.equal(shots[1].image_prompt, "");
assert.equal(shots[1].video_prompt, "@女医生 问 @男患者");

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
result = tagRefsForPrompt("@里奥父亲 看向门口", [
  { label: "@里奥", aliases: [] },
  { label: "@里奥父亲", aliases: [] },
]);`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["@里奥父亲"]);
vm.runInNewContext(`${tagHelperSource}
result = tagRefsForPrompt("@Night Beach Camp — fog rolls in", [
  { label: "@Night", aliases: [] },
  { label: "@Night Beach Camp", aliases: [] },
]);`, tagHelperContext);
assert.deepEqual(tagHelperContext.result, ["@Night Beach Camp"]);
const statusHelperSource = appSource.slice(appSource.indexOf("function statusInfoFromJob"), appSource.indexOf("function jobFailureReason"));
const statusHelperContext = { result: null };
vm.runInNewContext(`${statusHelperSource}
result = statusInfoFromJob({ status: "running", platform: "lovart" });`, statusHelperContext);
assert.equal(statusHelperContext.result.label, "提交中");
vm.runInNewContext(`${statusHelperSource}
result = statusInfoFromJob({ status: "running", platform: "lovart", lovart_thread_id: "thread_1" });`, statusHelperContext);
assert.equal(statusHelperContext.result.label, "生成中");
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
assert.equal(rateLimitHandledReason({ platform: "lovart" }), "Lovart 并发限制已标记为处理完成，可重新提交任务。");
assert.equal(isJimengVipModel("seedance2.0fast_vip"), true);
assert.equal(isJimengVipModel("seedance2.0fast"), false);
const jimengRateLimitedJob = { status: "rate_limited", platform: "jimeng_cli" };
const activeJimengJob = { status: "running", platform: "jimeng_cli", jimeng_submit_id: "submit_1" };
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast" }, [jimengRateLimitedJob, activeJimengJob]), true);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast" }, [jimengRateLimitedJob]), false);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "jimeng_cli", model: "seedance2.0fast_vip" }), false);
assert.equal(jobBlocksSubmission(jimengRateLimitedJob, { platform: "lovart", model: "generate_video_seedance_v2_0_fast" }), false);
assert.equal(blockingJobs([jimengRateLimitedJob], { platform: "jimeng_cli", model: "seedance2.0_vip" }).length, 0);
assert.equal(canStartQueuedJob([activeJimengJob], { platform: "jimeng_cli", parameters: { model: "seedance2.0fast" } }), false);
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
assert.ok(sectionHtmlShots[0].tag_refs.includes("@Night Beach Camp"));
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
