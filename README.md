# Dashboard 经营驾驶舱

一个面向本地运营使用的业务工作台仓库。

它把三类东西放在同一个项目里：
- **飞书数据同步脚本**：从 Feishu Base 拉取订单与会员生日数据
- **本地数据构建脚本**：生成仪表盘统计和客户动作数据
- **静态网页工作台**：用于查看订单、经营概览、风险、客户池与促单线索

这个仓库的定位不是公开演示站，而是一个**可本地复制、可持续迭代、可上传 GitHub 管理版本**的业务项目模板。

## 项目目标

这个项目主要服务于两件事：

1. **经营可视化**
   - 查看近期订单、收入、退货、员工和厂家表现
   - 快速发现风险点与高退货组合

2. **促单工作台**
   - 识别可触达客户
   - 结合历史订单、复购节奏、生日信息做轻量提醒
   - 为后续跟单、召回、二次促单提供依据

## 核心能力

### 1. 飞书数据同步
通过 `sync_danhao.js` 本地同步飞书数据，输出：
- `orders_live.json`
- `orders_realtime.json`
- `birthday_members.json`

其中：
- `orders_realtime.json` 用于订单页展示
- `birthday_members.json` 用于客户池生日补充信息

### 2. 本地聚合构建
通过两个脚本生成网页直接消费的数据：
- `build_dashboard_data.js` → `dashboard_data.json`
- `build_customer_action_data.js` → `customer_action_data.json`

### 3. 本地工作台页面
通过 `server.js` 启动本地静态服务，打开后可查看：
- 最新订单查询
- 经营概览
- 风险观察
- 团队表现
- 可触达客户池
- 客户历史订单与生日补充信息

## 仓库结构

- `index.html`：前端页面与交互逻辑
- `server.js`：本地静态服务器
- `sync_danhao.js`：飞书同步脚本
- `build_dashboard_data.js`：经营统计构建脚本
- `build_customer_action_data.js`：客户池构建脚本
- `.env.example`：本地环境变量模板
- `config/sources.example.json`：飞书源配置模板
- `.gitignore`：忽略真实数据和本地私有配置

## 数据流

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
  └── 提供 index.html 与本地 JSON 文件
```

## 为什么这个仓库适合放 GitHub

这个仓库保留了：
- 所有脚本
- 所有命令入口
- 页面代码
- 公开可读的使用说明

同时默认排除了：
- 真实业务 JSON 数据
- 本地 `.env`
- 本地飞书源配置
- 临时文件

也就是说，你可以：
- 把代码放到 GitHub 做版本管理
- 在任意机器把整个文件夹拷下来继续本地跑
- 不把真实客户数据和敏感配置传上去

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

如果 `lark-cli` 不在系统 PATH 中，也可以在 `.env` 中填写 `LARK_CLI_BIN`。

### 2. 执行同步与构建

```bash
npm run sync
npm run build
```

或者一步执行：

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

## 可用命令

- `npm run sync`：同步飞书数据到本地 JSON
- `npm run build:dashboard`：构建经营统计数据
- `npm run build:customer`：构建客户动作数据
- `npm run build`：依次构建统计与客户池
- `npm run refresh`：先同步，再构建
- `npm run serve`：启动本地服务器

## 隐私与发布说明

以下内容只应保留在本地，不应提交到远端仓库：
- `.env`
- `config/sources.local.json`
- `orders_live.json`
- `orders_realtime.json`
- `dashboard_data.json`
- `customer_action_data.json`
- `birthday_members.json`
- `*.tmp.json`
- 任何旧的真实缓存文件，例如 `full_orders.json`、`danhaodata.json`

发布前建议确认仓库中不包含：
- 本机绝对路径
- 真实飞书源标识
- 客户手机号、地址、真实订单明细
- 本地 profile 名称

## 适合的使用方式

这个仓库更适合：
- 私有 GitHub 仓库
- 本地业务项目持续迭代
- 自己或小团队内部维护

不适合：
- 直接作为带真实数据的公开演示站
- 不配置飞书源就期望拉到真实数据

## 后续可以继续扩展的方向

- 增加自动同步脚本或定时任务
- 增加更细的客户分层与动作建议
- 补充示例数据模式，方便在无真实数据时演示页面
- 继续优化 README 首页展示、截图和模块说明
