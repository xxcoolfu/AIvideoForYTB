const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.AI_VIDEO_PROJECTS_DIR = path.join(__dirname, "projects");

const {
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

const project = createProject("测试项目");
assert.equal(project.project.project_id, "测试项目");
for (const fileName of ["project.json", "canvas.json", "shots.json", "tags.json", "jobs.json", "asset_library.json"]) {
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
