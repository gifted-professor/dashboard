# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

### Initial local setup
- `cp .env.example .env`
- `cp config/sources.example.json config/sources.local.json`
- Fill in `.env` (`LARK_PROFILE`, optional `LARK_CLI_BIN`, optional `SOURCES_CONFIG_PATH`, optional `LARK_SYNC_LIMIT`) and the Base/table/view IDs in `config/sources.local.json`.

### Main workflows
- `npm run sync` — pull Feishu Base data into local caches (`orders_live.json`, `orders_realtime.json`, `birthday_members.json`, `duty_schedule.json`)
- `npm run build:dashboard` — rebuild `dashboard_data.json`
- `npm run build:customer` — rebuild `customer_action_data.json`
- `npm run build` — run both build steps
- `npm run refresh` — sync first, then rebuild both derived JSON files
- `npm run serve` — start the local static server on `http://127.0.0.1:8899` by default

### Direct script entry points
Use these when iterating on one stage of the pipeline:
- `node sync_danhao.js`
- `node build_dashboard_data.js`
- `node build_customer_action_data.js`
- `node server.js`

### Tests / lint
- There is no automated test suite in this repo.
- There is no lint script in `package.json`.
- There is no single-test command because no test runner is configured.
- Validation is manual: run the relevant build command(s), then `npm run serve`, and verify the affected dashboard section in the browser.

## High-level architecture

### Runtime model
- This is a zero-build Node + static HTML project. There is no framework, bundler, or component system.
- `server.js` is a small HTTP server that loads `.env`, serves files from the repo root, blocks path traversal, and gzips compressible assets.
- `index.html` contains the entire frontend: markup, styles, state, rendering logic, filtering/sorting, and Chart.js usage.
- Chart.js is loaded from a CDN at runtime; there are no frontend npm dependencies.

### Data flow
```text
Feishu Base
  -> sync_danhao.js
     -> orders_live.json
     -> orders_realtime.json
     -> birthday_members.json
     -> duty_schedule.json

orders_realtime.json + duty_schedule.json
  -> build_dashboard_data.js
     -> dashboard_data.json

orders_realtime.json + birthday_members.json
  -> build_customer_action_data.js
     -> customer_action_data.json

server.js
  -> serves index.html + the generated JSON files

index.html
  -> fetches orders_realtime.json for order search/history
  -> fetches dashboard_data.json for overview/risk/team metrics
  -> fetches customer_action_data.json for customer prioritization/actions
```

### Sync layer: schema boundary and raw data normalization
- `sync_danhao.js` is the boundary between Feishu and the rest of the app.
- It fetches four configured sources (`full`, `realtime`, `birthday`, `duty`) through local `lark-cli` commands.
- It maps Chinese Feishu field names into normalized English keys such as `customer_name`, `sku_name`, `refund_type`, `return_status`, `revenue`, `employee`, etc.
- If the Feishu schema changes, update `sync_danhao.js` first. Downstream builders and the frontend assume this normalized shape.
- `orders_realtime.json` is not just the realtime view: it is a merged dataset of realtime rows plus historical rows from the full table, deduped by tracking number or a fallback composite key.
- All generated JSON writes are atomic via `*.tmp.json` + rename.

### Builder layer: business logic lives in Node scripts, not in the UI
- `build_dashboard_data.js` produces the operational summary used by the dashboard/risk/team/overview views and computes team `avg_daily_orders` from orders divided by deduped duty days.
- `build_customer_action_data.js` produces the customer scoring and recommendation model used by the customer/action views.
- Both builders currently:
  - exclude the `样品` and `代发` platforms
  - restrict analysis to the hard-coded active employee set in the scripts
  - use a 14-day primary window
  - use a 7-day lagged window for return-rate calculations
- If business definitions change, update the builder constants and derived fields first; the frontend mainly renders precomputed output.

### Frontend data contract
- The orders section works directly from `orders_realtime.json` and implements client-side search, filters, pagination, and sorting.
- The customer history panel does not have its own API; it reconstructs history in the browser by matching a selected customer from `customer_action_data.json` back to raw order records in `orders_realtime.json`.
- The dashboard, risk, team, and monthly comparison views are driven by `dashboard_data.json`.
- The customer pool and weekly action list are driven by `customer_action_data.json`.
- Because `index.html` is monolithic and stateful, if you rename output fields or change derived-data structure, update the corresponding inline rendering/sorting code in the same change.

## Repo-specific notes
- Generated JSON caches and local config are intentionally gitignored and may contain customer PII. Do not commit:
  - `.env`
  - `config/sources.local.json`
  - `orders_live.json`
  - `orders_realtime.json`
  - `dashboard_data.json`
  - `customer_action_data.json`
  - `birthday_members.json`
  - `duty_schedule.json`
  - `*.tmp.json`
- This repo has no meaningful `npm install` step; the main external prerequisite is an authenticated local `lark-cli` profile.
- If you change the local workflow or startup instructions, update `README.md` too. `PROJECT_HANDOVER.md` treats README maintenance as part of the expected upkeep.
