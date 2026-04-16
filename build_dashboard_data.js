#!/usr/bin/env node
/**
 * 从 orders_realtime.json 生成 dashboard_data.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INPUT_FILE = path.join(ROOT, 'orders_realtime.json');
const DUTY_INPUT_FILE = path.join(ROOT, 'duty_schedule.json');
const OUTPUT_FILE = path.join(ROOT, 'dashboard_data.json');
const TMP_FILE = path.join(ROOT, 'dashboard_data.tmp.json');
const ACTIVE_EMPLOYEES = new Set(['谷佳', '雅琴', '黄蓉']);
const WINDOW_DAYS = 14;
const RETURN_RATE_WINDOW_DAYS = 21;
const RETURN_RATE_LAG_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomically(targetPath, tmpPath, content) {
  fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2));
  fs.renameSync(tmpPath, targetPath);
}

function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  const cleaned = String(value).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const result = Number(cleaned);
  return Number.isNaN(result) ? null : result;
}

function text(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const normalized = raw.replace(/\//g, '-').replace('T', ' ').slice(0, 19);
  const candidate = normalized.length === 10 ? `${normalized} 00:00:00` : normalized;
  const date = new Date(candidate.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function eventDate(record) {
  return parseDate(record.pay_date) || parseDate(record.order_date) || parseDate(record.ship_date);
}

function isExcludedPlatform(record) {
  const platform = text(record.platform);
  return platform === '样品' || platform === '代发';
}

function isActiveEmployee(record) {
  const employee = text(record.employee);
  return !!employee && ACTIVE_EMPLOYEES.has(employee);
}

function isReturn(record) {
  const refundType = text(record.refund_type);
  const returnStatus = text(record.return_status);
  const refundReason = text(record.refund_reason);
  const status = text(record.status);
  const refundAmount = toNumber(record.refund_amount) || 0;

  if (refundAmount > 0) return true;
  if (refundType && refundType !== '0' && refundType !== '正常') return true;

  const combined = [returnStatus, refundReason, status].filter(Boolean).join(' ');
  return /(退|换|取消|拒收)/.test(combined) && !/正常/.test(combined);
}

function revenueValue(record) {
  return toNumber(record.revenue) ?? toNumber(record.pay_amount) ?? toNumber(record.net_revenue) ?? 0;
}

function costValue(record) {
  return toNumber(record.cost) ?? 0;
}

function profitValue(record) {
  const explicitProfit = toNumber(record.profit);
  if (explicitProfit != null) return explicitProfit;
  const revenue = toNumber(record.revenue);
  const cost = toNumber(record.cost);
  if (revenue != null && cost != null) return revenue - cost;
  return 0;
}

function getLatestDate(records, syncedAt) {
  const dates = records.map(eventDate).filter(Boolean);
  const latest = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : new Date(syncedAt || Date.now());
  latest.setHours(0, 0, 0, 0);
  return latest;
}

function buildTrailingWindow(endDate, days) {
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  return { start, end };
}

function buildReturnRateWindow(latestDate) {
  if (latestDate.getDate() <= RETURN_RATE_LAG_DAYS) {
    const previousMonthEnd = new Date(latestDate.getFullYear(), latestDate.getMonth(), 0);
    previousMonthEnd.setHours(0, 0, 0, 0);
    const previousMonthStart = new Date(previousMonthEnd.getFullYear(), previousMonthEnd.getMonth(), 1);
    return { start: previousMonthStart, end: previousMonthEnd, mode: 'previous_month_full' };
  }

  const lagEnd = new Date(latestDate.getTime() - RETURN_RATE_LAG_DAYS * DAY_MS);
  lagEnd.setHours(0, 0, 0, 0);
  return { ...buildTrailingWindow(lagEnd, RETURN_RATE_WINDOW_DAYS), mode: 'lagged_recent' };
}

function isInWindow(date, window) {
  if (!date || !window) return false;
  const t = date.getTime();
  return t >= window.start.getTime() && t <= window.end.getTime();
}

function getDutyDayMap(source, window) {
  const rawRecords = Array.isArray(source?.records) ? source.records : [];
  const dutyDays = new Map();

  for (const record of rawRecords) {
    const employee = text(record.employee);
    const shift = text(record.shift);
    if (!employee || !ACTIVE_EMPLOYEES.has(employee)) continue;
    if (shift === '休假') continue;

    const date = parseDate(record.duty_date);
    if (!date) continue;

    const effectiveDate = shift === '晚班'
      ? new Date(date.getTime() + DAY_MS)
      : date;
    effectiveDate.setHours(0, 0, 0, 0);

    if (!isInWindow(effectiveDate, window)) continue;

    const dateKey = toDateKey(effectiveDate);
    if (!dutyDays.has(employee)) dutyDays.set(employee, new Set());
    dutyDays.get(employee).add(dateKey);
  }

  return dutyDays;
}

function ensureStat(map, key, seed) {
  if (!map.has(key)) map.set(key, { ...seed });
  return map.get(key);
}

function monthKey(date) {
  return toDateKey(date).slice(0, 7);
}

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`);
  }
  if (!fs.existsSync(DUTY_INPUT_FILE)) {
    throw new Error(`Input file not found: ${DUTY_INPUT_FILE}`);
  }

  const source = readJson(INPUT_FILE);
  const dutySource = readJson(DUTY_INPUT_FILE);
  const rawRecords = Array.isArray(source.records) ? source.records : [];
  const records = rawRecords.filter(record => !isExcludedPlatform(record) && isActiveEmployee(record));
  const latestDate = getLatestDate(records, source.synced_at);
  const recentWindow = buildTrailingWindow(latestDate, WINDOW_DAYS);
  const returnRateWindow = buildReturnRateWindow(latestDate);
  const dutyDayMap = getDutyDayMap(dutySource, recentWindow);

  const skuStats = new Map();
  const skuRateStats = new Map();
  const employeeStats = new Map();
  const employeeRateStats = new Map();
  const factoryStats = new Map();
  const factoryRateStats = new Map();
  const dailyStats = new Map();
  const monthlyStats = new Map();
  const inPeriodRecords = [];
  const laggedSummary = { orders: 0, returns: 0 };

  for (let cursor = new Date(recentWindow.start); cursor <= recentWindow.end; cursor = new Date(cursor.getTime() + DAY_MS)) {
    dailyStats.set(toDateKey(cursor), { revenue: 0, orders: 0, returns: 0 });
  }

  for (const record of records) {
    const date = eventDate(record);
    if (!date) continue;

    const revenue = revenueValue(record);
    const cost = costValue(record);
    const profit = profitValue(record);
    const returned = isReturn(record);
    const skuName = text(record.sku_name);
    const employee = text(record.employee);
    const factory = text(record.factory) || '未知';
    const skuKey = `${skuName || '未知'}__${factory}`;

    const monthStat = ensureStat(monthlyStats, monthKey(date), { orders: 0, revenue: 0, returns: 0, profit: 0 });
    monthStat.orders += 1;
    monthStat.revenue += revenue;
    monthStat.profit += profit;
    if (returned) monthStat.returns += 1;

    if (isInWindow(date, recentWindow)) {
      inPeriodRecords.push(record);

      const dayStat = dailyStats.get(toDateKey(date));
      if (dayStat) {
        dayStat.orders += 1;
        dayStat.revenue += revenue;
        if (returned) dayStat.returns += 1;
      }

      if (skuName) {
        const current = ensureStat(skuStats, skuKey, { key: skuKey, name: skuName, factory, orders: 0, revenue: 0, cost: 0, profit: 0 });
        current.orders += 1;
        current.revenue += revenue;
        current.cost += cost;
        current.profit += profit;
      }

      if (employee) {
        const current = ensureStat(employeeStats, employee, { name: employee, orders: 0, revenue: 0, returns: 0 });
        current.orders += 1;
        current.revenue += revenue;
        if (returned) current.returns += 1;
      }

      const factoryCurrent = ensureStat(factoryStats, factory, { name: factory, orders: 0, revenue: 0, profit: 0, returns: 0 });
      factoryCurrent.orders += 1;
      factoryCurrent.revenue += revenue;
      factoryCurrent.profit += profit;
      if (returned) factoryCurrent.returns += 1;
    }

    if (isInWindow(date, returnRateWindow)) {
      laggedSummary.orders += 1;
      if (returned) laggedSummary.returns += 1;

      if (skuName) {
        const current = ensureStat(skuRateStats, skuKey, { key: skuKey, name: skuName, factory, orders: 0, returns: 0 });
        current.orders += 1;
        if (returned) current.returns += 1;
      }

      if (employee) {
        const current = ensureStat(employeeRateStats, employee, { name: employee, orders: 0, returns: 0 });
        current.orders += 1;
        if (returned) current.returns += 1;
      }

      const factoryCurrent = ensureStat(factoryRateStats, factory, { name: factory, orders: 0, returns: 0 });
      factoryCurrent.orders += 1;
      if (returned) factoryCurrent.returns += 1;
    }
  }

  const topSkus = Array.from(skuStats.values())
    .map(item => {
      const rateStat = skuRateStats.get(item.key) || { orders: 0, returns: 0 };
      const returnRate = rateStat.orders > 0 ? rateStat.returns / rateStat.orders : 0;
      const profitMargin = item.revenue > 0 ? item.profit / item.revenue : 0;
      const score = item.revenue * (1 - returnRate) + Math.max(item.profit, 0);
      return {
        name: item.name,
        orders: item.orders,
        revenue: Math.round(item.revenue),
        cost: Math.round(item.cost),
        profit: Math.round(item.profit),
        return_rate: Number((returnRate * 100).toFixed(1)),
        profit_margin: Number((profitMargin * 100).toFixed(1)),
        factory: item.factory,
        score: Number(score.toFixed(2)),
      };
    })
    .filter(item => item.orders >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  const returnAlerts = Array.from(skuRateStats.values())
    .filter(item => item.returns > 0 && item.orders >= 2)
    .map(item => ({
      name: item.name,
      returns_30d: item.returns,
      total_orders: item.orders,
      return_rate: Number(((item.returns / item.orders) * 100).toFixed(1)),
      factory: item.factory,
    }))
    .sort((a, b) => b.returns_30d - a.returns_30d || b.return_rate - a.return_rate)
    .slice(0, 20);

  const dailyTrend = Array.from(dailyStats.entries()).map(([date, stat]) => ({
    date,
    revenue: Math.round(stat.revenue),
    orders: stat.orders,
    returns: stat.returns,
  }));

  const employees = Array.from(employeeStats.values())
    .map(item => {
      const rateStat = employeeRateStats.get(item.name) || { orders: 0, returns: 0 };
      const returnRate = rateStat.orders > 0 ? (rateStat.returns / rateStat.orders) * 100 : 0;
      const dutyDays = dutyDayMap.get(item.name)?.size || 0;
      const avgDailyOrders = dutyDays > 0 ? Number((item.orders / dutyDays).toFixed(1)) : null;
      return {
        name: item.name,
        orders: item.orders,
        revenue: Math.round(item.revenue),
        returns: item.returns,
        duty_days: dutyDays,
        avg_daily_orders: avgDailyOrders,
        return_rate: Number(returnRate.toFixed(1)),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const factories = Array.from(factoryStats.values())
    .map(item => {
      const rateStat = factoryRateStats.get(item.name) || { orders: 0, returns: 0 };
      const returnRate = rateStat.orders > 0 ? (rateStat.returns / rateStat.orders) * 100 : 0;
      return {
        name: item.name,
        orders: item.orders,
        revenue: Math.round(item.revenue),
        returns: item.returns,
        return_rate: Number(returnRate.toFixed(1)),
        profit: Math.round(item.profit),
      };
    })
    .sort((a, b) => b.return_rate - a.return_rate || b.orders - a.orders);

  const summary = dailyTrend.reduce(
    (acc, day) => {
      acc.total_orders += day.orders;
      acc.total_revenue += day.revenue;
      acc.total_returns += day.returns;
      return acc;
    },
    { total_orders: 0, total_revenue: 0, total_returns: 0, lagged_return_rate: 0 }
  );
  summary.lagged_return_rate = laggedSummary.orders > 0
    ? Number(((laggedSummary.returns / laggedSummary.orders) * 100).toFixed(1))
    : 0;

  const filteredRiskFactories = factories.filter(item => item.return_rate >= 10 && item.orders >= 3 && item.returns >= 1);
  const filteredRiskEmployees = employees.filter(item => item.return_rate >= 10 && item.orders >= 5 && item.returns >= 1);

  const riskSummary = {
    high_return_sku_count: returnAlerts.length,
    high_return_factory_count: filteredRiskFactories.length,
    returning_orders_30d: summary.total_returns,
    high_return_employee_count: filteredRiskEmployees.length,
    top_risk_skus: returnAlerts.slice(0, 3),
    top_risk_factories: filteredRiskFactories.slice(0, 3),
    top_risk_employees: filteredRiskEmployees.slice(0, 3),
  };

  const currentMonthKey = monthKey(latestDate);
  const previousMonthDate = new Date(latestDate.getFullYear(), latestDate.getMonth(), 0);
  const previousMonthKey = monthKey(previousMonthDate);

  const currentMonthBase = monthlyStats.get(currentMonthKey) || { orders: 0, revenue: 0, returns: 0, profit: 0 };
  const previousMonthBase = monthlyStats.get(previousMonthKey) || { orders: 0, revenue: 0, returns: 0, profit: 0 };

  let currentMonthRateOrders = 0;
  let currentMonthRateReturns = 0;
  if (latestDate.getDate() <= RETURN_RATE_LAG_DAYS) {
    currentMonthRateOrders = previousMonthBase.orders;
    currentMonthRateReturns = previousMonthBase.returns;
  } else {
    const cutoff = new Date(latestDate.getTime() - RETURN_RATE_LAG_DAYS * DAY_MS);
    cutoff.setHours(0, 0, 0, 0);
    for (const record of records) {
      const date = eventDate(record);
      if (!date) continue;
      if (monthKey(date) !== currentMonthKey) continue;
      if (date.getTime() > cutoff.getTime()) continue;
      currentMonthRateOrders += 1;
      if (isReturn(record)) currentMonthRateReturns += 1;
    }
  }

  const currentMonth = {
    month: currentMonthKey,
    orders: currentMonthBase.orders,
    revenue: Math.round(currentMonthBase.revenue),
    returns: currentMonthBase.returns,
    profit: Math.round(currentMonthBase.profit),
    return_rate: currentMonthRateOrders > 0 ? Number(((currentMonthRateReturns / currentMonthRateOrders) * 100).toFixed(1)) : 0,
    profit_margin: currentMonthBase.revenue > 0 ? Number(((currentMonthBase.profit / currentMonthBase.revenue) * 100).toFixed(1)) : 0,
  };

  const previousMonth = {
    month: previousMonthKey,
    orders: previousMonthBase.orders,
    revenue: Math.round(previousMonthBase.revenue),
    returns: previousMonthBase.returns,
    profit: Math.round(previousMonthBase.profit),
    return_rate: previousMonthBase.orders > 0 ? Number(((previousMonthBase.returns / previousMonthBase.orders) * 100).toFixed(1)) : 0,
    profit_margin: previousMonthBase.revenue > 0 ? Number(((previousMonthBase.profit / previousMonthBase.revenue) * 100).toFixed(1)) : 0,
  };

  const result = {
    generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    source_synced_at: source.synced_at,
    total_records: source.total_records,
    period: {
      start: toDateKey(recentWindow.start),
      end: toDateKey(recentWindow.end),
    },
    window_days: WINDOW_DAYS,
    return_rate_lag_days: RETURN_RATE_LAG_DAYS,
    summary_30d: summary,
    top_skus: topSkus,
    return_alerts: returnAlerts,
    daily_trend: dailyTrend,
    employees,
    factories,
    risk_summary: riskSummary,
    overview_summary: {
      current_month: currentMonth,
      previous_month: previousMonth,
      active_customers_30d: new Set(inPeriodRecords.map(r => r.customer_name).filter(Boolean)).size,
    },
  };

  writeJsonAtomically(OUTPUT_FILE, TMP_FILE, result);

  console.log('✅ Dashboard data generated');
  console.log(`   Source records: ${source.total_records}`);
  console.log(`   ${WINDOW_DAYS}-day orders: ${summary.total_orders}`);
  console.log(`   ${WINDOW_DAYS}-day revenue: ¥${summary.total_revenue.toLocaleString('en-US')}`);
  console.log(`   Output: ${OUTPUT_FILE}`);
}

main();
