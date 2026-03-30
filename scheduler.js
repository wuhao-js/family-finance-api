// scheduler.js - 定时任务调度（日报/周报/季报/年报）
// 纯 Node.js 实现，无需 cron 库
// 注意：Node.js setTimeout 最大 ~24.8 天（2^31-1 ms），超出用分段延迟

import { pushToAllUsers } from './routes/notify.js';

const MAX_DELAY = 2147483647; // 2^31 - 1 ms (~24.8天)

// 安全的 setTimeout，支持超过 32-bit 的大延迟
function safeSleep(ms, callback) {
  if (ms <= MAX_DELAY) {
    setTimeout(callback, ms);
  } else {
    // 先等 MAX_DELAY，再递归减去已等待的时间
    setTimeout(() => safeSleep(ms - MAX_DELAY, callback), MAX_DELAY);
  }
}

// 计算距下次目标时刻的毫秒数
function msUntil(hour, minute = 0, targetDow = null) {
  const now = new Date();
  const next = new Date(now);

  if (targetDow !== null) {
    const diff = (targetDow - now.getDay() + 7) % 7;
    next.setDate(now.getDate() + diff);
  }
  next.setHours(hour, minute, 0, 0);

  if (next <= now) {
    if (targetDow !== null) {
      next.setDate(next.getDate() + 7);
    } else {
      next.setDate(next.getDate() + 1);
    }
  }

  return next - now;
}

// 计算本季度末最后一天 19:00 的毫秒数
function msUntilQuarterEnd() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  let next = new Date(now.getFullYear(), q * 3 + 3, 0, 19, 0, 0); // 季度末
  if (next <= now) {
    const nextQ = q + 1;
    const nextYear = nextQ >= 4 ? now.getFullYear() + 1 : now.getFullYear();
    const nextQAdj = nextQ % 4;
    next = new Date(nextYear, nextQAdj * 3 + 3, 0, 19, 0, 0);
  }
  return next - now;
}

// 计算距12月31日 18:00 的毫秒数
function msUntilYearEnd() {
  const now = new Date();
  let next = new Date(now.getFullYear(), 11, 31, 18, 0, 0);
  if (next <= now) next = new Date(now.getFullYear() + 1, 11, 31, 18, 0, 0);
  return next - now;
}

// 每日20:30 发送日报
function scheduleDailyReport() {
  const delay = msUntil(20, 30);
  const h = Math.floor(delay / 3600000);
  console.log(`[Scheduler] 日报将在 ${h} 小时后发送`);

  safeSleep(delay, async () => {
    console.log('[Scheduler] 开始发送日报...');
    await pushToAllUsers('daily');
    scheduleDailyReport(); // 循环调度
  });
}

// 每周日 20:00 发送周报
function scheduleWeeklyReport() {
  const delay = msUntil(20, 0, 0); // 0 = Sunday
  const h = Math.floor(delay / 3600000);
  console.log(`[Scheduler] 周报将在 ${h} 小时后发送`);

  safeSleep(delay, async () => {
    console.log('[Scheduler] 开始发送周报...');
    await pushToAllUsers('weekly');
    scheduleWeeklyReport();
  });
}

// 每季度末最后一天 19:00 发送季报
function scheduleQuarterlyReport() {
  const delay = msUntilQuarterEnd();
  const days = Math.floor(delay / 86400000);
  console.log(`[Scheduler] 季报将在 ${days} 天后发送`);

  safeSleep(delay, async () => {
    console.log('[Scheduler] 开始发送季报...');
    await pushToAllUsers('quarterly');
    scheduleQuarterlyReport();
  });
}

// 每年12月31日 18:00 发送年报
function scheduleYearlyReport() {
  const delay = msUntilYearEnd();
  const days = Math.floor(delay / 86400000);
  console.log(`[Scheduler] 年报将在 ${days} 天后发送`);

  safeSleep(delay, async () => {
    console.log('[Scheduler] 开始发送年报...');
    await pushToAllUsers('yearly');
    scheduleYearlyReport();
  });
}

export function startScheduler() {
  console.log('[Scheduler] 定时推送服务启动');
  scheduleDailyReport();
  scheduleWeeklyReport();
  scheduleQuarterlyReport();
  scheduleYearlyReport();
}
