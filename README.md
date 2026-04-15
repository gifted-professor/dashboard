# Dashboard Business Cockpit

这是一个本地运行的业务仪表盘项目，包含三部分：
- 飞书数据同步脚本
- 本地聚合构建脚本
- 静态网页与本地服务器

仓库保留所有可执行脚本和命令，但**不应提交真实业务数据、客户信息和本地飞书配置**。

## 项目结构

- `index.html`：前端页面与交互逻辑
- `server.js`：本地静态服务器
- `sync_danhao.js`：从飞书同步原始数据到本地 JSON 缓存
- `build_dashboard_data.js`：生成经营统计数据
- `build_customer_action_data.js`：生成客户动作/客户池数据
- `.env.example`：本地环境变量示例
- `config/sources.example.json`：飞书源配置示例
- `.gitignore`：忽略真实数据和本地私有配置

## 当前数据流水线

```text
Feishu Base
  └── sync_danhao.js
        ├── orders_live.json
        ├── orders_realtime.json
        └── birthday_members.json

orders_realtime.json
  ├── build_dashboard_data.js       -> dashboard_data.json
  └── build_customer_action_data.js -> customer_action_data.json

server.js
  └── 本地提供 index.html 与以上 JSON 文件
```

说明：
- 订单页直接使用 `orders_realtime.json`
- 经营统计和客户池构建也基于 `orders_realtime.json`
- `birthday_members.json` 只作为客户池补充信息

## 本地使用方式

### 1. 准备本地配置

复制环境变量模板：

```bash
cp .env.example .env
```

复制飞书源配置模板：

```bash
cp config/sources.example.json config/sources.local.json
```

然后填写你自己的本地配置：
- `.env` 中的 `LARK_PROFILE`
- `config/sources.local.json` 中的 `baseToken` / `tableId` / `viewId`

如果你的 `lark-cli` 不在系统 PATH 中，也可以在 `.env` 中填写 `LARK_CLI_BIN` 绝对路径。

### 2. 执行同步与构建

```bash
npm run sync
npm run build
```

或一步执行：

```bash
npm run refresh
```

### 3. 启动本地网页

```bash
npm run serve
```

默认访问：

```text
http://127.0.0.1:8899
```

如果要修改端口，可在 `.env` 中调整 `PORT`。

## 可用命令

- `npm run sync`：同步飞书数据到本地 JSON
- `npm run build:dashboard`：构建经营统计 JSON
- `npm run build:customer`：构建客户池 JSON
- `npm run build`：依次构建统计与客户池
- `npm run refresh`：先同步，再构建
- `npm run serve`：启动本地服务器

## 不应提交到 GitHub 的内容

这些文件默认应保持本地：
- `.env`
- `config/sources.local.json`
- `orders_live.json`
- `orders_realtime.json`
- `dashboard_data.json`
- `customer_action_data.json`
- `birthday_members.json`
- `*.tmp.json`

如果目录里还有旧的本地缓存，例如 `full_orders.json`、`danhaodata.json`，也不要提交。

## 发布到 GitHub 前建议检查

发布前建议全仓搜索并确认没有以下内容：
- 绝对路径（如 `/Users/...`）
- 真实 `baseToken`
- 真实 `tableId`
- 真实 `viewId`
- 本地 profile 名称
- 客户手机号、地址、真实订单缓存

## 环境要求

- Node.js
- 已安装并可用的 `lark-cli`
- 本地可访问飞书数据源的账号与权限

## 备注

这个仓库更适合做：
- 私有 GitHub 仓库
- 代码与脚本版本管理
- 本地复制后继续跑同步与构建

它不是一个默认自带真实数据的公开演示仓库。
