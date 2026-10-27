# NeuroStability Arena

自由式摔跤科学训练、视频证据与人工复盘工作台。先记录训练问题和视频事件，再用经过检查的模型辅助测量。界面默认没有运动员、训练、视频或成绩。

## 当前能力与边界

| 模块 | 当前状态 |
| --- | --- |
| 登录、运动员、训练场次、四类视频库、授权上传 | 已实现；单团队管理员工作区 |
| 中英文 | 新访客默认英文；登录页与工作台一键切换，记住选择，保留未提交表单 |
| 训练计划 | 按运动员、日期、专项安排；关联实际训练场次后完成；支持取消、恢复 |
| 数据分析 | 默认包含已有训练；首页/运动员档案/统计页展示视频分析汇总、采样帧质量、片段时长分布、逐段实验性观测、复核入口与管理统计 |
| 研究数据包 | CSV + 方法清单 ZIP；保留来源 ID、模型与方法版本；打印筛选后的报告 |
| 混合训练与训练评分 | 支持修改分类、0–10分训练复盘、评语、审核与改分历史；首页、视频库和统计页展示已审核评分 |
| 独立异步 Worker | 持久队列、阶段进度、失败原因、显式重试、租约与中断恢复 |
| 视频预处理 | 校验格式/时长/分辨率/帧率，裁选片段，保留原始文件与帧率，分析副本去音轨 |
| 本机视频整理工具 | 自动压缩/分段、大小与时长校验、来源清单；整理后上传平台 |
| RTMPose | 接入 rtmlib / ONNX Runtime；必须安装本地权重，任务中验证加载与输出；无权重时 blocked |
| MotionBERT Lite | 已接入官方固定权重；复用人物轨迹，保存根节点相对三维骨架；旋转、逐帧与原片同步回放，不含世界坐标或人体网格 |
| 视觉动作分析 | Qwen3-VL 本地读取连续真实画面，输出带来源时间的待确认候选；确认后保存到事件时间线，不产生动作成功率或能力分数 |
| FSW-Net | **未找到可核实训练权重，不能直接推理。** 当前只有预检和阻塞接口，没有已验证的模型 runner |
| ByteTrack | 已接入真实YOLOX检测置信度与RTMPose；保存跨帧轨迹编号，可显式选择轨迹重新计算二维观测 |
| SAM2 | 已接入官方SAM2.1 tiny本地权重，按2Hz生成整段人物遮罩；可使用首帧人物框或指定选区 |
| WHAM | 尚未接入，仍需独立环境、权重与已授权SMPL模型 |
| 人工事件、可修改复盘、历史版本、JSON报告 | 已实现；AI/规则草稿与人工确认分开保存 |
| 合成样例 | 服务器允许且用户显式勾选才运行；关键点与视频动作无关，永久排除真实趋势 |
| Cloudflare + 电脑分析 | Workers 静态界面/API、D1；视频与模型留在电脑，训练记录和 JSON 结果自动同步；无需 R2，目标账号尚未上线 |
| 其他部署 | 原有 Docker Compose + PostgreSQL + 私有 S3/COS + Caddy 配置保留 |

FSW 权重核查证据与范围见 [docs/fsw-audit.md](docs/fsw-audit.md)。没有将 ImageNet 权重、随机分类头、论文准确率或规则输出包装为实际摔跤识别结果。

## Cloudflare 部署与电脑自动分析（无需 R2）

AI 在本机运行；Cloudflare Workers 提供网站/API，D1 保存训练记录及分块 JSON 分析结果。**不需要开通 R2、绑定 R2 付款方式或购买 ECS。** 原视频、预处理视频及模型留在分析电脑，GitHub 只存代码。电脑关机后云端评分、审核、统计、复盘、二维/轨迹/分割数据和三维骨架仍可查看；云端没有原片播放器。完整视频在本地工作台查看。现有本地运行方式继续保留。

### 1. 通过 GitHub 部署

用户自行登录目标 Cloudflare 账号，在 Workers & Pages 创建应用并连接 `HedyZheng728/NeuroStability`。保留已经创建的 `neurostability` D1 数据库，不必新建，也不要开通 R2。

| 设置 | 填写 |
| --- | --- |
| 应用名称 / 分支 | `neurostability` / `main` |
| 根目录 Path | `cloudflare` |
| Build command | `npm run build:site` |
| Deploy command | `npm run deploy:ci` |
| Preview builds | 关闭；预览不能复用生产数据库 |
| 构建变量 `NODE_VERSION` | `22` |
| 构建变量 `CLOUDFLARE_ACCOUNT_ID` | 目标账号的完整 Account ID |
| 构建变量 `CLOUDFLARE_DATABASE_ID` | 已创建数据库的完整 Database ID |

