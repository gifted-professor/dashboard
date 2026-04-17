#!/usr/bin/env node
/**
 * 同步飞书数据到本地缓存
 * - orders_live.json: 汇总全量表（经营统计、客户聚合使用）
 * - orders_realtime.json: 实时视图 + 汇总表合并（订单页使用）
 * - orders_risk.json: 风险雷达专用 30 天视图（售后风险使用）
 * - birthday_members.json: 会员生日表（客户池补充信息）
 * - duty_schedule.json: 客服值班表（团队日均单量使用）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, '.env'));

const CONFIG_PATH = process.env.SOURCES_CONFIG_PATH
  ? path.resolve(ROOT, process.env.SOURCES_CONFIG_PATH)
  : path.join(ROOT, 'config', 'sources.local.json');
const OUTPUT_DIR = ROOT;
const LARK_CLI = process.env.LARK_CLI_BIN || 'lark-cli';
const LIMIT = Number.isFinite(Number(process.env.LARK_SYNC_LIMIT)) ? Number(process.env.LARK_SYNC_LIMIT) : 200;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function requireValue(value, label) {
  if (value == null || String(value).trim() === '') {
    throw new Error(`${label} is required. Update ${CONFIG_PATH} or .env before running sync_danhao.js`);
  }
  return String(value).trim();
}

function buildSource(sourceConfig, fallbackLabel, outputName) {
  if (!sourceConfig || typeof sourceConfig !== 'object') {
    throw new Error(`Missing source config for ${fallbackLabel} in ${CONFIG_PATH}`);
  }
  return {
    label: sourceConfig.label || fallbackLabel,
    baseToken: requireValue(sourceConfig.baseToken, `${fallbackLabel} baseToken`),
    tableId: requireValue(sourceConfig.tableId, `${fallbackLabel} tableId`),
    viewId: sourceConfig.viewId ? String(sourceConfig.viewId).trim() : null,
    outputFile: path.join(OUTPUT_DIR, outputName),
    tmpFile: path.join(OUTPUT_DIR, outputName.replace('.json', '.tmp.json')),
  };
}

function loadSyncConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing local source config: ${CONFIG_PATH}\n` +
      'Copy config/sources.example.json to config/sources.local.json and fill in your local values.'
    );
  }

  const config = readJson(CONFIG_PATH);
  const sources = config.sources || config;
  const profile = process.env.LARK_PROFILE || config.profile;

  return {
    profile: requireValue(profile, 'LARK_PROFILE or config.profile'),
    fullSource: buildSource(sources.full, '账单汇总_全部/汇总(全部)', 'orders_live.json'),
    realtimeSource: buildSource(sources.realtime, '单号查询/库存管理/实时视图', 'orders_realtime.json'),
    riskSource: buildSource(sources.risk, '单号查询/售后风险30天视图', 'orders_risk.json'),
    birthdaySource: buildSource(sources.birthday, '单号查询/会员生日', 'birthday_members.json'),
    dutySource: buildSource(sources.duty, '单号查询/值班表', 'duty_schedule.json'),
  };
}

const {
  profile: PROFILE,
  fullSource: FULL_SOURCE,
  realtimeSource: REALTIME_SOURCE,
  riskSource: RISK_SOURCE,
  birthdaySource: BIRTHDAY_SOURCE,
  dutySource: DUTY_SOURCE,
} = loadSyncConfig();

function parseCliJson(output) {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('No JSON found in lark-cli output');
  return JSON.parse(output.slice(start));
}

function normalizeCell(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (item == null) return '';
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item).trim();
        if (typeof item === 'object') {
          if (item.name) return String(item.name).trim();
          if (item.text) return String(item.text).trim();
          if (item.file_token && item.name) return String(item.name).trim();
        }
        return String(item).trim();
      })
      .filter(Boolean)
      .join(',');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

function text(value) {
  const normalized = normalizeCell(value);
  if (normalized == null) return null;
  const str = String(normalized).trim();
  return str === '' ? null : str;
}

function normalizePhone(value) {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}

function numberValue(...values) {
  for (const value of values) {
    const normalized = normalizeCell(value);
    if (normalized == null) continue;
    const cleaned = String(normalized).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    if (!cleaned) continue;
    const num = Number(cleaned);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

function mapOrderRecord(fields, row, recordId) {
  const raw = {};
  fields.forEach((fieldName, idx) => {
    raw[fieldName] = row[idx];
  });

  return {
    record_id: recordId,
    customer_name: text(raw['姓名']),
    sku_name: text(raw['货品名']) || text(raw['商品名称']),
    tracking_no: text(raw['单号']),
    employee: text(raw['负责人']),
    factory: text(raw['厂家']),
    platform: text(raw['出售平台']),
    phone: normalizePhone(raw['手机号']),
    address: text(raw['地址']),
    customer_info: text(raw['客户信息']),
    pay_date: text(raw['顾客付款日期']),
    order_date: text(raw['报单日期']),
    ship_date: text(raw['出单号日期']),
    pay_amount: numberValue(raw['打款金额']),
    pay_date_actual: text(raw['打款日期']),
    revenue: numberValue(raw['收款额']),
    net_revenue: numberValue(raw['净收款']),
    cost: numberValue(raw['优化成本'], raw['成本价']),
    profit: numberValue(raw['优化利润'], raw['毛利']),
    profit_margin: numberValue(raw['优化利润率']),
    status: text(raw['状态']),
    is_paid: text(raw['是否打款']) || text(raw['打款信息']),
    is_shipped: text(raw['是否出库']) || text(raw['公式出库']),
    refund_type: text(raw['退款类型']),
    refund_reason: text(raw['退款原因']),
    refund_amount: numberValue(raw['退款金额']),
    refund_date: text(raw['退款日']),
    return_status: text(raw['退货状态']),
    return_tracking: text(raw['退货单号']),
    return_express: text(raw['退货物流']),
    confirm_date: text(raw['厂家确认日期']),
    send_factory_date: text(raw['发给厂家日期']),
    stock_status: text(raw['库存情况']),
    available_factories: text(raw['有货厂家']),
    express: text(raw['快递公司']),
    color: text(raw['颜色']),
    size: text(raw['尺码']),
    remark: text(raw['备注']) || text(raw['备注 1']),
    goods_remark: text(raw['货品备注']),
    data_source: text(raw['数据来源']),
    effective: text(raw['有效']),
    urgency: text(raw['催账紧急程度']) || text(raw['打款信息公式']) || text(raw['打款信息']) || text(raw['未付货款']),
  };
}

function mapBirthdayRecord(fields, row, recordId) {
  const raw = {};
  fields.forEach((fieldName, idx) => {
    raw[fieldName] = row[idx];
  });

  return {
    record_id: recordId,
    member_name: text(raw['会员名称']),
    member_phone: normalizePhone(raw['会员手机号']),
    member_birthday: text(raw['会员生日']) || text(raw['生日日期']),
    member_shop: text(raw['所在店铺']),
    preferred_style: text(raw['偏好款式']),
    expected_gift: text(raw['期待生日会员礼']),
    wechat: text(raw['微信号']),
    filled_at: text(raw['填写表单日期']),
  };
}

function mapDutyRecord(fields, row, recordId) {
  const raw = {};
  fields.forEach((fieldName, idx) => {
    raw[fieldName] = row[idx];
  });

  return {
    record_id: recordId,
    employee: text(raw['客服']) || text(raw['客服姓名']) || text(raw['多选姓名']),
    duty_date: text(raw['上班时间']) || text(raw['当天日期']),
    shift: text(raw['班次']),
  };
}

function fetchPage(source, offset) {
  const viewPart = source.viewId ? ` --view-id "${source.viewId}"` : '';
  const command = `LARK_CLI_NO_PROXY=1 "${LARK_CLI}" base "+record-list" --base-token "${source.baseToken}" --table-id "${source.tableId}"${viewPart} --profile "${PROFILE}" --limit ${LIMIT} --offset ${offset}`;
  const output = execSync(command, {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, LARK_CLI_NO_PROXY: '1' },
  });
  return parseCliJson(output).data;
}

function writeJsonAtomically(targetPath, tmpPath, content) {
  fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2));
  fs.renameSync(tmpPath, targetPath);
}

function isDisplayableOrder(record) {
  return !!(
    text(record.customer_name) ||
    text(record.sku_name) ||
    text(record.tracking_no) ||
    text(record.phone) ||
    text(record.address)
  );
}

function isDisplayableBirthday(record) {
  return !!(record.member_name || record.member_phone || record.member_birthday);
}

function isDisplayableDuty(record) {
  return !!(record.employee && record.duty_date);
}

function syncSource(source, mapper, filterFn) {
  console.log(`[${new Date().toISOString()}] 开始同步 ${source.label} ...`);

  const records = [];
  let offset = 0;
  let page = 0;

  while (true) {
    page += 1;
    const pageData = fetchPage(source, offset);
    const fields = pageData.fields || [];
    const rows = pageData.data || [];
    const recordIds = pageData.record_id_list || [];

    rows.forEach((row, idx) => {
      records.push(mapper(fields, row, recordIds[idx] || null));
    });

    console.log(`  ${source.label} 第 ${page} 页: ${rows.length} 条, 累计 ${records.length} 条`);

    if (!pageData.has_more) break;
    offset += LIMIT;
  }

  const filteredRecords = records.filter(filterFn);
  const removed = records.length - filteredRecords.length;
  if (removed > 0) {
    console.log(`  ${source.label} 过滤空白记录: ${removed} 条`);
  }

  return {
    synced_at: new Date().toISOString(),
    total_records: filteredRecords.length,
    records: filteredRecords,
  };
}

function recordDate(record) {
  return record.pay_date || record.order_date || record.ship_date || '';
}

function dedupeKey(record) {
  const customer = text(record.customer_name) || '';
  const phone = text(record.phone) || '';
  const sku = text(record.sku_name) || '';
  const payDate = text(record.pay_date) || '';
  const orderDate = text(record.order_date) || '';
  const platform = text(record.platform) || '';
  const factory = text(record.factory) || '';
  const revenue = record.revenue != null ? String(record.revenue) : '';
  const tracking = text(record.tracking_no) || '';

  return `order:${customer}|${phone}|${sku}|${payDate}|${orderDate}|${platform}|${factory}|${revenue}|${tracking}`;
}

function sparseDedupeKey(record) {
  const customer = text(record.customer_name) || '';
  const phone = text(record.phone) || '';
  const sku = text(record.sku_name) || '';
  const payDate = text(record.pay_date) || '';
  const platform = text(record.platform) || '';
  const factory = text(record.factory) || '';
  const revenue = record.revenue != null ? String(record.revenue) : '';
  return `sparse:${customer}|${phone}|${sku}|${payDate}|${platform}|${factory}|${revenue}`;
}

function recordRichness(record) {
  return (text(record.tracking_no) ? 4 : 0)
    + (text(record.order_date) ? 2 : 0)
    + (text(record.ship_date) ? 1 : 0);
}

function mergeRealtimeRecords(realtimeRecords, historicalRecords) {
  const merged = [];
  const seenTracking = new Map();
  const seenSparseTracked = new Map();
  const seenSparseLoose = new Map();
  const candidates = [
    ...realtimeRecords.map(record => ({ record, sourcePriority: 0, inRealtimeView: true })),
    ...historicalRecords.map(record => ({ record, sourcePriority: 1, inRealtimeView: false })),
  ].sort((a, b) => {
    const richnessDiff = recordRichness(b.record) - recordRichness(a.record);
    if (richnessDiff !== 0) return richnessDiff;
    return a.sourcePriority - b.sourcePriority;
  });

  for (const { record, inRealtimeView } of candidates) {
    const tracking = text(record.tracking_no);
    const key = dedupeKey(record);
    const sparseKey = sparseDedupeKey(record);

    if (tracking) {
      const existing = seenTracking.get(tracking);
      if (existing) {
        if (inRealtimeView) existing.in_realtime_view = true;
        continue;
      }
      const mergedRecord = { ...record, in_realtime_view: inRealtimeView };
      seenTracking.set(tracking, mergedRecord);
      seenSparseTracked.set(sparseKey, mergedRecord);
      merged.push(mergedRecord);
      continue;
    }

    const existing = seenSparseTracked.get(sparseKey) || seenSparseLoose.get(sparseKey);
    if (existing) {
      if (inRealtimeView) existing.in_realtime_view = true;
      continue;
    }

    const mergedRecord = { ...record, in_realtime_view: inRealtimeView };
    seenSparseLoose.set(sparseKey, mergedRecord);
    merged.push(mergedRecord);
  }

  merged.sort((a, b) => String(recordDate(b)).localeCompare(String(recordDate(a))));
  return merged;
}

function main() {
  const fullData = syncSource(FULL_SOURCE, mapOrderRecord, isDisplayableOrder);
  writeJsonAtomically(FULL_SOURCE.outputFile, FULL_SOURCE.tmpFile, fullData);
  console.log(`✅ 全量缓存完成: ${fullData.total_records} 条 -> ${FULL_SOURCE.outputFile}`);

  const realtimeData = syncSource(REALTIME_SOURCE, mapOrderRecord, isDisplayableOrder);
  const mergedRealtimeRecords = mergeRealtimeRecords(realtimeData.records, fullData.records);
  const mergedRealtime = {
    synced_at: new Date().toISOString(),
    total_records: mergedRealtimeRecords.length,
    realtime_records: realtimeData.total_records,
    historical_records: fullData.total_records,
    records: mergedRealtimeRecords,
  };
  writeJsonAtomically(REALTIME_SOURCE.outputFile, REALTIME_SOURCE.tmpFile, mergedRealtime);
  console.log(`✅ 实时订单缓存完成: 实时 ${realtimeData.total_records} 条 + 历史 ${fullData.total_records} 条 -> 去重后 ${mergedRealtime.total_records} 条`);
  console.log(`   文件: ${REALTIME_SOURCE.outputFile}`);

  const riskData = syncSource(RISK_SOURCE, mapOrderRecord, isDisplayableOrder);
  writeJsonAtomically(RISK_SOURCE.outputFile, RISK_SOURCE.tmpFile, riskData);
  console.log(`✅ 风险订单缓存完成: ${riskData.total_records} 条 -> ${RISK_SOURCE.outputFile}`);

  const birthdayData = syncSource(BIRTHDAY_SOURCE, mapBirthdayRecord, isDisplayableBirthday);
  writeJsonAtomically(BIRTHDAY_SOURCE.outputFile, BIRTHDAY_SOURCE.tmpFile, birthdayData);
  console.log(`✅ 生日会员缓存完成: ${birthdayData.total_records} 条 -> ${BIRTHDAY_SOURCE.outputFile}`);

  const dutyData = syncSource(DUTY_SOURCE, mapDutyRecord, isDisplayableDuty);
  writeJsonAtomically(DUTY_SOURCE.outputFile, DUTY_SOURCE.tmpFile, dutyData);
  console.log(`✅ 值班表缓存完成: ${dutyData.total_records} 条 -> ${DUTY_SOURCE.outputFile}`);
}

main();
