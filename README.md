# 低成本 AI 视频制作无限画布 MVP

本项目是一个本地优先的 AI 视频制作画布工具。第一版先验证最小闭环：

1. 在画布上导入一张本地图片。
2. 新建一个文本提示词节点。
3. 新建 Lovart 图片或视频生成节点。
4. 拉线后提交，调用本机 Lovart CLI。
5. 结果保存到本地项目目录，并回挂到画布。

## 启动

```bash
node server.js
```

打开：

```text
http://localhost:4173
```

## 给朋友的最小安装说明

如果只是把这个仓库给朋友自己改改，最少先确认 3 类环境：

1. `Node.js`
2. `dreamina` CLI
3. `ffmpeg / ffprobe`

### 1. 安装 Node.js

安装最新版 LTS：

[https://nodejs.org/](https://nodejs.org/)

安装后确认：

```bash
node -v
```

### 2. 安装即梦 CLI

先确认终端里能直接运行：

```bash
dreamina --help
dreamina user_credit
```

如果还没装，请按即梦官方方式安装并登录。

### 3. 安装 ffmpeg

macOS 如果已经有 Homebrew：

```bash
brew install ffmpeg
```

Windows 推荐：

1. 打开 [https://www.gyan.dev/ffmpeg/builds/](https://www.gyan.dev/ffmpeg/builds/)
2. 下载 `ffmpeg-release-essentials.zip`
3. 解压到例如：

```text
C:\Tools\ffmpeg
```

4. 把下面这个目录加入系统 `Path`：

```text
C:\Tools\ffmpeg\bin
```

安装后确认：

```bash
ffmpeg -version
ffprobe -version
```

### 4. 安装 Lovart skill

本项目依赖本机可用的 `agent_skill.py`。

常见路径：

macOS：

```text
~/.codex/skills/lovart-skill/agent_skill.py
```

Windows：

```text
C:\Users\你的用户名\.codex\skills\lovart-skill\agent_skill.py
```

如果本机没有这个 skill，需要先装好 Lovart skill。

### 5. 启动画布

macOS：

- 双击 `启动AI视频画布.command`

Windows：

- 双击 `启动AI视频画布.bat`

启动后浏览器会打开：

```text
http://127.0.0.1:4173/
```

### 6. 第一次打开必须配置

在左侧 **Lovart 配置** 里填写：

- `Access Key`
- `Secret Key`
- `Lovart skill 路径`

这里的路径必须改成自己机器上的 `agent_skill.py` 路径。

### 7. 最后检查 3 件事

只要下面这几条都通，基本就能用了：

```bash
node -v
dreamina --help
ffmpeg -version
```

再人工确认：

- 左侧 `Lovart 配置` 里的 key 和 skill 路径，已经改成自己机器上的值

## Windows 迁移说明

推荐迁移方式不是直接复制旧项目目录，而是使用项目复用包：

1. 在旧电脑打开当前项目。
2. 点击 `打开/创建项目`。
3. 点击 `导出当前项目复用包`，得到 `.aivideopack` 文件。
4. 在 Windows 电脑打开工具。
5. 点击 `打开/创建项目`。
6. 点击 `导入复用包创建项目`，选择 `.aivideopack` 文件。

复用包会带走标签、已绑定资产、素材库、全局控制模板和素材文件；不会带走任务记录、旧画布成品节点和生成历史。

Windows 上需要自己配置的内容：

- Node.js LTS
- Python，可在终端运行 `python --version`
- Lovart skill 路径，例如 `C:\Users\你的用户名\.codex\skills\lovart-skill\agent_skill.py`
- Lovart Access Key 和 Secret Key
- `dreamina` CLI，并确认 `dreamina user_credit` 可用
- `ffmpeg / ffprobe`，用于提取尾帧和跨平台图片压缩

即梦提交时工具会清掉 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 这些代理环境变量。这不是限制，而是为了避免即梦这个国内服务误走本地代理；如果你的 Windows 必须通过代理访问即梦，需要先在系统层确认 `dreamina` CLI 本身能直接运行成功。

### 常见问题

#### 即梦不能提交

先检查：

```bash
dreamina --help
dreamina user_credit
```

#### 提取尾帧很慢或不工作

先检查：

```bash
ffmpeg -version
ffprobe -version
```

#### Lovart 提交失败

优先检查左侧配置里这 3 项是不是已经换成自己的：

- `Access Key`
- `Secret Key`
- `Lovart skill 路径`

## Lovart 调用配置

本项目通过 Lovart 官方 `lovart-skill` 里的 `agent_skill.py` 调用 Lovart Agent OpenAPI，不依赖 OpenClaw Desktop。

```bash
python3 ~/.codex/skills/lovart-skill/agent_skill.py chat --prompt "..." --json --download
```

Lovart 的 Access Key、Secret Key 和 `agent_skill.py` 路径可以在网页左侧“Lovart 配置”里填写。配置会保存在本地 `projects/.local/settings.json`，该目录不会提交到 Git。

也可以用环境变量启动：

```bash
LOVART_ACCESS_KEY="你的 Access Key" LOVART_SECRET_KEY="你的 Secret Key" node server.js
```

## 资产素材库

- 左侧支持导入固定格式的资产 Markdown。
- 工具会提取：
  - `## 全片视觉规则`
  - `## 角色锚点 / 场景锚点 / 道具锚点`
  - 每个 `### @资产名`
- 角色默认 `9:16`，场景默认 `16:9`，道具默认 `1:1`。
- 先“一键创建资产节点”，再逐条提交生成。生成成功后会自动命名、入库，并标记为“资产”。

## 分镜导入格式

分镜导入改为上传 `.xlsx`，第一张工作表表头固定四列：

`分镜号 | 衔接方式 | 图片提示词 | 视频提示词`

- 衔接方式只能是：
  - `新建首帧`
  - `接上一尾帧`
- 图片提示词允许为空。
- 项目标签会从图片提示词和视频提示词两列共同提取 `@资产名`。
- 多次导入时，重复分镜会逐条提示是否覆盖。

## 分镜节点生成

- 分镜表支持一键生成画布节点，也支持单条分镜生成节点。
- 同一个分镜重复生成时更新原节点和连线，不在画布上堆重复节点。
- `新建首帧` 分镜：有图片提示词时生成图片节点和视频节点。
- `接上一尾帧` 分镜：只生成视频节点，并标记为连续镜头。
- 图片结果返回后，会自动接到对应的视频生成节点。
- 已绑定标签的资产会自动连到对应分镜生成节点；未绑定标签会保留分镜节点，方便之后补绑资产。
- 标签绑定面板只显示已经标记为“资产”的素材，并支持悬停预览。