构建令牌需 Workers Scripts Edit、D1 Edit 等构建所需权限；令牌留在 Cloudflare。构建会自动执行尚未应用的 D1 schema 迁移并部署静态页面和 API。已有运行时机密保留；配置不含个人 ID 或密码。无需 `R2_BUCKET_NAME`、S3 key、Cloudflare 管理 API Token 或电脑端 Wrangler 登录。

首次部署只有数据库结构，**不会生成假数据或默认账号**。完成下述配对和首次同步后，原账号密码及真实数据才会出现。后续代码推送 `main`，由 GitHub 集成自动发布；数据不跟 Git 部署覆盖。

### 2. 一次配对

取得部署后的实际 HTTPS 网址，在项目根目录执行：

```sh
.venv/bin/python -m arena.cloud_bridge --configure https://实际网站地址
```

命令仅在本机生成权限600的 `data/cloudflare-worker.json` 和 `data/cloudflare-worker-token.txt`，不会操作浏览器或访问云平台。用户把 token 文件内容填入该 Worker 的 **Settings → Variables and Secrets → Secret `ARENA_WORKER_TOKEN`**，保存并部署。不要发到聊天、GitHub 或构建日志。这是本应用的专用同步密钥，不是 Cloudflare 管理令牌。

### 3. 首次同步及验证

保持本地程序版本与仓库一致；首次同步会在 `data/result-sync/<网站标识>/before-sync.db` 创建原库一致备份，不删除原数据库或媒体。

```sh
# 自动迁移历史记录和 JSON；复查远端 JSON 实际字节；不上传原视频。
.venv/bin/python -m arena.cloud_bridge --once --verify
# 持续同步，并领取网站的新分析请求。
.venv/bin/python -m arena.cloud_bridge
```

也可双击 `scripts/启动云端分析.command`，保持终端运行；Ctrl+C 停止。默认每60秒核对记录，新任务由本机领取；分析期间后台同步仍运行。短时网络故障自动重试，重启继续读取私有检查点。首次联网同步失败时可重新运行同一命令；检查点保留已完成进度。

网站登录沿用原账号密码。原账号哈希、15类原始关系记录、原 JSON 字符串、评分、改分历史、审核及审核历史均保留；临时浏览器登录会话不迁移。JSON 文件校验 SHA256，分块避免 D1 单行大小限制。每个 JSON 文件上限16MiB，大的逐帧结果单独保存并完整恢复，不截断。原片与模型始终保存在电脑。

网站和本机的单方修改会同步；同一条记录两边都修改时保留两份并在私有 `records.json` 的 `conflicts` 中记录，需明确解决后继续，不按时间强行覆盖。云端删除不会自动删本机视频，也不会把本机存档重新创建到云端；本机删除不自动删除云端。请勿直接清空同步检查点解决冲突。不同网站使用独立检查点和 outbox。电脑的新本地任务完成后同步；云端的新任务在隔离任务数据库运行，避免被两个 Worker 重复领取。

### 4. 训练与查看

- 在分析电脑的本地工作台上传视频、运行现有分析，完成后自动同步；仍可使用已有视频投放流程。
- 网站查看运动员、场次、视频目录、评分、分类、审核、计划、趋势、CSV/ZIP/JSON 报告。
- 二维骨架、轨迹、人物遮罩和三维骨架从实际保存的 JSON 播放，不请求云端视频；分割显示保存的遮罩轮廓。
- 网站可提交重新分析、复盘草稿或取消任务；电脑在线且具备相应模型时执行。缺少匹配本地视频时会明确阻塞，不虚构结果。
- 从云端拉回已完成任务时，同时恢复相应 JSON 文件；原片必须在当前分析电脑上有匹配的 ID、大小及 SHA256。

无需公网开放本机端口。Worker bearer 具有本应用同步权限，只放可信分析电脑；浏览器使用原有 HttpOnly Cookie、CSRF 和一次性登录证明。模型状态来自本机实际能力，不把未安装模型标为可用。已有科学边界、实验性标记及人工评分来源保持不变。

### 验证及免费额度

```sh
.venv/bin/python -m unittest discover -s tests -v
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix cloudflare test
```

测试包含真实 Miniflare D1（不绑定 R2）、完整 JSON 字节往返、本地视频与现有 Python 分析流程、断线、租约、取消、版本冲突和媒体隔离；测试生成的临时素材不进入训练数据。旧 R2 协议测试仅保留兼容回归，不是当前部署依赖。原 `scripts/cloudflare_migrate.py` 保留作历史快照/可选旧部署维护，新方案不使用其 R2 导入命令。

