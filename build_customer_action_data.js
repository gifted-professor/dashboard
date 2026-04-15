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
  return date.toISOString().slice(0, 10);
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
  const returnStatus = text(record.return_status);
  const refundReason = text(record.refund_reason);
  const status = text(record.status);
  const refundAmount = toNumber(record.refund_amount) || 0;
  if (refundAmount > 0) return true;
  if (refundType && refundType !== '0' && refundType !== '正常') return true;
  const combined = [returnStatus, refundReason, status].filter(Boolean).join(' ');
  return /(退|换|取消|拒收)/.test(combined) && !/正常/.test(combined);
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
  return buildTrailingWindow(lagEnd, ACTION_WINDOW_DAYS);
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

function strikeWindowStatus(platform, daysSinceLastOrder, medianGap) {
  const bucket = cadenceBucket(platform, medianGap);
  if (daysSinceLastOrder == null) return '未知';

  if (bucket === '快节奏') {
    if (daysSinceLastOrder <= 3) return '冷却期';
    if (daysSinceLastOrder <= 7) return '观察期';
    if (daysSinceLastOrder <= 14) return '进入斩杀线';
    return '召回期';
  }

  if (bucket === '中节奏') {
    if (daysSinceLastOrder <= 5) return '冷却期';
    if (daysSinceLastOrder <= 14) return '观察期';
    if (daysSinceLastOrder <= 21) return '进入斩杀线';
    return '召回期';
  }

  if (daysSinceLastOrder <= 14) return '冷却期';
  if (daysSinceLastOrder <= 30) return '观察期';
  if (daysSinceLastOrder <= 60) return '进入斩杀线';
  return '召回期';
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

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`);
  }

  const source = readJson(INPUT_FILE);
  const rawRecords = Array.isArray(source.records) ? source.records : [];
  const records = rawRecords.filter(record => !isExcludedPlatform(record) && isActiveEmployee(record) && (record.customer_name || record.phone));
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
      last_order_date: null,
      last_order_platform: null,
      last_order_sku: null,
      last_order_tracking_no: null,
      recent_orders: [],
      unique_order_days: new Set(),
      orders_14d: 0,
      orders_180d: 0,
      revenue_180d: 0,
      return_orders_14d: 0,
      return_orders_180d: 0,
      skuCounter: new Map(),
    };

    if (!profile.last_order_date || date > profile.last_order_date) {
      profile.last_order_date = date;
      profile.last_order_platform = text(record.platform);
      profile.last_order_sku = text(record.sku_name);
      profile.last_order_tracking_no = text(record.tracking_no);
    }

    profile.recent_orders.push({
      date,
      date_key: toDateKey(date),
      platform: text(record.platform),
      sku: text(record.sku_name),
      tracking_no: text(record.tracking_no),
    });
    profile.unique_order_days.add(toDateKey(date));

    const diffDays = Math.floor((now - date) / DAY_MS);
    if (diffDays <= HISTORY_DAYS) {
      profile.orders_180d += 1;
      profile.revenue_180d += revenue;
      if (returned) profile.return_orders_180d += 1;
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

  const qualifiedSkus = Array.from(skuRecentStats.values())
    .map(item => {
      const rateStat = skuRateStats.get(item.key) || { orders: 0, returns: 0 };
      return {
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
      const cadence = cadenceBucket(profile.last_order_platform || profile.platform, repeatMedianGap);
      const strikeStatus = strikeWindowStatus(profile.last_order_platform || profile.platform, daysSinceLastOrder, repeatMedianGap);
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
      if (strikeStatus === '进入斩杀线') score += 30;
      else if (strikeStatus === '召回期') score += 18;
      else if (strikeStatus === '观察期') score += 6;
      else if (strikeStatus === '冷却期') score -= 25;

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

      let priorityTier = 'P2';
      let actionType = 'recall';
      if (!hasReturnsPressure && strikeStatus === '进入斩杀线' && (score >= 55 || isHighValue)) {
        priorityTier = 'P0';
        actionType = 'must_follow_today';
      } else if (!hasReturnsPressure && strikeStatus === '进入斩杀线' && score >= 38) {
        priorityTier = 'P1';
        actionType = 'upsell';
      } else if (hasReturnsPressure) {
        priorityTier = 'Risk';
        actionType = 'risk_watch';
      }

      const ownedSkus = new Set(Array.from(profile.skuCounter.keys()));
      const topOwnedSkus = Array.from(profile.skuCounter.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => key.replace(/__/, ' · '));

      const recentOrders = profile.recent_orders
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 3)
        .map(item => ({
          date: item.date_key,
          platform: item.platform,
          sku: item.sku,
          tracking_no: item.tracking_no,
        }));

      const recentPlatforms = new Set(recentOrders.map(item => item.platform).filter(Boolean));
      const recentSkuWords = new Set(recentOrders.flatMap(item => String(item.sku || '').split(/[\s·\/\-]+/).filter(Boolean)));
      const recentCategories = new Set(recentOrders.map(item => detectCategory(item.sku)).filter(Boolean));

      const recommendedSkus = qualifiedSkus
        .filter(item => !ownedSkus.has(`${item.name}__${item.factory}`))
        .map(item => {
          let matchScore = item.revenue + item.orders * 100;
          if (recentPlatforms.has(item.platform)) matchScore += 800;
          const itemWords = String(item.name || '').split(/[\s·\/\-]+/).filter(Boolean);
          if (itemWords.some(word => recentSkuWords.has(word))) matchScore += 600;
          const itemCategory = detectCategory(item.name);
          if (itemCategory && recentCategories.has(itemCategory)) matchScore += 1400;
          if (itemCategory && birthdayCategories.has(itemCategory)) matchScore += 900;
          return { ...item, matchScore };
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 3)
        .map(item => `${item.name} · ${item.factory}`);

      let actionReason = '历史有成交记录，但尚未进入主动加推窗口，适合常规召回';
      if (actionType === 'must_follow_today') actionReason = `已进入${cadence}客户的斩杀线，建议优先联系`;
      else if (actionType === 'upsell') actionReason = `已进入${cadence}客户的加推窗口，可顺势促单`;
      else if (actionType === 'risk_watch') actionReason = '近14天退货压力偏高，建议先观察后触达';
      if (birthdayNear && strikeStatus !== '冷却期') {
        actionReason += ' · 生日近7天，可结合生日权益触达';
      }

      return {
        customer_key: profile.customer_key,
        customer_name: profile.customer_name,
        phone: profile.phone,
        employee: profile.employee,
        platform: profile.platform,
        last_order_date: lastDate ? toDateKey(lastDate) : null,
        last_order_platform: profile.last_order_platform,
        last_order_sku: profile.last_order_sku,
        last_order_tracking_no: profile.last_order_tracking_no,
        recent_orders: recentOrders,
        days_since_last_order: daysSinceLastOrder,
        repeat_median_gap: repeatMedianGap,
        platform_cadence_bucket: cadence,
        strike_window_status: strikeStatus,
        orders_14d: profile.orders_14d,
        orders_90d: profile.orders_14d,
        orders_180d: profile.orders_180d,
        revenue_180d: Math.round(profile.revenue_180d),
        return_orders_14d: profile.return_orders_14d,
        return_orders_90d: profile.return_orders_14d,
        return_rate_180d: Number((returnRate180 * 100).toFixed(1)),
        top_skus: topOwnedSkus,
        recommended_skus: recommendedSkus,
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
    customers: outputCustomers.slice(0, 600),
  };

  writeJsonAtomically(OUTPUT_FILE, TMP_FILE, result);
  console.log(`✅ Customer action data generated`);
  console.log(`   Customers: ${outputCustomers.length}`);
  console.log(`   Output: ${OUTPUT_FILE}`);
}

main();
