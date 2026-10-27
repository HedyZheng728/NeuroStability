# RTMPose 本地接入验证（2026-10-26）

GOAL：验证成熟二维模型实际运行并进入上传、任务、关键点、质量规则与复盘链路。
CONTEXT：FSW-Net 无可核实的专项分类 checkpoint；先使二维测量真正可运行。
CONSTRAINTS：不训练模型；公开素材仅用于软件验证；不写入用户训练档案；不将检测、关键点或代理指标解释为摔跤动作标签、真实重心或能力分数。
DONE WHEN：本机真实权重加载成功，正/负输入有可追溯输出，浏览器显示真实骨架，回归通过。

## 权重与环境

来源见 [rtmlib 模型库](https://github.com/Tau-J/rtmlib#model-zoo)。本机取得的是该库链接的 OpenMMLab 官方 ZIP，非重新训练或随机初始化参数。

| 模型 | 输入 / 输出约定 | 本地 ONNX SHA256 |
|---|---|---|
| YOLOX-m HumanArt | 640×640；逐帧人体检测框 | `3dea6513388889f0fff4b77bf7a26013600321b9eb9ceb0e9a400a82572f5f23` |
| RTMPose-m body7 | 宽192×高256；COCO17 二维关键点 | `5c0a4bf67953e6d2ac43ce15e77dc9d5d354ae18430a47d2c5963a7bc5683e3c` |

- 检测包：<https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip>
- 姿态包：<https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip>
- ZIP SHA256 分别为 `a000224fd8ba283202bc62d4a5fcdfe353adb9f468777dbac1ea2ada2093adde`、`f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741`。
- 已安装版本：Python 3.13.0、rtmlib 0.0.15、ONNX Runtime 1.27.0、OpenCV headless 5.0.0.93；使用 CPU。
- 来源与摘要保存在被 Git 忽略的 `models/rtmpose/manifest.json`。这些是本次取得文件的摘要，用于复现与变化检查，不应称为发布者数字签名。
- 补充完整性核对：使用 `curl --disable` 保持证书校验重新读取两个官方 ZIP 的响应头，均与已下载文件的 `Content-MD5` 匹配；这用于传输完整性核对，不代替数字签名。

本机 Python HTTPS 握手失败，改用保持证书验证的系统 curl 取得文件。安装器提供 `--transport curl`；明确屏蔽 `.curlrc`，仅允许 HTTPS 初始请求及重定向，限制包大小与超时。权重以临时文件完成读取和 ZIP CRC 验证后原子替换。推理前后比较模型 SHA，不一致时拒绝发布结果。

## 公开验证输入与实测

| 输入 | 来源及校验 | 实际输出 |
|---|---|---|
| 无人黑色画面，2秒 / 10fps | FFmpeg 测试夹具 | 20个采样帧，0个人物帧；指标为 null，需复核 |
| 多人街景，1秒 / 5fps | [MMPose demo.mp4](https://github.com/open-mmlab/mmpose/blob/main/demo/resources/demo.mp4)；Git blob `2ba10c2a68726ccb398163e4505cfd190ec4dba1`；文件SHA256 `dc788b413f384887dab9502197657c05393efd1d26825831e4da6fa75b4908c9` | 5帧均检出多个人；5帧歧义、0可用帧；三项指标为 null、专项分数未评定；任务 needs_review |
| 掰手腕近景，取原视频前3秒 | [MMAction2 demo.mp4](https://github.com/open-mmlab/mmaction2/blob/main/demo/demo.mp4)；Git blob `8a1ffbf2cd72d916094a1f2c0ddc56586787e385`；SHA256 `071e60535eaf0aed475ddac06269ee0cdfc4740158f22d9ccd2c3b93b42aa344` | 保留源28fps，按时间戳采样得到28帧；28帧检出人物且有多人歧义；不生成有效指标 |

公开视频未进入交付工作区数据库，仅保存在本轮临时 QA 目录。没有把掰手腕当成自由式摔跤动作验证，也没有给这些素材标注竞技成绩。两段视频均不能验证单个运动员的纵向测量效度。

CLI 实测墙钟约6.35秒（街景1秒）、13.82秒（近景3秒），含预处理、模型加载和 CPU 推理，且两命令同时运行；这些不是吞吐或线上性能基准。

## 复现

```sh
.venv/bin/python -m pip install -r requirements-models.txt
.venv/bin/python scripts/install_rtmpose.py --download --transport curl
.venv/bin/python scripts/check_rtmpose.py
.venv/bin/python scripts/check_rtmpose.py --video /absolute/path/to/mmpose-official-demo.mp4 --output /tmp/pose-check.json
ARENA_TEST_REAL_MODELS=1 ARENA_TEST_MULTIPERSON_VIDEO=/absolute/path/to/mmpose-official-demo.mp4 .venv/bin/python -m unittest discover -s tests -v
```

最后一项测试要求上述 MMPose 官方5帧短片，固定断言其时间戳 `[0,0.2,0.4,0.6,0.8]`，不能随意替换成长视频。测试不下载素材；不提供显式开关时，3项真模型测试跳过。其余测试不依赖模型文件或网络。

本轮44项全量测试通过（包含3项真实模型测试），前端 TypeScript / Vite 生产构建通过。IAB桌面浏览器验证 RTMPose 任务提交、骨架开关、真实关键点渲染、多人物质量提示；无 console error/warn。API集成验证上传、Worker、pose JSON、人工复盘、历史及不合格结果的趋势排除。

独立评审发现的 HTTPS 降级重定向、curl 配置继承两项问题均补回归后修复；另以真实模型复制件复现并修复推理期间权重变化造成的摘要错配。没有修改实际模型参数。

## 下一步验收边界

需要授权的单人稳定性/步法片段和双人对抗片段，人工逐段确认对象及遮挡，评价关键点误差、可用帧比例、重测可靠性和同条件趋势。固定ROI只筛选候选，不构成跨帧身份跟踪。FSW-Net专项分类、WHAM三维重建、语言模型草稿、Docker / PostgreSQL / COS及香港线上部署均有各自未完成的验证项，不由本轮结果代替。