Workers Free 与 D1 有配额，不能保证不限量或任意规模。D1 Free 单数据库500MB、单行2MB；JSON 编码会产生存储开销。当地模拟器不能证明生产 CPU/内存配额，首次上线后需观察真实调用指标和访问速度。[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[Git 构建说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

## 本机启动

环境：Python 3.12–3.13、Node.js 22.12+、FFmpeg/ffprobe。先安装系统 FFmpeg。项目开发不需要云凭据。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd frontend
npm ci
npm run build
cd ..
.venv/bin/python scripts/dev.py
```

访问 `http://127.0.0.1:8000`。账号 `admin`；首次启动随机生成的密码保存在 `data/admin-password.txt`（权限0600）。不打印密码，不使用默认弱密码。也可先设置 `ARENA_ADMIN_PASSWORD`，至少16位。账号只在空数据库时初始化，之后修改环境变量不会重置已有密码。

开发运行器同时启动一个 Worker，仅绑定本机地址。API文档为 `/docs`。`data/`、`models/`、`.env`、依赖和构建目录均已忽略。停止进程后训练数据保留；再次启动会恢复待运行队列。运行中的任务租约过期后失败，由用户重试，不会伪造完成。

工作区日期默认使用 `Asia/Shanghai`；可通过 `ARENA_TIMEZONE` 指定有效 IANA 时区。服务端筛选默认值、计划截止日与浏览器日期采用同一工作区时区，导出清单保留时区与统计截止日。Docker 镜像显式安装 `tzdata`。数据库 schema v4 在启动时进行加表迁移，保留 v1/v2/v3 的原有记录与账号；仍应先备份数据库。

计划完成率为已到期且未取消的计划中，实际关联场次的比例；按筛选截止日与工作区当前日期较早者计算。负荷为已记录的 `duration_min × RPE` 之和（AU），缺失 RPE 不计为零；覆盖量单独显示。描述统计以场次为单位，报告样本量、中位数及线性插值四分位数，不作训练因果或竞技能力推断。

统计页首次打开使用已有训练历史至工作区今天的范围，可切换“最近8周”或手动筛选；没有历史记录时使用最近56天。首页展示训练分钟、已分析视频、训练均分和采样帧；无已审核评分时显示关键点核查数量。运动员页面自动打开首位已建档运动员。帧质量按有效分区的计数加权汇总，缺失/无效质量不伪装为有效观测。归档片段时长按每个视频的完整源时长去重分析任务，包含实际裁段重叠，与人工记录的训练总时长分开展示。

“实验性二维测量”直接展示已保存的有限观测值、单位、质量和验证状态；来源链接定位具体任务。未确认结果可供复核，不自动进入已验证趋势。每个视频的最新真实RTMPose尝试只计一次，合成样例排除；视频详情仍保留历次任务。`GET /api/insights/analyses.csv`遵循同一日期/运动员筛选，导出最新真实任务的ID、方法、参数、质量和三项WSE观测，未知值留空，明确实验性和验证状态，不含原文件名、姓名、评语、凭据或存储路径。

研究导出包含 `sessions.csv`、`plans.csv`、`metrics.csv`、`events.csv`、`scores.csv`、`manifest.json`、`data_dictionary.json`。不导出姓名列、训练备注、复盘正文、视频或存储路径；ID 可关联原始记录，因此仍是可追溯的去标识数据。人工事件名称和结果为原文，分享前需检查是否包含个人信息。样例结果不进入真实测量统计。语言切换不改写人工记录或历史草稿；新草稿使用生成时选定的语言。

## 本机视频整理工具

双击项目中的 **`视频整理工具.command`**，浏览器会打开仅在本机运行的工具。选择或拖入视频即可自动整理；再次双击会重开已运行的实例。也可执行：

```sh
.venv/bin/python scripts/prepare_video.py
# 不打开系统浏览器，仅在终端显示启动链接：
.venv/bin/python scripts/prepare_video.py --no-open
# 命令行直接处理，无需经过浏览器读取：
.venv/bin/python scripts/prepare_video.py /path/to/video.mp4 --output /path/to/output
```

本工具只依赖 Python 标准库及系统 FFmpeg/ffprobe，无云端转码、模型依赖或付费服务；浏览器里的原片读取发生在127.0.0.1。最大输入20GiB，开始时检查临时目录可用空间。界面支持中英文、预览、实际进度、取消和当前页面的断点续传。刷新页面后，已完整读取的视频继续处理；未读完的原片需要重新选择。关闭工具或正常结束处理后清理临时原片副本；异常终止可能留下系统临时目录，需要自行清理。

默认处理规则：

- 原片不超过100MiB、300秒且格式/帧率/分辨率有效时，复制原文件，字节不变。
- 只有文件超过大小限制时，才编码为H.264/yuv420p MP4，CRF20、fast，保留画面完整范围和帧时间间隔，最长边不超过1920px，保留音频并编码为AAC128k。
- 大小合规、仅超过时长时，按已有关键帧无损分段，不重编码、不添加重叠；关键帧间隔无法满足时长限制时明确拒绝，不暗中压缩。分段前后解码帧哈希一致性已测试。
- 编码片段最长240秒，目标90MiB；过大就缩短片段再编码，保持同一画质参数。边界最多重叠2秒；不识别动作边界，不保证动作不会跨段，统计时避免重复计算重叠内容。
- 每段检查实际大小和时长后才发布；输出到`data/prepared/`下独立文件夹。`manifest.json`保存源文件与片段的SHA256、请求裁片区间、真实输出规格和状态；请求时间可能与实际帧边界相差一帧。转码时丢弃最后视频帧以后的纯音频尾部，原样复制时不改音轨。
- 取消/失败不标为完成，删除未验证的半成品，保留此前已验证片段及未完成清单；原文件不改动。编码是有损的，具体画质需用自己的训练视频预览确认。

目前超过大小限制且需要转码的HDR/PQ/HLG/Dolby Vision视频会明确拒绝，请先导出SDR版本；合规原片可原样保留，时长超限可尝试无损分段。本机FFmpeg未包含zscale，未声称已实现可靠HDR色调映射（相关处理要求见[FFmpeg官方说明](https://ffmpeg.org/ffmpeg-filters.html#tonemap)）。

命令行可用`--max-mb`（<=100）、`--max-seconds`（<=300）、`--overlap`调整限制。浏览器关闭按钮停止整理工具，不停止8000端口的训练平台。原生入口已按当前Mac环境提供；其他操作系统可直接运行Python命令，尚未提供独立安装包。

### 批量导入真实视频

投放目录为`训练视频投放/`，已从Git排除。四类训练子目录可确定分类；用户明确确认混合训练时使用`mixed`，教练后续在视频详情修改分类。导入器要求已有且信息已确认的训练场次，不把视频时长代填为训练时长，不编造RPE或拍摄日期。

```sh
.venv/bin/python scripts/import_videos.py --inbox /path/to/videos --list
.venv/bin/python scripts/import_videos.py --inbox /path/to/videos --session-id EXISTING_SESSION_ID --category mixed
```

默认提交真实RTMPose任务，拒绝合成样例后端。大小/时长合规的视频直接按原字节上传；仅超限素材调用整理工具。`data/imports/`保存原片哈希、裁段区间、视频ID、任务ID与导入清单；断点重试会从真实服务刷新视频记录，避免响应丢失后重复上传。目录外的符号链接不导入，未确定类别的素材保留待确认。失败或阻塞任务只有显式`--retry-failed`才重新提交。

### 训练复盘与评分

教练从视频库打开视频后，直接在播放器上方切换原片、二维姿态、人物追踪、人物分割、AI复盘、技术识别与三维重建。已有结果自动打开；可运行但尚无结果的方法提供运行按钮。模型、任务历史、分类、测量处理和原始质量放在“高级工具”。手机端全部入口分两排展示。

人物追踪显示真实TID、检测框中心的画面轨迹和逐轨迹关节观测。膝、肘使用三点内角，躯干使用二维肩髋中线倾角；保留采样时间、空缺和每项样本量、中位数及范围。曲线点击或键盘移动可回看对应源时间，片段范围内保留分析叠加。TID表示局部跟踪轨迹，仍需结合视频选定运动员；关节角度为实验性投影观测，无自动能力分数。

视频详情支持0–10分训练评分、复盘评语和审核。审核需填写评语，每次保存都会保留实际操作账号、时间、评分标准版本与完整历史。新记录使用`training-review-10-v1`，已有版本保留。已审核的当前评分进入按运动员/日期筛选的样本量、均值、中位数与四分位数统计；未评分保持空值，未审核评分不进入这组统计。视频库显示当前分数与复盘完成状态，数据核查状态单独显示。

报告JSON包含当前评分及历史。研究ZIP增加`scores.csv`，保留视频/场次/运动员ID、日期、类别、分数、审核状态、时间与版本，不导出评语或操作账号。训练评分是主观片段复盘，不是竞技能力量表或比赛得分；复盘完成也不会自动验证二维测量。

视频详情的“测量处理”针对选中的真实终态分析保存采纳、不采纳、已有后续分析或待核查决定。`GET/PUT /api/jobs/{id}/assessment`提供当前决定和完整历史，保存时记录实际登录账号与时间。采纳姿态观测须明确运动员对象、存在有限指标、至少10个可用帧、至少60%覆盖率且无歧义帧；SAM2须有一致的非零分割结果。采纳后的数据仍为实验性观测，不自动进入科学验证趋势。

数据洞察的待办按每段视频最新已产出的真实姿态分析计算；完成处理退出待办，改回待核查则重新进入。模型原始状态、质量计数和结果保留；不采纳或被替代的观测退出测量预览，原始分析CSV仍保留指标、审核决定及目标轨迹来源。视频报告JSON包含`assessment_history`。v3新增`analysis_assessments`及`analysis_assessment_history`，不重建既有数据。

本机2026-07-25训练已按用户指定角色（女生为001号运动员、男生为教练）完成70份片段复盘。结合用户确认的高质量训练背景和带时间码画面核对，65段评为7–9分（7分11段、8分38段、9分16段），均分8.08；5段准备、复位或极短画面保持未评分。7分对应局部/分解练习，8分对应较完整配合，9分对应起止和衔接清楚的完整练习，均评价片段中的训练内容。私有`data/imports/course-review-20260725/`保留复盘依据、时间码画面、文件哈希、入库回执及验证结果；原视频与原模型任务结果保留。

## 模型接入

### 免费本地语言复盘

```sh
.venv/bin/python -m pip install -r requirements-review.txt
.venv/bin/python scripts/install_review_model.py --download
```

安装器显式下载官方`Qwen/Qwen2.5-1.5B-Instruct`固定版本（约3.1GB），校验官方权重和分词文件。设置`ARENA_REVIEW_MODEL_DIR=/absolute/path/to/models/review`；本机开发启动器自动识别该目录。请求只读取本地安全权重，不下载模型、不上传视频、不需要付费API。Docker可选`WITH_REVIEW=true`，模型目录只读挂载。

本地语言模型从已保存观察中选择原文重点，复用已有回看安排；没有观察时只选择可核实的覆盖计数。解码限制为来源可生成的JSON选项，再校验句子索引、原始输出及完整事实的SHA256；展示层只引用原文，不自由补写动作评价。模型不直接观看视频，也不替代专项动作识别。草稿保存实际模型、来源任务、完整事实及language_output选句溯源，不覆盖既有复盘或评分。旧版未通过来源校验的自由生成候选保留在完整报告历史中，不作为当前参考展示或计入已处理数量。中英界面使用对应标题，训练观察保持原文语言。

Apple M4/16GB已验证FP32+SDPA推理，模型占用约6GB；FP16在本机产生异常输出，未采用。首次加载较慢，生成串行运行。使用不同设备或环境时应先运行真实测试并检查文字；官方来源见[Qwen模型页](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)。

### RTMPose

先安装可选依赖（rtmlib自带的依赖声明会安装多个OpenCV发行包，建议在独立环境中运行）。显式下载官方模型：

```sh
.venv/bin/python -m pip install -r requirements-models.txt
.venv/bin/python scripts/install_rtmpose.py --download
# 若本机 Python TLS 报 EOF，显式改用系统 curl（保持证书校验）：
.venv/bin/python scripts/install_rtmpose.py --download --transport curl
```

脚本将模型放在 `models/rtmpose/` 并记录来源与 SHA256；`scripts/dev.py` 自动发现该目录。后台服务使用以下环境变量：

2026-10-26 已通过系统 curl 从 OpenMMLab 官方源取得模型，完成 ONNX 加载、真实视频关键点提取和端到端任务验证。安装器仅复用来源和 SHA256 均匹配的既有文件；下载失败或损坏包不会覆盖目标权重。urllib 拒绝非 HTTPS 重定向，curl 忽略用户 `.curlrc`，不关闭 TLS 验证。安装期间不要运行分析；任务发现权重在推理期间变化时会拒绝发布结果。

本地自检不联网、不写训练数据库：

```sh
# 默认生成无人测试画面：模型应运行成功，但没有人物、有效指标或专项分数。
.venv/bin/python scripts/check_rtmpose.py
# 用自己已授权的视频验证前3秒，摘要写入指定文件：
.venv/bin/python scripts/check_rtmpose.py --video /absolute/path/to/authorized.mp4 --seconds 3 --output /tmp/rtmpose-check.json
```

退出码0仅代表加载和推理已执行，画面可能依旧因多人、遮挡或观测不足而无法测量；须检查 `quality` / `needs_review`。退出码2表示检查失败。来源、模型摘要、公开测试素材及验证范围见 [docs/rtmpose-validation.md](docs/rtmpose-validation.md)。公开素材验证不等于摔跤动作分类或竞技水平评价已验证。

```sh
RTMPOSE_DETECTOR=/absolute/path/to/models/rtmpose/detector.onnx
RTMPOSE_MODEL=/absolute/path/to/models/rtmpose/pose.onnx
```

适配器采用 YOLOX 人体检测640×640、COCO17 RTMPose192×256，CPU ONNX Runtime。其他大小/布局的权重不能直接替换。外部下载地址失败时保留未就绪状态；不要关闭TLS校验或用不明文件冒充。

分析副本保留源帧率，二维分析按 `sample_fps` 采样（当前10Hz），不用于宣称精确的快速动作启动时间。二维坐标属于分析副本，`time_offset` 将裁片秒数映射到原始视频。

### 视觉动作分析与三维骨架

```sh
.venv/bin/pip install -r requirements-vision-action.txt -r requirements-pose3d.txt
.venv/bin/python scripts/install_vision_action.py --download
.venv/bin/python scripts/install_pose3d.py --download
```

动作使用官方 `Qwen/Qwen3-VL-2B-Instruct`，固定版本 `89644892e4d85e24eaac8bacfd4f463576704203`，Apache-2.0，安全权重约4.26GB。每个最多8秒窗口取8个真实RGB画面，保留解码PTS、映射原片时间、原始受限JSON、像素预算与模型哈希；不读取人工复盘文字、不调用外部API。结果可包含多项活动类别，具体摔法独立标为未验证假设；类别顺序按窗口覆盖支持跨度排列，不是置信度、动作准确率或有效训练时长。教练可修改名称和原片时间后记入事件，保留来源任务；不自动改动训练分类、复盘或评分。

配置 `ARENA_ACTION_MODEL_DIR=/absolute/path/to/models/vision-action`。MPS优先，CUDA与CPU为可移植执行路径；本机实际验证的是M4上的MPS/BF16。加载前检查设备容量，内存不足明确失败。CPU可能需要超过10GB空闲RAM，耗时需在目标服务器实测。语言复盘与视觉模型串行使用共享模型缓存，切换时释放上一模型，避免两份大模型同时驻留。默认启用 `HF_DEACTIVATE_ASYNC_LOAD=1` 串行载入权重，避免当前 safetensors/Transformers 在跨模型线程中的初始化死锁；GPU 推理方式不变。Docker可选 `WITH_ACTION=true`；CUDA运行时仍需合适的GPU驱动、容器运行时和PyTorch构建。

三维使用作者发布的 `MotionBERT Lite` H36M骨架权重，Apache-2.0，约64.1MB，固定SHA256为 `9811155371db4ca5d20f31a36a232d41012e12e1333882888a564d741861148f`。配置 `ARENA_POSE3D_MODEL=/absolute/path/to/models/pose3d`，Docker可选 `WITH_POSE3D=true`。优先复用同视频真实RTMPose/ByteTrack来源；保留选定TID、实际裁片区间及时间偏移。各轨迹独立处理，缺失处分段；短序列按原长推理，不补造二维或三维帧。COCO到H36M的骨盆、脊柱、颈、头代理映射记录在来源里。

三维结果存私有 `pose3d.json`，数据库保留紧凑摘要；旋转、逐帧、轨迹选择与处理副本同步。每个人以预测骨盆为原点，单位是模型空间，人物之间不能据此比较真实距离。没有WHAM网格、真实重心、世界坐标、米制速度或伤病/能力评分。

数据库v4为事件增加可空 `source_job_id`，旧事件保留；接口拒绝跨视频、样例、未完成或时间越界来源。动作/三维暂不支持ROI，接口拒绝该参数；三维聚焦人物使用已有目标轨迹。旧FSW与WHAM入口保留在高级方法中，其未就绪状态不代表替代实现已经得到同名模型的验证。

### FSW-Net

```sh
.venv/bin/python scripts/check_fsw.py
```

当前预期输出 `FSW-Net: BLOCKED [missing_bundle]`，退出码2。即使提供JSON声明和本地文件，仍须核实真正的动作分类器、分割权重、标签顺序、架构和预处理，并新增真实 runner 后验证；修改 `ready`/`verified` 字段不会启用推理。

七类闭集分类不等于整场动作定位，也不覆盖所有步法、进攻、防守，更不能直接判断进攻方、成功或裁判得分。

### 人物轨迹与分割

`RTMPose + ByteTrack`使用现有ONNX权重和`trackers==2.6.1`，每次更新传入视频真实PTS。结果保留检测框、检测置信度、轨迹编号和实现版本；原始RTMPose任务保留。视频详情选择T编号后生成新任务，复用来源关键点和分析副本；来源必须属于同一视频，时间偏移保持一致，不填补缺失人物。T编号不是身份识别，遮挡时仍可能切换；目标观测保持实验性。

SAM2为独立可选依赖：

```sh
.venv/bin/python -m pip install -r requirements-segmentation.txt
.venv/bin/python scripts/install_sam2.py --download
```

安装器仅使用官方`facebook/sam2.1-hiera-tiny`固定revision与safetensors，核对官方大小、哈希和来源清单；不加载pickle或远程自定义代码。下载可安全续传，未完成文件不被当作已安装模型。本机开发启动器发现`models/sam2/manifest.json`后自动配置；独立部署设置`SAM2_MODEL_DIR`。Docker可设置`WITH_SEGMENTATION=true`，运行时仍需挂载已安装权重。CPU可用`OMP_NUM_THREADS=4`控制并行度。

SAM2按整段实际时间戳2Hz流式运行，最多提示首帧4个人物；没有YOLOX检测器时需提供归一化选区。遮罩以简化外轮廓保存，忽略内部孔洞，可能包含贴身器材；对象编号与ByteTrack编号分开。完整遮罩存在私有`segmentation.json`，`GET /api/jobs/{id}/segmentation`受登录保护，报告保留摘要和模型来源。人物分割不生成竞技分或医学判断。模型页展示实际处理视频数、轨迹/分割帧数及活动任务数量；可用项排在前面。数据洞察首先展示复盘覆盖、训练均分、评分分布和专项统计，再展示原始姿态核查。

### 可选 AI 文字复盘

设置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` 后可使用兼容 `/chat/completions` 的服务（例如百炼，具体URL/地域/模型从自己的控制台取得）。密钥只在服务端。当前仅发送去标识的测量摘要，不发送运动员姓名或视频；未配置时明确拒绝调用。

“数据规则辅助草稿”是另外的选项，明确标记非生成式AI。所有草稿未经确认不进入正式复盘，原始草稿及人工修改历史均可导出。语言模型可能出错，确认时需要核对片段、数据和分析人物。

## 使用流程

1. 建立运动员档案，等级由用户填写。
2. 建立训练场次：日期、目标、时长、可选RPE、备注。
3. 上传视频，选择场次及稳定性/步法/进攻/防守分类，确认已获得相关人员授权。
4. 先选“仅视频预处理”即可开始真实人工复盘，无需模型；也可选择已就绪的分析方法。可指定原视频时间范围和归一化ROI；任务错误或缺模型均有状态说明。
5. 回放原始/分析视频；二维结果可叠加骨架。标记人工技术事件、执行者、结果与备注。
6. 创建规则/AI草稿，人工修改观察和下一步行动后确认；可不依赖模型直接人工复盘。
7. 查看数字档案或下载JSON报告。只有关联已确认草稿的、质量达标的真实RTMPose结果可进入趋势；样例始终排除。

上传上限100MB。Worker检查不超过300秒、8192像素、240fps；超限或无效视频会分析失败且没有结果。删除视频会删除关联任务、关键点、复盘、历史和事件；有排队/运行任务时禁止删除。

## 香港容器部署

部署目标是腾讯云中国站账号的香港服务器与同地域私有COS，不涉及境外信用卡服务的强制依赖。本仓库不会代购、注册或创建收费资源。

1. 准备Linux Docker Compose环境，域名解析到服务器，80/443可达。
2. 创建**私有**COS桶，准备限定桶权限的服务端凭据。关闭匿名公开读取。
3. 复制 `.env.example` 为 `.env`，填写域名、HTTPS PUBLIC_URL、管理员密码、数据库密码和COS配置。数据库密码建议用随机hex，避免URL保留字符。
4. 若启用RTMPose：在宿主机准备 `models/rtmpose/`，设置 `WITH_POSE=true`；模型目录以只读方式挂载。
5. 启动：

```sh
docker compose build
docker compose up -d
docker compose logs -f api worker
```

API和Worker使用同一PostgreSQL和COS；Caddy负责HTTPS。仅代理暴露80/443，数据库/API没有直接映射公网端口。线上要求HTTPS、PostgreSQL、对象存储、强管理员密码，缺项时拒绝启动。生产关闭公开API文档。

当前为单团队管理员工作区，尚未实现每名运动员的独立账号、教练角色及多租户隔离。不要把它描述为这些权限功能已完成。公开部署前还需在目标服务器执行真实PostgreSQL、COS上传/播放/删除和恢复测试，并验证内存与处理耗时。

数据库首次启动创建schema_version=4，生产启动用PostgreSQL事务级advisory lock避免API/Worker同时初始化。可独立执行 `python -m arena.migrate`。DDL见 [docs/schema.sql](docs/schema.sql)，也可用 `python -m arena.migrate --print-sql` 重新生成。后续已有数据的结构升级必须增加版本化迁移，不可删除重建数据库。

备份数据库示例（需要已启动的Docker环境）：

```sh
docker compose exec -T db pg_dump -U arena -Fc arena > arena-backup.dump
```

还需为COS配置保留/备份策略并实际演练恢复；JSON报告不是完整备份。视频访问需登录，COS播放链接有15分钟有效期，应避免转发临时链接。

## 验证

```sh
.venv/bin/python -m unittest discover -s tests -v
cd frontend
npm test
npm run build
```

后端测试使用临时SQLite和FFmpeg生成的黑色视频，只验证软件流程。合成关键点只用于明确标注的样例计算测试，不充当运动表现验证。

可选真模型测试需要已安装权重和指定的官方多人短片（获取与摘要见上方验证文档），全程在临时数据库中运行：

```sh
ARENA_TEST_REAL_MODELS=1 ARENA_TEST_MULTIPERSON_VIDEO=/absolute/path/to/mmpose-official-demo.mp4 .venv/bin/python -m unittest discover -s tests -v
```

未显式启用时，3项真模型测试跳过；其余测试无需模型及联网。真模型测试验证无人画面、多人歧义、真实上传任务复盘链路与推理期间权重更改；不会自动下载测试素材。

测试覆盖几何公式、低置信度/多人歧义、模型缺失、上传授权与限制、登录/CSRF、任务状态、原始帧率/裁片映射、复盘版本、删除关联记录、样例隔离，以及FSW预检。独立评审发现并通过回归测试修复：VFR关键点时间对齐、租约过期禁止发布、删除后旧Worker禁止重建私有对象、未预处理事件返回明确状态。通过这些测试不代表完成摔跤动作识别准确率、医学效度、线上压力或云灾备验证。

浏览器验收：IAB已完成登录、空工作台、建档、场次、授权上传、异步预处理、事件定位、复盘确认与刷新保留；样例草稿编辑、版本及真实趋势隔离也已复测。RTMPose 使用真实官方权重，已验证浏览器提交任务、真实骨架显示开关和多人质量提示，console无error/warn。测试数据仅进入独立临时QA目录，未写入用户训练工作区。移动设备、线上云资源与实际摔跤准确率仍需专项验证。

## 界面设计

当前采用竞技运动研究室风格：暖白、深靛蓝、少量朱橙，配合大字标题、摔跤垫圆环、开放式数字栏和编号训练模块；登录页与工作台使用原创女子摔跤SVG插画，源文件位于 `frontend/public/images/womens-wrestling.svg`。Superdesign画布保存了可回看的设计版本：[设计画布](https://superdesign.dev/teams/184eba12-805e-4639-a55e-bc0cf5fd8cd8/projects/29470801-dc87-4bc1-bb99-309cd9e27cb0)。

界面数字仍来自实际API，训练健康元素对应时长、RPE和个人感受备注，不生成健康诊断。已验证1280px桌面、390px手机布局及导航键盘焦点；建档、场次保存、预处理、复盘确认和退出登录在独立QA数据库复测通过。本轮改版未变更用户训练档案。

最近一轮视觉复测：1440×1000、1280×720和390×844；首页主操作、进攻分类筛选、模型状态入口、手机导航焦点与Esc关闭、登录页配色已检查。44项回归测试通过。手机检查使用浏览器尺寸模拟，尚未覆盖实体设备及其他浏览器。为提高首屏信息密度，实际主视觉比初始设计稿更紧凑；不添加第三方字体及运行时设计依赖。

2026-10-27界面精简：删除登录副文案、功能标签、页脚口号和工作台重复说明；重绘女子低姿对抗SVG。构建、SVG格式、本地访问及1280×720/390×844浏览器检查通过；实际登录/退出、进攻分类筛选、手机导航Esc焦点恢复已复测。此轮仅修改前端文案、布局和素材，未运行新的后端回归测试。

2026-10-27双语与训练管理：59项后端回归（含3项本地真模型检查，无跳过）、12项前端测试及生产构建通过。浏览器已核对语言记忆、切换保留表单、计划关联实际场次、缺失 RPE、日期筛选、统计值、实际 ZIP 下载、刷新失败禁用旧报告及390px布局。所有测试记录保存在独立临时工作区，未向真实训练库添加演示数据。新功能不代表已经建立运动学效度、教练采纳或训练收益证据。
