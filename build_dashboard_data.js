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
const RISK_WINDOW_DAYS = 30;
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

function isRealtimeScoped(record) {
  return record.in_realtime_view !== false;
}

function isReturn(record) {
  const refundType = text(record.refund_type);
  return !!(refundType && refundType !== '0' && refundType !== '正常' && refundType !== '取消');
}

function hasWorkflowText(value) {
  const raw = text(value);
  return !!(raw && raw !== '/' && raw !== '-' && raw !== '—');
}

function parseWorkflowDate(value) {
  if (!hasWorkflowText(value)) return null;
  const date = parseDate(value);
  if (!date) return null;
  return date.getFullYear() < 2000 ? null : date;
}

function workflowDateText(value) {
  return parseWorkflowDate(value) ? text(value) : null;
}

function isReturnWorkflowOrder(record) {
  return isReturn(record);
}

function daysSince(date, latestDate) {
  if (!date) return null;
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return Math.floor((latestDate.getTime() - normalized.getTime()) / DAY_MS);
}

function workflowAlertDate(record) {
  return parseWorkflowDate(record.refund_date) || eventDate(record);
}

function buildWorkflowAlert(record, latestDate, ageDate, extra = {}) {
  return {
    record_id: record.record_id,
    tracking_no: text(record.tracking_no),
    customer_name: text(record.customer_name),
    sku_name: text(record.sku_name),
    employee: text(record.employee),
    platform: text(record.platform),
    factory: text(record.factory) || '未知',
    refund_type: text(record.refund_type),
    pay_date: text(record.pay_date),
    return_tracking: hasWorkflowText(record.return_tracking) ? text(record.return_tracking) : null,
    send_factory_date: workflowDateText(record.send_factory_date),
    confirm_date: workflowDateText(record.confirm_date),
    refund_amount: toNumber(record.refund_amount),
    return_status: text(record.return_status),
    age_days: daysSince(ageDate, latestDate),
    ...extra,
  };
}

function isMissingReturnTracking(record) {
  return isReturnWorkflowOrder(record) && !hasWorkflowText(record.return_tracking);
}

function isPendingSendFactory(record, latestDate) {
  if (!isReturnWorkflowOrder(record)) return false;
  if (!hasWorkflowText(record.return_tracking)) return false;
  if (hasWorkflowText(record.send_factory_date)) return false;
  const ageDays = daysSince(workflowAlertDate(record), latestDate);
  return ageDays != null && ageDays > 7;
}

function getFactoryFollowupMissingFields(record) {
  const missing = [];
  if (!parseWorkflowDate(record.confirm_date)) missing.push('厂家确认日期');
  if (toNumber(record.refund_amount) == null) missing.push('厂家退回金额');
  return missing;
}

function isFactoryFollowupIncomplete(record) {
  return isReturnWorkflowOrder(record)
    && hasWorkflowText(record.send_factory_date)
    && getFactoryFollowupMissingFields(record).length > 0;
}

function summarizeWorkflowAlerts(key, title, severity, alerts) {
  return {
    key,
    title,
    severity,
    count: alerts.length,
    max_age_days: alerts[0]?.age_days ?? null,
    example: alerts[0] || null,
  };
}

