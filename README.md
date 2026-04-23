# Dashboard 经营驾驶舱

一个面向本地运营使用的业务工作台仓库。

这个项目把四件事放在同一个目录里：
- **飞书数据同步**：从 Feishu Base 拉取订单与会员生日数据
- **飞书 AI 资产同步**：从 Feishu Base 拉取 AI 提示词模板与默认素材，并把附件缓存到本地
- **本地数据构建**：生成页面直接消费的统计 JSON
- **会议纪要可视化**：用本地 `meeting_summary.json` 驱动本周行动板块
- **本地 AI 工具**：通过本机 CLIProxyAPI 提供“自由生图”和“得物报告图”两类生成能力
- **静态工作台页面**：查看订单、经营概览、风险、团队表现、客户池、行动建议与 AI 工具

它的定位是：**可本地运行、可持续迭代、可放到 GitHub 管理版本，但不上传真实业务数据和本地私有配置。**

## 运行前准备

### 1. 复制本地配置

```bash
cp .env.example .env
cp config/sources.example.json config/sources.local.json
```

### 2. 填写本地参数

`.env`:
- `LARK_PROFILE`：本地 `lark-cli` profile 名称
- `LARK_CLI_BIN`：可选，自定义 `lark-cli` 路径
- `SOURCES_CONFIG_PATH`：可选，自定义源配置路径
- `LARK_SYNC_LIMIT`：可选，单次同步分页大小
- `AI_PROXY_BASE_URL`：可选，AI 上游地址；本机 CLIProxyAPI 默认 `http://127.0.0.1:8317`，若要直连 OpenAI GPT Image，可改成 `https://api.openai.com`
- `AI_PROXY_API_KEY`：可选，AI 上游 Bearer key；本机 CLIProxyAPI 默认直接用 `cliproxyapi-local`
- `AI_DEWU_MODEL`：可选，得物图生成模型名，默认 `gemini-3.1-flash-image`；若要试 OpenAI 图片模型，可填 `gpt-image-2`
- `AI_DEWU_RESPONSES_MODEL`：可选，仅在 `AI_DEWU_MODEL` 为 OpenAI 图片模型时使用；默认 `gpt-5.4`，通过 `/v1/responses` 驱动图片工具
- `AI_DEWU_BASE_IMAGE_PATH`：可选，固定报表底图路径；默认先找 `./assets/dewu-base-report.jpg`，AI 板块会把它当作图 1
- `AI_DEWU_TIMEOUT_MS`：可选，AI 请求超时时间
- `AI_DEWU_MAX_FILE_BYTES`：可选，单张上传图片大小限制

`config/sources.local.json`:
- `full`：全量订单表
- `realtime`：实时订单视图
- `birthday`：会员生日表
- `duty`：值班表
- `aiPrompts`：AI 提示词模板表
- `aiMaterials`：AI 素材表

如果本地没有可用的 `lark-cli` profile，同步脚本无法运行。

## 首次运行推荐顺序

1. 确认本机已安装 `lark-cli`
2. 复制 `.env.example` 和 `config/sources.example.json`
3. 在 `.env` 中填好可用的 `LARK_PROFILE`
4. 在 `config/sources.local.json` 中填入真实的 Base / Table / View 标识
5. 先运行 `npm run sync`
6. 再运行 `npm run build`
7. 最后运行 `npm run serve`

如果 `lark-cli` profile 已存在但 token 过期，也需要先重新登录，再执行同步。

## 常用命令

```bash
npm run sync             # 同步飞书数据到本地 JSON
npm run build:dashboard  # 构建 dashboard_data.json
npm run build:customer   # 构建 customer_action_data.json
npm run build            # 依次执行两个构建脚本
npm run refresh          # 先同步，再执行全部构建
npm run serve            # 启动本地静态服务
npm run ensure:serve     # 检查 8899 是否正常；若未启动/异常则自动拉起
```

默认访问地址：

```text
http://127.0.0.1:8899
```

> 这个仓库没有测试框架和 lint 配置。当前验证方式是运行对应脚本后，本地启动页面检查结果。

