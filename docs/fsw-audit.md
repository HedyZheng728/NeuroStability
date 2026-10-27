# FSW-Net 训练权重核查

核查日期：2026-10-26（Asia/Shanghai）。结论：**BLOCKED，未找到可核实、可直接推理的 FSW 训练 checkpoint**。这是已核查公开来源的结论，不是“作者从未发布权重”的证明。

GOAL：不训练、不微调，确认能否直接接入论文模型。

CONTEXT：论文为 Rostamian、Mottaghi、Soryani 的 [Scientific Reports 2026 论文](https://doi.org/10.1038/s41598-026-44782-0)。公开的是训练代码和数据资源；没有发现训练后动作分类器或配套摔跤前景分割器的下载链接。

CONSTRAINTS：不联系作者；不把 ImageNet EfficientNet 权重当作 FSW 权重；不随机初始化分类头生成结果；不自动下载或反序列化未知权重。

DONE WHEN：获得可追溯的动作分类器与所需分割权重、精确架构、训练标签索引顺序和完整预处理；在 CPU 上全 state_dict 严格加载后，使用已授权真实片段跑通。当前未满足。

## 公开证据

| 来源 | 实际核查结果 |
| --- | --- |
| [论文 PMC 页面](https://pmc.ncbi.nlm.nih.gov/articles/PMC13153394/) | 已索引 Data availability 指向 `miladrostami1/OpenFSW`，Code availability 指向 `milad67/Freestyle-Wrestling-Dataset`。正文访问有反爬限制；索引内容可读。 |
| [OpenFSW GitHub API](https://api.github.com/repos/miladrostami1/OpenFSW) | HTTP 404；GitHub 页面也返回 404。无法区分不存在、改名或非公开，不能作为可下载来源。 |
| [论文 accepted manuscript PDF](https://www.nature.com/articles/s41598-026-44782-0_reference.pdf) | 16 页。Data/Code availability（PDF 第 14–15 页）均指向 `milad67/Freestyle-Wrestling-Dataset`；全文检索 `Supplement` 未命中，未发现 checkpoint 或补充权重链接。最终 HTML 直连被 Nature 身份重定向阻断，不能声称已穷尽所有出版附件。 |
| [官方代码 main 固定提交](https://github.com/milad67/Freestyle-Wrestling-Dataset/tree/9dad3e652507e57714c60abb3a3853d000267e4c) | commit `9dad3e652507e57714c60abb3a3853d000267e4c`，2026-06-26。完整 recursive tree 未截断，包含七个数据 RAR、README、intoduction、requirements 和四个 Python 实现文件；没有单独模型 checkpoint、manifest 或权重下载脚本。五个 RAR 已完成固定 Git blob 校验与只读文件清单检查，未见模型文件；两个因网络传输失败仍未核实归档内部，详见下节。 |
| [branches](https://api.github.com/repos/milad67/Freestyle-Wrestling-Dataset/branches) | `main`；`Original-Samples` 与 `foreground-by-DeepLabV3+` 均指向 `89d3c99f967563644627c2ffb0630f026cf5bed0`。两分支内容已包含在下面的历史核查中。 |
| [releases](https://api.github.com/repos/milad67/Freestyle-Wrestling-Dataset/releases) / [tag refs](https://api.github.com/repos/milad67/Freestyle-Wrestling-Dataset/git/refs/tags) | releases 响应 `[]`；tag refs 响应 404，未获得可达 tag 命名空间。`/tags` 集合被连接器限制，未用该限制冒充空结果。 |
| [作者主页源码](https://github.com/milad67/milad67.github.io/blob/main/index.html) | `index.html` blob `d56741cce8f8bd0753bb638df96caa18f7a34c61`。FSW 论文卡片只有论文、PDF、Code & dataset 和 citation 链接，没有权重入口。 |
| [Hugging Face FSW-Net API](https://huggingface.co/api/models?search=FSW-Net) | `FSW-Net`、`miladrostami`、`milad67` 三个 models 查询均为 `[]`；`wrestling` 返回四个无关模型，未找到作者/本论文模型。`FSW` 广义查询有无关结果，不以缩写匹配作为权重证据。 |
| [Zenodo Open FSW API](https://zenodo.org/api/records?q=%22Open%20FSW%22&size=10) | 精确 `"Open FSW"`、`"FSW-Net"` 查询均 total=0。广义 `"freestyle wrestling"` 返回 63 条，检查前 10 条标题无本论文条目；不声称该广义查询全部结果已逐项排除。 |

GitHub 使用连接器只读 API；Hugging Face/Zenodo 使用公开只读 HTTP API。网络搜索还覆盖 `FSW-Net weights`、`fsw_action_model.pth`、作者姓名和 checkpoint 组合，未发现可追溯的本论文权重链接。搜索无结果仅是负面证据，不等于不存在。

## RAR 内部文件清单与片段授权边界

同日补查：从上述固定 commit 下载数据 RAR 到 `/private/tmp/fsw-rar-audit-osqdl0l8`，使用系统 `/usr/bin/bsdtar -tf` 和 `-tvf` 只列文件名/类型，没有解压文件、执行归档内容或读取模型参数。成功的五个下载均按 Git 的 `SHA1("blob " + size + NUL + bytes)` 算法与 GitHub tree 中的 blob SHA 严格比对一致；`bsdtar` 全量列出成功（退出码 0、无 stderr）。

| RAR | 下载字节 | 普通文件 | 目录条目 | 图像类型 | 模型/嵌套归档 |
| --- | ---: | ---: | ---: | --- | --- |
| `01-Hip headlock throw.rar` | 10,549,186 | 900 | 31 | 327 PNG、573 JPG | 0 |
| `02-Single leg tackle.rar` | 预期 16,879,381；仅得到 5,950,821 | 未完成 | 未完成 | 未核实 | 未核实 |
| `03-Gut wrench or rolling Side sweep.rar` | 11,259,460 | 892 | 31 | 93 PNG、799 JPG | 0 |
| `04-Arm spin.rar` | 7,204,287 | 770 | 31 | 198 PNG、572 JPG | 0 |
| `05-Side sweep and over-under.rar` | 12,753,421 | 810 | 31 | 309 PNG、501 JPG | 0 |
| `06-Ankle lace.rar` | 14,089,853 | 792 | 31 | 365 PNG、427 JPG | 0 |
| `07-From head and arm.rar` | 预期 12,404,228；下载失败 | 未完成 | 未完成 | 未核实 | 未核实 |

成功归档各含 30 个图像序列目录及一个类别根目录，所有普通文件扩展名均为 `.png` 或 `.jpg`。清单中不存在 `.pth`、`.pt`、`.h5`、`.hdf5`、`.onnx`、`.ckpt`、`.safetensors`、`.pb`、`.tflite`、`.keras`、`.pkl`、`.pickle`、`.bin`、`.weights`，也没有 ZIP/TAR/RAR/7Z 等嵌套归档。该检查排除了这五个归档中的显式模型文件；没有对图像内容进行隐写分析。两个未完成归档在 urllib、curl 重试和 GitHub alternate raw URL 中均遭遇 TLS EOF/SSL_ERROR_SYSCALL 或 partial transfer，未把不完整下载作为有效证据，**仍不能排除它们内部含权重**。完整清单和下载摘要暂存于上述临时目录。

五个成功下载的 SHA256：

| RAR 类别前缀 | SHA256 |
| --- | --- |
| 01 | `13f4b7abe7c89435c06f8903e38ced19c3e036ed584eb7c7e5005e1acd713574` |
| 03 | `f17ec475186abfe862bc7100196a6f1e15a1aa50e6467719bbf8f5f355f992e2` |
| 04 | `646ea80247e25bdaa887354609e51356308472357b94c23a660e2a64a0a71b86` |
| 05 | `8b5d91c81c01606a5d73e4442dc48ab89b64d348d93494806e50176e5c6b124a` |
| 06 | `25831d50497181d6ba0fef2c5def5cbee8151828b272f5833a76b836f36af84c` |

**当前不能给出授权明确、可直接用作软件验证的 controlled 片段名单。** 图像序列名同时出现 `group3-2` 一类分组名和 `rio2016` 一类比赛来源线索；分组名本身不证明拍摄来源或授权。固定提交的 [intoduction](https://github.com/milad67/Freestyle-Wrestling-Dataset/blob/9dad3e652507e57714c60abb3a3853d000267e4c/intoduction) 称数据集采用 CC BY-NC-SA 4.0；accepted manuscript 称 controlled clips 采用 CC BY 4.0、broadcast 只发布 metadata；README 又泛称 MIT。已检查的 RAR 内没有逐序列的来源、controlled/broadcast 标记或授权说明，代码树也没有相应映射文件。因此不将现有归档中的某个序列自行指定为授权明确的 controlled 测试片段，也不把比赛片段在公开仓库出现当作使用授权。

## 历史范围

[main commits API](https://api.github.com/repos/milad67/Freestyle-Wrestling-Dataset/commits?per_page=100) 返回 11 个提交，最后一个无 parent。每个提交的完整 recursive tree 均已检查且 `truncated=false`，未发现单独的 checkpoint 路径。

| commit | 日期 UTC | 变更 |
| --- | --- | --- |
| `9dad3e652507e57714c60abb3a3853d000267e4c` | 2026-06-26 | README |
| `c8f4cde43aff0dab0d7bf90d0a7718546fe41c59` | 2026-01-07 | segmentation.py |
| `09095321204b0b0f58c660ee2edc8daa211d9097` | 2025-11-20 | README |
| `939ee47f3902536dc7ee2564ee03250fe043f7f5` | 2025-11-20 | train.py |
| `846712ee98826618bdaf379c76c5abe63f73a491` | 2025-11-20 | dataset.py |
| `50f91a66982e8393cd9a5884a8e65c000edef322` | 2025-11-20 | segmentation.py |
| `cce7aec47f0c877791046a4202a82c88df649342` | 2025-11-20 | architecture.py |
| `a3a82dc7eec7986a3f2e3ede1f8dcae51f5bfba1` | 2025-11-20 | requirements |
| `d7716b03c3a013d5ad0e791aaabb6e2e349769cc` | 2025-11-20 | README |
| `89d3c99f967563644627c2ffb0630f026cf5bed0` | 2023-11-20 | Foreground 数据 RAR |
| `faf5ee676fff536868ac7d465a6bd7c6729c029e` | 2023-11-20 | intoduction，根提交 |

## 阻塞原因

[train.py](https://github.com/milad67/Freestyle-Wrestling-Dataset/blob/9dad3e652507e57714c60abb3a3853d000267e4c/train.py) 的 `torch.save` 只规定训练输出名 `fsw_action_model.pth`；该名字不是可用下载地址。该脚本会重新训练，不在当前任务授权范围内。

[architecture.py](https://github.com/milad67/Freestyle-Wrestling-Dataset/blob/9dad3e652507e57714c60abb3a3853d000267e4c/models/architecture.py) 使用通用 EfficientNet-B7 DEFAULT 初始化 backbone，再创建 Bi-LSTM 和七类 dense head；这不包含 FSW 训练参数。[dataset.py](https://github.com/milad67/Freestyle-Wrestling-Dataset/blob/9dad3e652507e57714c60abb3a3853d000267e4c/dataset.py) 按本地目录排序分配标签，不能仅凭论文的 C1–C7 顺序推断未知 checkpoint 的类别索引。

论文描述经摔跤图像微调的 DeepLabV3+，但 [segmentation.py](https://github.com/milad67/Freestyle-Wrestling-Dataset/blob/9dad3e652507e57714c60abb3a3853d000267e4c/utils/segmentation.py) 调用通用 torchvision DeepLabV3 ResNet101 DEFAULT。两者架构和训练参数均不能直接等同。还需明确短片采样/补帧行为：公开 dataset.py 对短片零填充，论文描述的标准化包含重复帧。不能通过猜测弥合这些差异。

这是七类、完整动作短片的关闭集分类任务；当前没有依据宣称检测未知动作、确定进攻方、定位动作时间段或判断成功/得分。论文评估数字也不代表本地视频的效果。

## 已实现的接入边界

`arena.fsw.fsw_status(settings)` 读取 `settings.fsw_bundle` 指向的本地 JSON。检查 schema、来源 URL、40 位 source commit、CNN_BiLSTM/Open FSW 声明、完整七类标签、预处理声明，以及动作/分割文件的相对路径与 SHA256。文件必须位于 bundle 目录中，不允许 URL、绝对路径或目录逃逸。来源字段和哈希只是声明/完整性检查，不能证明模型经过 FSW 训练，也不能证明架构兼容。

所有情况都保持 `ready=false`。即 manifest 与文件哈希全部匹配，也返回 `verification_required`，`strict_load_verified=false`、`real_clip_verified=false`。manifest 中的 `verified`/`ready` 不会启用后端。`FSWBackend.classify(...)` 抛出 `BackendUnavailable`，不会生成标签或概率。

本轮交付是预检与阻塞接口，尚未完成可运行的推理适配器。此版本没有模型 runner，不安装 PyTorch、不执行 `torch.load`，也不发起模型下载。后续即使用户提供正确 checkpoint，仍须新增实际 loader 和独立来源核实/运行验证；不能仅修改 manifest 启用推理。届时必须用安全权重读取方式，完整 `state_dict` strict load，核实分类与分割架构、标签和预处理，并通过已授权真实片段 CPU 推理验证后再开放标准 recognition 结果。

CLI：

```sh
python scripts/check_fsw.py
python scripts/check_fsw.py --bundle /absolute/path/to/bundle.json
```

默认读取环境变量 `FSW_BUNDLE`。当前无 bundle 时打印 `FSW-Net: BLOCKED [missing_bundle]`，退出码 2；manifest 齐全但未获验证时同样退出 2。

验证：先运行新测试，因 `arena.fsw` 缺失失败；实现后 `python -m unittest discover -s tests -p test_fsw.py -v` 的 11 项测试通过，覆盖缺失文件、非法 JSON/schema、架构/标签/预处理不符、路径限制、哈希不符、缺少分割器和伪造验证标记。测试文件只使用明确无效的字节验证文件完整性，不模拟模型预测。没有完成模型加载或真实片段 FSW 推理。
