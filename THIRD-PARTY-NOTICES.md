# 第三方归属说明(Third-Party Notices)

本文件记录 BigHead 仓库内**由上游复制而来**的代码,及其原始许可。
与 [NOTICE](NOTICE) 的关系:NOTICE 是面向使用者的法律声明,
本文件是维护者核对来源的工作记录,**两者内容必须一致**。

Apache-2.0 §4(a) 要求分发时附带许可副本,§4(c) 要求保留原始
版权与归属声明,§4(d) 要求转发 NOTICE 内容。本文件即为此而存在。

## 判定方法

复制代码时**只看目录级 LICENSE 文件是不够的**。一个 vendor 目录
可能有多个上游,各自的许可不同 —— 本目录正是这种情况:
主上游 IP-Adapter 是 Apache-2.0,但 `resampler.py` 实际抄自两个
**MIT** 上游。抄 MIT 代码却只挂 Apache-2.0,会让下游误以为可以
按 Apache-2.0 的宽松方式(例如随意改版权头)使用那段代码,
而 MIT 明确要求保留原始声明。

**判定步骤**:看文件头 `# modified from ...` 注释 → 打开该上游仓库
的 LICENSE → 逐条记录,不要从父目录的许可推断。

## backend/vendor/ip_adapter/

| 上游 | 许可 | Copyright | 涉及文件 |
|---|---|---|---|
| [tencent-ailab/IP-Adapter](https://github.com/tencent-ailab/IP-Adapter) | Apache-2.0 | 2023 Tencent Hunyuan Team | 目录下绝大多数文件 |
| [huggingface/diffusers](https://github.com/huggingface/diffusers) | Apache-2.0 | HF contributors | `attention_processor.py`、`attention_processor_faceid.py`、`utils.py` |
| [mlfoundations/open_flamingo](https://github.com/mlfoundations/open_flamingo) | MIT | © 2023 Anas Awadalla 等 15 人 | `resampler.py` |
| [lucidrains/imagen-pytorch](https://github.com/lucidrains/imagen-pytorch) | MIT | © 2022 Phil Wang | `resampler.py` |

论文出处:arXiv:2308.06721 — IP-Adapter: Text Compatible Image
Prompt Adapter for Text-to-Image Diffusion Models
(Ye Hu, Zhang Jun, Liu Sibo, Han Xiao, Yang Wei)

### 已知的合规缺口

上游文件**只有 `# modified from ...` 注释,没有版权头**。
Apache-2.0 §4(c) 与 MIT 都要求保留上游版权与归属声明 ——
现状是归属只在第三方仓库层面可查,文件层面缺失。

两种修复路径,任选其一:

- **A. 在文件头补注释**。改动最小,不影响 diff 逻辑,
  但每个文件都容易在后续编辑中被弄丢。
- **B. 集中声明**。保持文件不动,依赖本文件 + NOTICE 满足 §4(c)。
  Apache-2.0 §4(c) 要求的是「保留 Source form 中的声明」,
  若源文件本就没有完整版权头,严格解释下仍应在文件层补齐。

**当前采用 B**,因此本文件与 NOTICE 必须随代码一同分发、不得删除。

### 未纳入本目录的部分

`.gitignore` 已排除以下路径,它们**不是**本项目源码,也无第三方归属问题:

- `backend/vendor/clip_vision/` —— CLIP 权重,来自 LAION
- `backend/vendor/hf_cache/` —— HuggingFace 缓存

`.pylibs/`(PEFT,Apache-2.0)同样被排除,由 pip 安装生成。

## 模型权重

**模型权重不在本仓库内,不受本项目任何许可覆盖。**

本项目运行时依赖的第三方权重(SDXL、IP-Adapter FaceID、胶片 LoRA、
Qwen-Image-Edit、InsightFace 等)各有独立许可,多为限制性或非商业条款。
**代码许可与权重许可是两件事** —— InsightFace 代码为 MIT(可商用),
但其预训练权重仅限非商业研究,这类差异不会被 LICENSE 文件覆盖。

完整风险清单见 [NOTICE](NOTICE)。