function formatWorkflowDetail(alert) {
  return {
    record_id: alert.record_id,
    customer_name: alert.customer_name,
    sku_name: alert.sku_name,
    employee: alert.employee,
    platform: alert.platform,
    factory: alert.factory,
    refund_type: alert.refund_type,
    pay_date: alert.pay_date,
    tracking_no: alert.tracking_no,
    return_tracking: alert.return_tracking,
    send_factory_date: alert.send_factory_date,
    confirm_date: alert.confirm_date,
    refund_amount: alert.refund_amount,
    return_status: alert.return_status,
    age_days: alert.age_days,
    missing_fields: alert.missing_fields || [],
  };
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
  const realtimeRecords = records.filter(isRealtimeScoped);
  const latestDate = getLatestDate(records, source.synced_at);
  const recentWindow = buildTrailingWindow(latestDate, WINDOW_DAYS);
  const riskWindow = buildTrailingWindow(latestDate, RISK_WINDOW_DAYS);
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
  const missingTrackingAlerts = [];
  const pendingSendFactoryAlerts = [];
  const factoryFollowupAlerts = [];

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

    const remarkText = [text(record.remark), text(record.goods_remark)].filter(Boolean).join(' ');
    const isPromoOrder = /优惠券|生日/.test(remarkText);

    const monthStat = ensureStat(monthlyStats, monthKey(date), { orders: 0, revenue: 0, returns: 0, profit: 0, promo_orders: 0 });
    monthStat.orders += 1;
    monthStat.revenue += revenue;
    monthStat.profit += profit;
    if (returned) monthStat.returns += 1;
    if (isPromoOrder) monthStat.promo_orders += 1;

    if (isMissingReturnTracking(record)) {
      missingTrackingAlerts.push(buildWorkflowAlert(record, latestDate, workflowAlertDate(record)));
    } else if (isPendingSendFactory(record, latestDate)) {
      pendingSendFactoryAlerts.push(buildWorkflowAlert(record, latestDate, workflowAlertDate(record)));
    } else if (isFactoryFollowupIncomplete(record)) {
      const missingFields = getFactoryFollowupMissingFields(record);
      const sendFactoryDate = parseWorkflowDate(record.send_factory_date) || workflowAlertDate(record);
      factoryFollowupAlerts.push(buildWorkflowAlert(record, latestDate, sendFactoryDate, {
        missing_fields: missingFields,
        missing_both: missingFields.length >= 2,
      }));
    }

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
        const current = ensureStat(employeeStats, employee, {
          name: employee,
          orders: 0,
          revenue: 0,
          returns: 0,
          profit_margin_sum: 0,
          profit_margin_count: 0,
          monthly_promo_orders: 0,
        });
        current.orders += 1;
        current.revenue += revenue;
        if (returned) current.returns += 1;
        if (monthKey(date) === monthKey(latestDate) && isPromoOrder) {
          current.monthly_promo_orders += 1;
        }
        const rawProfitMargin = toNumber(record.profit_margin);
        if (rawProfitMargin != null) {
          current.profit_margin_sum += rawProfitMargin;
          current.profit_margin_count += 1;
        }
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
        sales_avg_profit_margin: item.profit_margin_count > 0 ? Number((item.profit_margin_sum / item.profit_margin_count * 100).toFixed(1)) : 0,
        monthly_promo_orders: item.monthly_promo_orders || 0,
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

  missingTrackingAlerts.sort((a, b) => (b.age_days || 0) - (a.age_days || 0));
  pendingSendFactoryAlerts.sort((a, b) => (b.age_days || 0) - (a.age_days || 0));
  factoryFollowupAlerts.sort((a, b) => {
    if ((a.missing_both ? 1 : 0) !== (b.missing_both ? 1 : 0)) {
      return (b.missing_both ? 1 : 0) - (a.missing_both ? 1 : 0);
    }
    return (b.age_days || 0) - (a.age_days || 0);
  });

  const topAlerts = [
    summarizeWorkflowAlerts('missing_tracking', '退货未填单号', 'danger', missingTrackingAlerts),
    summarizeWorkflowAlerts('pending_send_factory', '超7天未发厂家', 'warn', pendingSendFactoryAlerts),
    summarizeWorkflowAlerts('factory_followup_incomplete', '已发厂待跟进', 'warn', factoryFollowupAlerts),
  ].filter(item => item.count > 0);

  const riskRecords = realtimeRecords.filter(record => {
    const date = eventDate(record);
    return isInWindow(date, riskWindow);
  });
  const riskReturnRecords = riskRecords.filter(isReturnWorkflowOrder);
  const riskRecordIds = new Set(riskRecords.map(record => record.record_id));
  const filteredMissingTrackingAlerts = missingTrackingAlerts.filter(item => riskRecordIds.has(item.record_id));
  const filteredPendingSendFactoryAlerts = pendingSendFactoryAlerts.filter(item => riskRecordIds.has(item.record_id));
  const filteredFactoryFollowupAlerts = factoryFollowupAlerts.filter(item => riskRecordIds.has(item.record_id));

  const filteredTopAlerts = [
    summarizeWorkflowAlerts('missing_tracking', '退货未填单号', 'danger', filteredMissingTrackingAlerts),
    summarizeWorkflowAlerts('pending_send_factory', '超7天未发厂家', 'warn', filteredPendingSendFactoryAlerts),
    summarizeWorkflowAlerts('factory_followup_incomplete', '已发厂待跟进', 'warn', filteredFactoryFollowupAlerts),
  ].filter(item => item.count > 0);

  const riskSummary = {
    return_orders_total: riskReturnRecords.length,
    missing_tracking_count: filteredMissingTrackingAlerts.length,
    pending_send_factory_count: filteredPendingSendFactoryAlerts.length,
    factory_followup_incomplete_count: filteredFactoryFollowupAlerts.length,
    total_alert_count: filteredMissingTrackingAlerts.length + filteredPendingSendFactoryAlerts.length + filteredFactoryFollowupAlerts.length,
    top_alerts: filteredTopAlerts,
    detail_lists: {
      return_orders: riskReturnRecords.map(record => formatWorkflowDetail(buildWorkflowAlert(record, latestDate, workflowAlertDate(record)))),
      missing_tracking: filteredMissingTrackingAlerts.map(formatWorkflowDetail),
      pending_send_factory: filteredPendingSendFactoryAlerts.map(formatWorkflowDetail),
      factory_followup_incomplete: filteredFactoryFollowupAlerts.map(formatWorkflowDetail),
    },
    alert_groups: {
      missing_tracking: filteredMissingTrackingAlerts.slice(0, 20),
      pending_send_factory: filteredPendingSendFactoryAlerts.slice(0, 20),
      factory_followup_incomplete: filteredFactoryFollowupAlerts.slice(0, 20),
    },
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
    promo_orders: currentMonthBase.promo_orders || 0,
    return_rate: currentMonthRateOrders > 0 ? Number(((currentMonthRateReturns / currentMonthRateOrders) * 100).toFixed(1)) : 0,
    profit_margin: currentMonthBase.revenue > 0 ? Number(((currentMonthBase.profit / currentMonthBase.revenue) * 100).toFixed(1)) : 0,
  };

  const previousMonth = {
    month: previousMonthKey,
    orders: previousMonthBase.orders,
    revenue: Math.round(previousMonthBase.revenue),
    returns: previousMonthBase.returns,
    profit: Math.round(previousMonthBase.profit),
    promo_orders: previousMonthBase.promo_orders || 0,
    return_rate: previousMonthBase.orders > 0 ? Number(((previousMonthBase.returns / previousMonthBase.orders) * 100).toFixed(1)) : 0,
    profit_margin: previousMonthBase.revenue > 0 ? Number(((previousMonthBase.profit / previousMonthBase.revenue) * 100).toFixed(1)) : 0,
  };

  const teamSummary = {
    profit_margin_all_orders: employees.reduce((sum, item) => sum + (item.revenue_all_orders || 0), 0) > 0
      ? Number((employees.reduce((sum, item) => sum + (item.profit_all_orders || 0), 0) / employees.reduce((sum, item) => sum + (item.revenue_all_orders || 0), 0) * 100).toFixed(1))
      : 0,
    profit_margin_cost_present_only: employees.reduce((sum, item) => sum + (item.revenue_with_cost || 0), 0) > 0
      ? Number((employees.reduce((sum, item) => sum + (item.profit_with_cost || 0), 0) / employees.reduce((sum, item) => sum + (item.revenue_with_cost || 0), 0) * 100).toFixed(1))
      : 0,
    orders_with_cost: employees.reduce((sum, item) => sum + (item.orders_with_cost || 0), 0),
    total_orders: employees.reduce((sum, item) => sum + (item.orders || 0), 0),
    current_month_promo_orders: currentMonthBase.promo_orders || 0,
    previous_month_promo_orders: previousMonthBase.promo_orders || 0,
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
    team_summary: teamSummary,
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
