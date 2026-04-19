#!/usr/bin/env node
/**
 * 从 orders_realtime.json 生成 customer_action_data.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INPUT_FILE = path.join(ROOT, 'orders_realtime.json');
const BIRTHDAY_FILE = path.join(ROOT, 'birthday_members.json');
const OUTPUT_FILE = path.join(ROOT, 'customer_action_data.json');
const TMP_FILE = path.join(ROOT, 'customer_action_data.tmp.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_WINDOW_DAYS = 14;
const RETURN_RATE_WINDOW_DAYS = 21;
const RETURN_RATE_LAG_DAYS = 7;
const HISTORY_DAYS = 180;
const BIRTHDAY_NEAR_DAYS = 7;
const ACTIVE_EMPLOYEES = new Set(['谷佳', '雅琴', '黄蓉']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomically(targetPath, tmpPath, content) {
  fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2));
  fs.renameSync(tmpPath, targetPath);
}

function text(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function normalizePhone(value) {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}

function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  const cleaned = String(value).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const result = Number(cleaned);
  return Number.isNaN(result) ? null : result;
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const normalized = raw.replace(/\//g, '-').replace('T', ' ').slice(0, 19);
  const candidate = normalized.length === 10 ? `${normalized} 00:00:00` : normalized;
  const date = new Date(candidate.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseBirthdayDay(value) {
  const raw = text(value);
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 10000) {
    const base = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(base.getTime() + num * DAY_MS);
    return { month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
  const date = parseDate(raw);
  if (!date) return null;
  return { month: date.getMonth() + 1, day: date.getDate() };
}

function formatMonthDay(info) {
  if (!info) return null;
  return `${String(info.month).padStart(2, '0')}-${String(info.day).padStart(2, '0')}`;
}

function daysUntilBirthday(info, fromDate) {
  if (!info) return null;
  const currentYear = fromDate.getFullYear();
  let birthday = new Date(currentYear, info.month - 1, info.day);
  birthday.setHours(0, 0, 0, 0);
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);
  if (birthday.getTime() < base.getTime()) {
    birthday = new Date(currentYear + 1, info.month - 1, info.day);
    birthday.setHours(0, 0, 0, 0);
  }
  return Math.round((birthday.getTime() - base.getTime()) / DAY_MS);
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

function revenueValue(record) {
  return toNumber(record.revenue) ?? toNumber(record.pay_amount) ?? toNumber(record.net_revenue) ?? 0;
}

function isReturn(record) {
  const refundType = text(record.refund_type);
  return !!(refundType && refundType !== '0' && refundType !== '正常' && refundType !== '取消');
}

function customerKey(record) {
  const phone = normalizePhone(record.phone);
  if (phone) return `phone:${phone}`;
  return `name:${text(record.customer_name) || 'unknown'}|emp:${text(record.employee) || 'unknown'}`;
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

function buildLaggedWindow(latestDate) {
  if (latestDate.getDate() <= RETURN_RATE_LAG_DAYS) {
    const previousMonthEnd = new Date(latestDate.getFullYear(), latestDate.getMonth(), 0);
    previousMonthEnd.setHours(0, 0, 0, 0);
    const previousMonthStart = new Date(previousMonthEnd.getFullYear(), previousMonthEnd.getMonth(), 1);
    return { start: previousMonthStart, end: previousMonthEnd };
  }
  const lagEnd = new Date(latestDate.getTime() - RETURN_RATE_LAG_DAYS * DAY_MS);
  lagEnd.setHours(0, 0, 0, 0);
  return buildTrailingWindow(lagEnd, RETURN_RATE_WINDOW_DAYS);
}

function isInWindow(date, window) {
  if (!date || !window) return false;
  const t = date.getTime();
  return t >= window.start.getTime() && t <= window.end.getTime();
}

function detectCategory(textValue) {
  const value = String(textValue || '').toLowerCase();
  if (!value) return null;
  const rules = [
    ['包', ['包', '双肩包', '腋下包', '机车包', '托特', '斜挎']],
    ['帽', ['帽', '冷帽', '棒球帽', '渔夫帽']],
    ['鞋', ['鞋', '德训', '板鞋', '跑鞋', '芭蕾', '洞洞鞋', '萨洛蒙', 'ugg', 'nb']],
    ['上衣', ['卫衣', '短袖', '长袖', '上衣', '衬衫', '背心', '开衫', '针织', 't恤']],
    ['外套', ['外套', '夹克', '冲锋衣', '羽绒', '马甲']],
    ['裙', ['裙', '连衣裙', '蛋糕裙']],
    ['裤', ['裤', '牛仔裤', '短裤', '长裤']],
  ];
  for (const [label, keywords] of rules) {
    if (keywords.some(keyword => value.includes(keyword.toLowerCase()))) return label;
  }
  return null;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Number((sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)).toFixed(1));
}

function cadenceBucket(platform, medianGap) {
  if (platform === '咸鱼' || platform === '咸鱼二' || platform === '小A奥莱') return '快节奏';
  if (platform === '四店' || platform === '相册') return '中节奏';
  if (medianGap != null && medianGap <= 14) return '快节奏';
  if (medianGap != null && medianGap <= 45) return '中节奏';
  return '慢节奏';
}

function percentileOrNull(values, p) {
  if (!values.length) return null;
  return percentile(values, p);
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function dynamicTimingWindow(uniqueOrderDays, repeatIntervals, daysSinceLastOrder) {
  const repeatCount = repeatIntervals.length;
  const intervalP25 = percentileOrNull(repeatIntervals, 0.25);
  const intervalMedian = percentileOrNull(repeatIntervals, 0.5);
  const intervalP75 = percentileOrNull(repeatIntervals, 0.75);
  const recentIntervals = repeatIntervals.slice(-2);
  const recentIntervalAvg = average(recentIntervals);
  const trendBase = intervalMedian || recentIntervalAvg || null;
  const rawTrendRatio = trendBase && recentIntervalAvg ? recentIntervalAvg / trendBase : 1;
  const trendRatio = Number(Math.min(1.25, Math.max(0.8, rawTrendRatio || 1)).toFixed(2));

  let expectedGapDays;
  let windowStart;
  let windowEnd;
  let dormantAfter;
  let cadenceSource;

  if (uniqueOrderDays >= 3 && intervalMedian != null) {
    expectedGapDays = Math.max(3, Math.round(intervalMedian * trendRatio));
    windowStart = Math.max(3, Math.round(expectedGapDays * 0.8));
    windowEnd = Math.max(windowStart + 1, Math.round(expectedGapDays * 1.25));
    dormantAfter = Math.max(45, Math.round(Math.max(intervalP75 || 0, expectedGapDays * 2)));
    cadenceSource = 'history_rich';
  } else if (uniqueOrderDays === 2 && intervalMedian != null) {
    expectedGapDays = Math.max(3, Math.round(intervalMedian));
    windowStart = Math.max(3, Math.round(expectedGapDays * 0.85));
    windowEnd = Math.max(windowStart + 1, Math.round(expectedGapDays * 1.35));
    dormantAfter = Math.max(45, Math.round(expectedGapDays * 2));
    cadenceSource = 'history_light';
  } else {
    expectedGapDays = 21;
    windowStart = 10;
    windowEnd = 28;
    dormantAfter = 75;
    cadenceSource = 'cohort_fallback';
  }

  let windowState = 'unknown';
  let windowStatus = '未知';
  if (daysSinceLastOrder != null) {
    if (daysSinceLastOrder < windowStart) {
      windowState = 'cooldown';
      windowStatus = '冷却期';
    } else if (daysSinceLastOrder <= windowEnd) {
      windowState = 'ready';
      windowStatus = '可触达';
    } else if (daysSinceLastOrder < dormantAfter) {
      windowState = 'late';
      windowStatus = '已超窗';
    } else {
      windowState = 'dormant';
      windowStatus = '沉睡';
    }
  }

  const dueRatio = expectedGapDays > 0 && daysSinceLastOrder != null
    ? Number((daysSinceLastOrder / expectedGapDays).toFixed(2))
    : null;

  return {
    repeat_count: repeatCount,
    unique_order_days: uniqueOrderDays,
    interval_p25: intervalP25,
    interval_median: intervalMedian,
    interval_p75: intervalP75,
    recent_interval_avg: recentIntervalAvg,
    trend_ratio: trendRatio,
    expected_gap_days: expectedGapDays,
    window_start: windowStart,
    window_end: windowEnd,
    dormant_after: dormantAfter,
    due_ratio: dueRatio,
    cadence_source: cadenceSource,
    window_state: windowState,
    window_status: windowStatus,
  };
}

function loadBirthdayMap(latestDate) {
  if (!fs.existsSync(BIRTHDAY_FILE)) return new Map();
  const source = readJson(BIRTHDAY_FILE);
  const records = Array.isArray(source.records) ? source.records : [];
  const byPhone = new Map();
  const byNameShop = new Map();

  for (const record of records) {
    const normalized = {
      member_name: text(record.member_name),
      member_phone: normalizePhone(record.member_phone),
      member_shop: text(record.member_shop),
      birthday_info: parseBirthdayDay(record.member_birthday),
      preferred_style: text(record.preferred_style),
      expected_gift: text(record.expected_gift),
      wechat: text(record.wechat),
      filled_at: parseDate(record.filled_at),
    };
    normalized.birthday_month_day = formatMonthDay(normalized.birthday_info);
    normalized.birthday_days_until = daysUntilBirthday(normalized.birthday_info, latestDate);
    normalized.birthday_is_near = normalized.birthday_days_until != null && normalized.birthday_days_until <= BIRTHDAY_NEAR_DAYS;

    if (normalized.member_phone) {
      const current = byPhone.get(normalized.member_phone);
      if (!current || ((normalized.filled_at?.getTime() || 0) > (current.filled_at?.getTime() || 0))) {
        byPhone.set(normalized.member_phone, normalized);
      }
    }

    if (normalized.member_name && normalized.member_shop) {
      const key = `${normalized.member_name}__${normalized.member_shop}`;
      const current = byNameShop.get(key);
      if (!current || ((normalized.filled_at?.getTime() || 0) > (current.filled_at?.getTime() || 0))) {
        byNameShop.set(key, normalized);
      }
    }
  }

  return { byPhone, byNameShop, synced_at: source.synced_at || null };
}

function styleTagsFromBirthday(record) {
  return String(record?.preferred_style || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function recommendationConfidence(pairCount, conversionRate, sourceHitCount) {
  if (pairCount >= 8 && conversionRate >= 0.25) return 'high';
  if (pairCount >= 4 && conversionRate >= 0.15) return 'medium';
  if (sourceHitCount >= 2 && pairCount >= 3) return 'medium';
  return 'low';
}

function recommendationReason(candidate) {
  const sourceLabel = (candidate.source_skus || []).join('、');
  const bestRatio = candidate.best_source_total > 0 ? `${candidate.best_pair_count}/${candidate.best_source_total}` : `${candidate.best_pair_count}`;
  if ((candidate.reason_tags || []).includes('多源命中') && sourceLabel) {
    return `${sourceLabel} 的买家都常连带买 ${candidate.sku}`;
  }
  if ((candidate.reason_tags || []).includes('同日常搭配') && sourceLabel) {
    return `${sourceLabel} 和 ${candidate.sku} 经常同日一起买（${candidate.same_day_count} 单）`;
  }
  if (sourceLabel) {
    return `买过 ${sourceLabel} 的客户里，有 ${bestRatio} 也买过 ${candidate.sku}`;
  }
  return `${candidate.sku} 在相似客户里共购频率较高，可作为主推候选`;
}

function buildPitchDirection(actionType, strikeStatus, primaryRecommendation, topOwnedSkus, birthdayNear) {
  if (!primaryRecommendation) return '暂无明确主推款，可先按客户最近成交款延续沟通。';
  const sourceText = topOwnedSkus[0] ? `可从“上次拿的 ${topOwnedSkus[0]}”切入，` : '';
  const birthdayText = birthdayNear ? '并顺带带生日权益话术，' : '';
  if (actionType === 'must_follow_today' || actionType === 'upsell') {
    return `${sourceText}${birthdayText}优先主推 ${primaryRecommendation.sku}，再带出共购备选款。`;
  }
  if (strikeStatus === '召回期') {
    return `${sourceText}${birthdayText}先轻触达，再试探主推 ${primaryRecommendation.sku}。`;
  }
  return `${sourceText}${birthdayText}先建立兴趣，再顺势推荐 ${primaryRecommendation.sku}。`;
}

function getCustomerSkuKeys(profile) {
  return Array.from(profile.skuCounter.keys()).filter(Boolean);
}

function buildSkuCoBuyMap(customers) {
  const sourceCustomerCounts = new Map();
  const relationMap = new Map();

  for (const profile of customers.values()) {
    const ownedSkuKeys = getCustomerSkuKeys(profile);
    const uniqueSkuKeys = Array.from(new Set(ownedSkuKeys));
    const sameDayPairs = new Set();
    const ordersByDate = new Map();

    for (const order of profile.recent_orders) {
      const sku = text(order.sku);
      if (!sku) continue;
      const key = `${sku}__${text(order.factory) || '未知'}`;
      if (!ordersByDate.has(order.date_key)) ordersByDate.set(order.date_key, new Set());
      ordersByDate.get(order.date_key).add(key);
    }

    for (const skuKey of uniqueSkuKeys) {
      sourceCustomerCounts.set(skuKey, (sourceCustomerCounts.get(skuKey) || 0) + 1);
    }

    for (const skuSet of ordersByDate.values()) {
      const items = Array.from(skuSet);
      for (const sourceKey of items) {
        for (const targetKey of items) {
          if (sourceKey === targetKey) continue;
          sameDayPairs.add(`${sourceKey}=>${targetKey}`);
        }
      }
    }

    for (const sourceKey of uniqueSkuKeys) {
      if (!relationMap.has(sourceKey)) relationMap.set(sourceKey, new Map());
      const targets = relationMap.get(sourceKey);
      for (const targetKey of uniqueSkuKeys) {
        if (sourceKey === targetKey) continue;
        const current = targets.get(targetKey) || { pairCount: 0, sameDayCount: 0 };
        current.pairCount += 1;
        if (sameDayPairs.has(`${sourceKey}=>${targetKey}`)) current.sameDayCount += 1;
        targets.set(targetKey, current);
      }
    }
  }

  return { sourceCustomerCounts, relationMap };
}

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`);
  }

  const source = readJson(INPUT_FILE);
  const rawRecords = Array.isArray(source.records) ? source.records : [];
  const records = rawRecords.filter(record => !isExcludedPlatform(record) && (record.customer_name || record.phone));
  const now = new Date();
  const latestDate = getLatestDate(records, source.synced_at);
  const recentWindow = buildTrailingWindow(latestDate, ACTION_WINDOW_DAYS);
  const laggedReturnWindow = buildLaggedWindow(latestDate);
  const birthdaySource = loadBirthdayMap(latestDate);
  const customers = new Map();
  const skuRecentStats = new Map();
  const skuRateStats = new Map();

  for (const record of records) {
    const date = eventDate(record);
    if (!date) continue;

    const revenue = revenueValue(record);
    const returned = isReturn(record);
    const skuName = text(record.sku_name);
    const factory = text(record.factory) || '未知';
    const skuKey = `${skuName || '未知'}__${factory}`;
    const key = customerKey(record);

    if (skuName && isInWindow(date, recentWindow)) {
      const sku = skuRecentStats.get(skuKey) || { key: skuKey, name: skuName, factory, platform: text(record.platform), orders: 0, revenue: 0 };
      sku.orders += 1;
      sku.revenue += revenue;
      skuRecentStats.set(skuKey, sku);
    }

    if (skuName && isInWindow(date, laggedReturnWindow)) {
      const sku = skuRateStats.get(skuKey) || { key: skuKey, orders: 0, returns: 0 };
      sku.orders += 1;
      if (returned) sku.returns += 1;
      skuRateStats.set(skuKey, sku);
    }

    const profile = customers.get(key) || {
      customer_key: key,
      customer_name: text(record.customer_name),
      phone: normalizePhone(record.phone),
      employee: text(record.employee),
      platform: text(record.platform),
      all_employees: new Set(text(record.employee) ? [text(record.employee)] : []),
      last_order_date: null,
      last_order_platform: null,
      last_order_sku: null,
      last_order_tracking_no: null,
      recent_orders: [],
      unique_order_days: new Set(),
      orders_14d: 0,
      orders_180d: 0,
      revenue_180d: 0,
      orders_365d: 0,
      revenue_365d: 0,
      orders_all: 0,
      revenue_all: 0,
      return_orders_14d: 0,
      return_orders_180d: 0,
      skuCounter: new Map(),
    };

    if (text(record.employee)) {
      profile.all_employees.add(text(record.employee));
    }

    if (!profile.last_order_date || date > profile.last_order_date) {
      profile.last_order_date = date;
      profile.last_order_platform = text(record.platform);
      profile.last_order_sku = text(record.sku_name);
      profile.last_order_tracking_no = text(record.tracking_no);
      profile.employee = text(record.employee) || profile.employee;
      profile.platform = text(record.platform) || profile.platform;
      profile.customer_name = text(record.customer_name) || profile.customer_name;
      profile.phone = normalizePhone(record.phone) || profile.phone;
    }

    profile.recent_orders.push({
      date,
      date_key: toDateKey(date),
      platform: text(record.platform),
      sku: text(record.sku_name),
      factory,
      tracking_no: text(record.tracking_no),
    });
    profile.unique_order_days.add(toDateKey(date));

    const diffDays = Math.floor((now - date) / DAY_MS);
    profile.orders_all += 1;
    profile.revenue_all += revenue;
    if (diffDays <= HISTORY_DAYS) {
      profile.orders_180d += 1;
      profile.revenue_180d += revenue;
      if (returned) profile.return_orders_180d += 1;
    }
    if (diffDays <= 365) {
      profile.orders_365d += 1;
      profile.revenue_365d += revenue;
    }
    if (isInWindow(date, recentWindow)) {
      profile.orders_14d += 1;
    }
    if (isInWindow(date, laggedReturnWindow) && returned) {
      profile.return_orders_14d += 1;
    }

    if (skuName) {
      profile.skuCounter.set(skuKey, (profile.skuCounter.get(skuKey) || 0) + 1);
    }

    customers.set(key, profile);
  }

  const { sourceCustomerCounts, relationMap } = buildSkuCoBuyMap(customers);

  const qualifiedSkus = Array.from(skuRecentStats.values())
    .map(item => {
      const rateStat = skuRateStats.get(item.key) || { orders: 0, returns: 0 };
      return {
        key: item.key,
        name: item.name,
        factory: item.factory,
        platform: item.platform,
        orders: item.orders,
        revenue: item.revenue,
        returnRate: rateStat.orders > 0 ? rateStat.returns / rateStat.orders : 0,
      };
    })
    .filter(item => item.orders >= 2 && item.returnRate <= 0.15 && item.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  const qualifiedSkuMap = new Map(qualifiedSkus.map(item => [item.key, item]));

  const outputCustomers = Array.from(customers.values())
    .map(profile => {
      const lastDate = profile.last_order_date;
      const daysSinceLastOrder = lastDate ? Math.floor((now - lastDate) / DAY_MS) : null;
      const returnRate180 = profile.orders_180d > 0 ? profile.return_orders_180d / profile.orders_180d : 0;
      const uniqueDays = Array.from(profile.unique_order_days).sort();
      const repeatIntervals = [];
      for (let i = 1; i < uniqueDays.length; i++) {
        const a = new Date(`${uniqueDays[i - 1]}T00:00:00`);
        const b = new Date(`${uniqueDays[i]}T00:00:00`);
        repeatIntervals.push(Math.round((b - a) / DAY_MS));
      }
      const repeatMedianGap = percentile(repeatIntervals, 0.5);
      const timing = dynamicTimingWindow(uniqueDays.length, repeatIntervals, daysSinceLastOrder);
      const cadence = cadenceBucket(profile.last_order_platform || profile.platform, timing.expected_gap_days || repeatMedianGap);
      const strikeStatus = timing.window_status;
      const isHighValue = profile.revenue_180d >= 2000;
      const hasReturnsPressure = profile.return_orders_14d >= 2 || returnRate180 > 0.35;

      const birthdayByPhone = profile.phone ? birthdaySource.byPhone.get(profile.phone) : null;
      const birthdayByNameShop = (!birthdayByPhone && profile.customer_name && profile.platform)
        ? birthdaySource.byNameShop.get(`${profile.customer_name}__芋圆奥莱${profile.platform}`) || birthdaySource.byNameShop.get(`${profile.customer_name}__${profile.platform}`)
        : null;
      const birthday = birthdayByPhone || birthdayByNameShop || null;
      const birthdayConfidence = birthdayByPhone ? 'high' : birthdayByNameShop ? 'low' : 'none';
      const birthdayStyleTags = styleTagsFromBirthday(birthday);
      const birthdayCategories = new Set(birthdayStyleTags.map(tag => detectCategory(tag)).filter(Boolean));
      const birthdayNear = !!birthday?.birthday_is_near;

      let score = 0;
      if (timing.window_state === 'ready') score += 30;
      else if (timing.window_state === 'late') score += 18;
      else if (timing.window_state === 'cooldown') score -= 25;
      else if (timing.window_state === 'dormant') score += 6;

      if (profile.orders_14d >= 3) score += 18;
      else if (profile.orders_14d >= 2) score += 12;
      else if (profile.orders_14d >= 1) score += 6;

      if (profile.orders_180d >= 10) score += 16;
      else if (profile.orders_180d >= 5) score += 12;
      else if (profile.orders_180d >= 3) score += 8;
      else if (profile.orders_180d >= 2) score += 4;

      if (profile.revenue_180d >= 5000) score += 24;
      else if (profile.revenue_180d >= 3000) score += 18;
      else if (profile.revenue_180d >= 1500) score += 10;
      else if (profile.revenue_180d >= 500) score += 4;

      if (profile.return_orders_14d >= 2) score -= 28;
      else if (profile.return_orders_14d === 1) score -= 10;
      if (returnRate180 > 0.35) score -= 20;
      else if (returnRate180 > 0.2) score -= 10;
      if (birthdayNear && strikeStatus !== '冷却期') score += 10;

      const strikeWindowScore = timing.window_state === 'ready' ? 30
        : timing.window_state === 'late' ? 18
        : timing.window_state === 'cooldown' ? -25
        : timing.window_state === 'dormant' ? 6
        : 0;
      const orders14dScore = profile.orders_14d >= 3 ? 18
        : profile.orders_14d >= 2 ? 12
        : profile.orders_14d >= 1 ? 6
        : 0;
      const orders180dScore = profile.orders_180d >= 10 ? 16
        : profile.orders_180d >= 5 ? 12
        : profile.orders_180d >= 3 ? 8
        : profile.orders_180d >= 2 ? 4
        : 0;
      const revenue180dScore = profile.revenue_180d >= 5000 ? 24
        : profile.revenue_180d >= 3000 ? 18
        : profile.revenue_180d >= 1500 ? 10
        : profile.revenue_180d >= 500 ? 4
        : 0;
      const returnOrders14dScore = profile.return_orders_14d >= 2 ? -28
        : profile.return_orders_14d === 1 ? -10
        : 0;
      const returnRate180dScore = returnRate180 > 0.35 ? -20
        : returnRate180 > 0.2 ? -10
        : 0;
      const birthdayBonusScore = birthdayNear && timing.window_state !== 'cooldown' ? 10 : 0;

      let priorityTier = 'P2';
      let actionType = 'recall';
      if (!hasReturnsPressure && timing.window_state === 'ready' && (score >= 55 || isHighValue)) {
        priorityTier = 'P0';
        actionType = 'must_follow_today';
      } else if (!hasReturnsPressure && timing.window_state === 'ready' && score >= 38) {
        priorityTier = 'P1';
        actionType = 'upsell';
      } else if (hasReturnsPressure) {
        priorityTier = 'Risk';
        actionType = 'risk_watch';
      }

      const scoreBreakdown = {
        total: score,
        strike_status: strikeStatus,
        strike_window: strikeWindowScore,
        expected_gap_days: timing.expected_gap_days,
        window_start: timing.window_start,
        window_end: timing.window_end,
        dormant_after: timing.dormant_after,
        repeat_count: timing.repeat_count,
        unique_order_days: timing.unique_order_days,
        interval_p25: timing.interval_p25,
        interval_median: timing.interval_median,
        interval_p75: timing.interval_p75,
        recent_interval_avg: timing.recent_interval_avg,
        trend_ratio: timing.trend_ratio,
        due_ratio: timing.due_ratio,
        window_state: timing.window_state,
        orders_14d: orders14dScore,
        orders_180d: orders180dScore,
        revenue_180d: revenue180dScore,
        return_orders_14d: returnOrders14dScore,
        return_rate_180d: returnRate180dScore,
        birthday_bonus: birthdayBonusScore,
        priority_tier: priorityTier,
        action_type: actionType,
      };

      const ownedSkus = new Set(Array.from(profile.skuCounter.keys()));
      const topOwnedSkus = Array.from(profile.skuCounter.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => key.replace(/__/, ' · '));

      const sortedRecentOrders = [...profile.recent_orders]
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      const displayLastSellingPlatform = sortedRecentOrders.find(item => item.platform && item.platform !== '相册')?.platform
        || sortedRecentOrders[0]?.platform
        || null;
      const recentOrders = sortedRecentOrders
        .slice(0, 3)
        .map(item => ({
          date: item.date_key,
          platform: item.platform,
          sku: item.sku,
          factory: item.factory,
          tracking_no: item.tracking_no,
        }));

      const recentSkuKeys = recentOrders
        .map(item => item.sku ? `${item.sku}__${item.factory || '未知'}` : null)
        .filter(Boolean);
      const sourceSkuKeys = Array.from(new Set([...recentSkuKeys, ...ownedSkus]));
      const candidateMap = new Map();

      for (const sourceKey of sourceSkuKeys) {
        const relations = relationMap.get(sourceKey);
        if (!relations) continue;
        const sourceTotal = sourceCustomerCounts.get(sourceKey) || 0;
        const sourceLabel = sourceKey.replace(/__/, ' · ');
        for (const [targetKey, stats] of relations.entries()) {
          if (ownedSkus.has(targetKey)) continue;
          const target = qualifiedSkuMap.get(targetKey);
          if (!target) continue;
          const current = candidateMap.get(targetKey) || {
            sku: target.name,
            factory: target.factory,
            pair_count: 0,
            source_total: 0,
            same_day_count: 0,
            source_skus: [],
            source_hit_count: 0,
            support_sources: [],
          };
          current.pair_count += stats.pairCount;
          current.same_day_count += stats.sameDayCount;
          current.source_total += sourceTotal;
          current.source_hit_count += 1;
          if (!current.source_skus.includes(sourceLabel)) current.source_skus.push(sourceLabel);
          current.support_sources.push({ sourceKey, sourceLabel, pairCount: stats.pairCount, sourceTotal, sameDayCount: stats.sameDayCount });
          candidateMap.set(targetKey, current);
        }
      }

      const recommendationCandidates = Array.from(candidateMap.values())
        .map(candidate => {
          const topSources = candidate.support_sources
            .sort((a, b) => b.pairCount - a.pairCount || b.sourceTotal - a.sourceTotal)
            .slice(0, 2);
          candidate.source_skus = topSources.map(item => item.sourceLabel);
          candidate.best_pair_count = topSources[0]?.pairCount || 0;
          candidate.best_source_total = topSources[0]?.sourceTotal || 0;
          candidate.pair_count = topSources.reduce((sum, item) => sum + item.pairCount, 0);
          candidate.same_day_count = topSources.reduce((sum, item) => sum + item.sameDayCount, 0);
          candidate.conversion_rate = candidate.best_source_total > 0 ? candidate.best_pair_count / candidate.best_source_total : 0;
          const score = candidate.pair_count * 1000 + candidate.conversion_rate * 10000 + candidate.source_hit_count * 500 + ((qualifiedSkuMap.get(`${candidate.sku}__${candidate.factory}`)?.revenue || 0) / 10);
          const tags = [];
          if (candidate.pair_count >= 5) tags.push('共购高频');
          if (candidate.source_hit_count >= 2) tags.push('多源命中');
          if (candidate.same_day_count >= 2) tags.push('同日常搭配');
          if (birthdayNear && birthdayCategories.has(detectCategory(candidate.sku))) tags.push('生日加权');
          if (!tags.length) tags.push('共购命中');
          const confidence = recommendationConfidence(candidate.pair_count, candidate.conversion_rate, candidate.source_hit_count);
          const result = {
            sku: candidate.sku,
            factory: candidate.factory,
            confidence,
            score: Number(score.toFixed(0)),
            pair_count: candidate.pair_count,
            source_total: candidate.best_source_total,
            same_day_count: candidate.same_day_count,
            best_pair_count: candidate.best_pair_count,
            conversion_rate: Number((candidate.conversion_rate * 100).toFixed(1)),
            reason_tags: tags,
            source_skus: candidate.source_skus,
            label: `${candidate.sku} · ${candidate.factory}`,
          };
          result.reason = recommendationReason(result);
          return result;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      const primaryRecommendation = recommendationCandidates[0] || null;
      const secondaryRecommendations = recommendationCandidates.slice(1);
      const recommendedSkus = recommendationCandidates.map(item => item.label);

      let actionReason = `预计复购周期约 ${timing.expected_gap_days} 天，当前距上次下单 ${daysSinceLastOrder ?? '-'} 天`;
      if (actionType === 'must_follow_today') actionReason = `已进入个人${cadence}触达窗口，建议优先联系`;
      else if (actionType === 'upsell') actionReason = `已进入个人${cadence}加推窗口，可顺势促单`;
      else if (actionType === 'risk_watch') actionReason = '近14天退货压力偏高，建议先观察后触达';
      else if (timing.window_state === 'cooldown') actionReason = `距离个人预计窗口还有 ${Math.max((timing.window_start || 0) - (daysSinceLastOrder || 0), 0)} 天，暂不宜过早触达`;
      else if (timing.window_state === 'late') actionReason = `已超过个人最佳窗口，建议尽快召回`;
      else if (timing.window_state === 'dormant') actionReason = `已超过个人沉睡阈值 ${timing.dormant_after} 天，建议按沉睡客户策略触达`;
      if (birthdayNear && timing.window_state !== 'cooldown') {
        actionReason += ' · 生日近7天，可结合生日权益触达';
      }

      const recommendationSummary = primaryRecommendation
        ? `主推 ${primaryRecommendation.label}；${primaryRecommendation.reason}`
        : '暂无明确主推款，建议先按最近成交款做常规跟进';
      const pitchDirection = buildPitchDirection(actionType, strikeStatus, primaryRecommendation, topOwnedSkus, birthdayNear);
      const avoidRecommendations = [];
      if (hasReturnsPressure) {
        avoidRecommendations.push({ sku: '高退货款', reason: '客户当前退货压力偏高，避免强推高风险款' });
      }
      if (profile.last_order_sku) {
        avoidRecommendations.push({ sku: profile.last_order_sku, reason: '客户刚买过同款，短期内不建议重复硬推' });
      }

      return {
        customer_key: profile.customer_key,
        customer_name: profile.customer_name,
        phone: profile.phone,
        employee: profile.employee,
        all_employees: Array.from(profile.all_employees || []),
        platform: profile.platform,
        last_order_date: lastDate ? toDateKey(lastDate) : null,
        last_order_platform: profile.last_order_platform,
        display_last_selling_platform: displayLastSellingPlatform,
        last_order_sku: profile.last_order_sku,
        last_order_tracking_no: profile.last_order_tracking_no,
        recent_orders: recentOrders,
        days_since_last_order: daysSinceLastOrder,
        repeat_median_gap: repeatMedianGap,
        platform_cadence_bucket: cadence,
        strike_window_status: strikeStatus,
        window_state: timing.window_state,
        expected_gap_days: timing.expected_gap_days,
        window_start: timing.window_start,
        window_end: timing.window_end,
        dormant_after: timing.dormant_after,
        repeat_count: timing.repeat_count,
        unique_order_days: timing.unique_order_days,
        interval_p25: timing.interval_p25,
        interval_median: timing.interval_median,
        interval_p75: timing.interval_p75,
        recent_interval_avg: timing.recent_interval_avg,
        trend_ratio: timing.trend_ratio,
        due_ratio: timing.due_ratio,
        orders_14d: profile.orders_14d,
        orders_90d: profile.orders_14d,
        orders_180d: profile.orders_180d,
        orders_365d: profile.orders_365d,
        orders_all: profile.orders_all,
        revenue_180d: Math.round(profile.revenue_180d),
        revenue_365d: Math.round(profile.revenue_365d),
        revenue_all: Math.round(profile.revenue_all),
        return_orders_14d: profile.return_orders_14d,
        return_orders_90d: profile.return_orders_14d,
        return_rate_180d: Number((returnRate180 * 100).toFixed(1)),
        top_skus: topOwnedSkus,
        recommended_skus: recommendedSkus,
        primary_recommendation: primaryRecommendation,
        secondary_recommendations: secondaryRecommendations,
        recommendation_summary: recommendationSummary,
        pitch_direction: pitchDirection,
        avoid_recommendations: avoidRecommendations,
        birthday_match_confidence: birthdayConfidence,
        birthday_member_name: birthday?.member_name || null,
        birthday_phone: birthday?.member_phone || null,
        birthday_shop: birthday?.member_shop || null,
        birthday_date: birthday?.member_birthday || null,
        birthday_month_day: birthday?.birthday_month_day || null,
        birthday_days_until: birthday?.birthday_days_until ?? null,
        birthday_is_near: birthdayNear,
        birthday_reminder_window: birthdayNear ? '生日近7天' : null,
        birthday_style_preferences: birthdayStyleTags,
        birthday_expected_gift: birthday?.expected_gift || null,
        score_breakdown: scoreBreakdown,
        priority_score: score,
        priority_tier: priorityTier,
        action_type: actionType,
        action_reason: actionReason,
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || (a.days_since_last_order ?? 9999) - (b.days_since_last_order ?? 9999));

  const summary = outputCustomers.reduce(
    (acc, customer) => {
      if (customer.priority_tier === 'P0') acc.p0_today += 1;
      else if (customer.priority_tier === 'P1') acc.p1_upsell += 1;
      else if (customer.priority_tier === 'P2') acc.p2_recall += 1;
      else acc.risk_watch += 1;
      acc.expected_opportunity += customer.priority_tier === 'P0' || customer.priority_tier === 'P1'
        ? customer.revenue_180d
        : 0;
      acc.birthday_near += customer.birthday_is_near ? 1 : 0;
      return acc;
    },
    { p0_today: 0, p1_upsell: 0, p2_recall: 0, risk_watch: 0, expected_opportunity: 0, birthday_near: 0 }
  );

  const result = {
    generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    source_synced_at: source.synced_at,
    birthday_source_synced_at: birthdaySource.synced_at,
    window_days: ACTION_WINDOW_DAYS,
    return_rate_lag_days: RETURN_RATE_LAG_DAYS,
    summary,
    customers: outputCustomers,
  };

  writeJsonAtomically(OUTPUT_FILE, TMP_FILE, result);
  console.log(`✅ Customer action data generated`);
  console.log(`   Customers: ${outputCustomers.length}`);
  console.log(`   Output: ${OUTPUT_FILE}`);
}

main();
