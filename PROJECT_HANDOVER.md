# Dashboard Project Handover

## 项目定位

这是一个本地运行的业务仪表盘项目，目标是：
- 保留同步脚本、构建脚本、页面代码都在同一个目录中
- 支持本地拉取飞书数据并重建页面所需 JSON
- 便于上传到 GitHub 做代码管理，但不包含真实业务数据和本地私有配置

## 核心文件

- `index.html`：页面 UI 与前端逻辑
- `server.js`：本地静态服务
- `sync_danhao.js`：同步飞书原始数据
- `build_dashboard_data.js`：构建经营统计数据
- `build_customer_action_data.js`：构建客户动作数据
- `package.json`：统一命令入口
- `.env.example`：环境变量模板
- `config/sources.example.json`：飞书源配置模板

## 标准使用流程

1. 复制本地环境配置：
   - `.env.example` → `.env`
   - `config/sources.example.json` → `config/sources.local.json`
2. 填入你自己的本地 `lark-cli` profile 与飞书源标识
3. 运行：
   - `npm run sync`
   - `npm run build`
   - `npm run serve`
4. 浏览器打开 `http://127.0.0.1:8899`

## 当前输出文件

`sync_danhao.js` 会生成：
- `orders_live.json`
- `orders_realtime.json`
- `birthday_members.json`

`build_dashboard_data.js` 会生成：
- `dashboard_data.json`

`build_customer_action_data.js` 会生成：
- `customer_action_data.json`

## 发布约束

以下内容只应保留在本地，不要进入 GitHub：
- `.env`
- `config/sources.local.json`
- 全部真实 JSON 缓存
- 任意带客户手机号、地址、订单明细的文件
- 任意真实飞书 Base / Table / View 标识

## 维护说明

- 如果飞书字段发生变化，优先更新 `sync_danhao.js` 内的字段映射逻辑
- 如果客户池或经营统计口径变化，分别更新：
  - `build_customer_action_data.js`
  - `build_dashboard_data.js`
- 如果页面展示变化，更新 `index.html`
- 如果本地启动方式变化，更新 `README.md`

## GitHub 上传建议

推荐使用 private repo。

上传前至少检查：
- `.gitignore` 是否生效
- 真实 JSON 是否未被跟踪
- `.env` 和 `config/sources.local.json` 是否未被提交
- 文档中是否仍残留真实标识或绝对路径