## 数据流

```text
Feishu Base
  -> sync_danhao.js
     -> orders_live.json
     -> orders_realtime.json
     -> orders_risk.json
     -> birthday_members.json
     -> duty_schedule.json
     -> ai_assets.json
     -> output/ai-materials/*

orders_realtime.json + duty_schedule.json
  -> build_dashboard_data.js
     -> dashboard_data.json

orders_realtime.json + birthday_members.json
  -> build_customer_action_data.js
     -> customer_action_data.json

server.js
  -> 提供 index.html 与本地 JSON 文件（包含 meeting_summary.json）
  -> 提供 `/api/ai/dewu/config`、`/api/ai/dewu/generate` 与 `/api/ai/image/generate` 本地 AI 接口
```

## 输出文件说明

- `orders_live.json`：全量订单缓存，主要作为历史补全来源
- `orders_realtime.json`：实时订单视图 + 历史订单合并去重后的结果；订单页直接使用，两个构建脚本也从这里取数
- `birthday_members.json`：会员生日与偏好补充信息
- `duty_schedule.json`：客服值班表缓存，用于核心团队的日均单量计算
- `ai_assets.json`：AI 模板库与素材库的本地缓存；自由生图快捷模板、默认参考素材、得物提示词同步都从这里读取
- `output/ai-materials/*`：从飞书素材库下载到本地的附件缓存，页面可直接预览并一键加入参考图
- `dashboard_data.json`：经营总览、风险、团队、月度对比所需数据
- `customer_action_data.json`：客户分层、动态触达窗口、全历史客户价值、共购推荐、动作建议数据
- `meeting_summary.json`：本周行动板块的会议纪要结构化数据；更新周会内容只需改这个文件并刷新页面

## 代码入口

- `sync_danhao.js`：飞书字段映射、分页拉取、去重合并，以及 AI 提示词/素材同步和附件缓存，是外部数据接入边界
- `build_dashboard_data.js`：经营统计、退货率、风险汇总、团队表现，以及按值班天数计算日均单量
- `build_customer_action_data.js`：客户分层、个人历史节奏窗口、全历史客户价值、共购推荐、促单说明
- `index.html`：整页前端 UI、样式、交互逻辑、表格排序筛选、图表渲染，以及 AI 工具交互
- `server.js`：本地静态服务、gzip 输出，以及本机 CLIProxyAPI 代理接口；得物流程会优先读取 `ai_assets.json` 中同步下来的模板提示词

如果飞书字段名变化，优先改 `sync_danhao.js`；如果业务口径变化，优先改两个构建脚本；如果只是展示变化，再改 `index.html`。

## 页面结构

页面目前分为七块：
- `单号查询`
- `经营总览`
- `风险雷达`
- `核心团队`
- `客户库`
- `本周行动`
- `AI 工具`

其中：
- 订单搜索与客户历史订单，直接依赖 `orders_realtime.json`
- 经营、风险、团队、月度对比，依赖 `dashboard_data.json`
- 客户池和行动建议，依赖 `customer_action_data.json`
- `AI 工具 -> 自由生图` 通过 `server.js` 代理到本机 CLIProxyAPI；支持自写提示词、0-6 张参考图、飞书同步的快捷模板、默认参考素材，以及浏览器 `localStorage` 轻量草稿缓存
- `AI 工具 -> 生成得物` 通过 `server.js` 代理到本机 CLIProxyAPI；固定底图来自 `AI_DEWU_BASE_IMAGE_PATH`，客服只需上传 3 张商品图；如果飞书模板库里有启用中的“生成得物”模板，会优先使用那条提示词

客户池当前的几个关键口径：
- 负责人默认显示“最近一笔订单的负责人”
- 客户金额、历史订单、复购节奏、共购推荐按手机号优先聚合全历史订单
- 动态触达窗口优先根据客户自己的历史下单节奏生成；历史浅客户才用 fallback 窗口
- 退货率使用“21 天成熟窗口 + 最近 7 天不计入”的滞后口径

## 常见失败原因

- `npm run sync` 报缺少 `config/sources.local.json`：先复制 `config/sources.example.json`
- `npm run sync` 报 profile 或认证相关错误：检查 `LARK_PROFILE` 是否存在，并确认本地 `lark-cli` 已登录
- `npm run build` 报找不到 `orders_realtime.json`：说明还没先执行 `npm run sync`
- `npm run serve` 报 `EADDRINUSE`：默认端口 `8899` 已被占用，可在 `.env` 中修改 `PORT`
- 页面打开后提示缺少 JSON：通常说明同步或构建还没完成，按 `sync -> build -> serve` 顺序重跑
- 客户池金额明显偏低：检查是否是旧版 `customer_action_data.json`，重新运行 `npm run build:customer` 或 `npm run refresh`
- 客户历史订单出现重复：说明旧版 `orders_realtime.json` 尚未更新，重新运行 `npm run sync`
- 自由生图里看不到飞书模板或默认素材：先运行 `npm run refresh`，确认 `ai_assets.json` 和 `output/ai-materials/` 已生成
- AI 板块提示“AI 代理未配置”：检查 `.env` 中的 `AI_PROXY_BASE_URL`、`AI_PROXY_API_KEY`、`AI_DEWU_MODEL`
- AI 板块提示“固定底图未配置”：检查 `AI_DEWU_BASE_IMAGE_PATH` 是否存在且为 jpg/png/webp
- 点击生成后长时间无结果：先确认 AI 上游正常；Gemini 路径需要 `/v1/chat/completions` 且 `/v1/models` 能看到 `gemini-3.1-flash-image`，`gpt-image-*` 路径则需要上游支持 `POST /v1/responses`

## 隐私与提交约束

以下内容只应保留在本地，不应提交：
- `.env`
- `config/sources.local.json`
- `orders_live.json`
- `orders_realtime.json`
- `birthday_members.json`
- `duty_schedule.json`
- `dashboard_data.json`
- `customer_action_data.json`
- `*.tmp.json`
- 任意带客户手机号、地址、订单明细、真实飞书标识的文件

提交前建议确认 `.gitignore` 仍然有效，并检查仓库中没有残留真实业务数据。

## AI 工具手动验证

1. 在 `.env` 里选择一种上游配置：
   - 本机 CLIProxyAPI + Gemini：
     - `AI_PROXY_BASE_URL=http://127.0.0.1:8317`
     - `AI_PROXY_API_KEY=cliproxyapi-local`
     - `AI_DEWU_MODEL=gemini-3.1-flash-image`
   - OpenAI / 兼容端点 + GPT Image：
     - `AI_PROXY_BASE_URL=https://api.openai.com`
     - `AI_PROXY_API_KEY=<你的 OpenAI API key>`
     - `AI_DEWU_MODEL=gpt-image-2`
     - `AI_DEWU_RESPONSES_MODEL=gpt-5.4`
   - 两种方式都需要：
     - `AI_DEWU_BASE_IMAGE_PATH=<你的固定底图路径>`
2. 若使用本机 CLIProxyAPI，确认它已启动，并执行：
   ```bash
   curl -sS 'http://127.0.0.1:8317/v1/models' \
     -H 'Authorization: Bearer cliproxyapi-local' | rg 'gemini-3.1-flash-image'
   ```
3. 若使用 `gpt-image-*`，请先确认你的上游支持 `POST /v1/responses`。
4. 启动 dashboard：
   ```bash
   npm run serve
   ```
5. 打开页面，确认导航里出现 `AI 工具`，且 `自由生图` 与 `生成得物` 两个面板都能正常切换。
6. 在 `自由生图` 中分别测试：仅输入提示词直接生成、输入提示词并上传 1 张参考图再生成，确认页面最终出现结果图和下载按钮。
7. 在 `生成得物` 中上传 3 张商品图，点击“开始生成”，确认页面最终出现结果图和下载按钮。
8. 若故意停掉上游服务、填错模型名，或把 `gpt-image-*` 指向一个不支持 `/v1/responses` 的代理，确认页面显示友好错误，而不会暴露 Bearer key。
