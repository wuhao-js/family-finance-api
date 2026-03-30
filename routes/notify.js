// routes/notify.js - 微信服务通知（订阅消息）
import express from 'express';
import https from 'https';
import { authenticate } from '../middleware/auth.js';
import { query, execute, generateUUID } from '../db.js';
import { buildSummary, generateTextSummary, weekRange, quarterRange, yearRange } from './summary.js';

const router = express.Router();

const APPID = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_SECRET;

// 微信服务通知模板 ID（需要在微信公众平台申请）
// 用户需要在小程序后台「订阅消息」中申请以下模板，并填入 .env
// TMPL_DAILY   = 每日汇总模板ID
// TMPL_WEEKLY  = 每周汇总模板ID
// TMPL_ALERT   = 超支预警模板ID
const TEMPLATES = {
  daily:   process.env.TMPL_DAILY   || '',
  weekly:  process.env.TMPL_WEEKLY  || '',
  monthly: process.env.TMPL_MONTHLY || '',
  yearly:  process.env.TMPL_YEARLY  || '',
  alert:   process.env.TMPL_ALERT   || '',
};

// 获取小程序 access_token
let _token = null, _tokenExpire = 0;
async function getAccessToken() {
  if (_token && Date.now() < _tokenExpire) return _token;
  return new Promise((resolve, reject) => {
    https.get(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`,
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.access_token) {
              _token = j.access_token;
              _tokenExpire = Date.now() + (j.expires_in - 60) * 1000;
              resolve(_token);
            } else {
              reject(new Error(j.errmsg || '获取 access_token 失败'));
            }
          } catch(e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

// 发送订阅消息
async function sendSubscribeMessage(openid, templateId, page, data) {
  if (!templateId) {
    console.log('[Notify] 模板 ID 未配置，跳过推送');
    return { skipped: true };
  }
  const token = await getAccessToken();
  const body = JSON.stringify({ touser: openid, template_id: templateId, page, data });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: `/cgi-bin/message/subscribe/send?access_token=${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 构建消息数据（匹配模板ID 5y_uSJpxUs4NB80y6eghrSyBQBQatY0OomCH45Afrqk）
// 字段映射：
// amount4  = 支出金额
// amount5  = 收入金额
// amount11 = 结余金额
// amount10 = 账单金额（用支出+收入）
// date1    = 统计周期
function buildMsgData(label, summary) {
  const expense = summary.expense || 0;
  const income  = summary.income  || 0;
  const balance = summary.balance || (income - expense);
  return {
    amount4:  { value: `¥${expense.toFixed(2)}` },
    amount5:  { value: `¥${income.toFixed(2)}` },
    amount11: { value: `¥${balance.toFixed(2)}` },
    amount10: { value: `¥${(expense + income).toFixed(2)}` },
    date1:    { value: label },
  };
}

// 兼容别名
function buildDailyData(summary, date) {
  return buildMsgData(`${date} 日报`, summary);
}
function buildWeeklyData(summary, range) {
  return buildMsgData(range.label, summary);
}

// POST /api/notify/subscribe - 保存用户订阅授权
router.post('/subscribe', authenticate, async (req, res, next) => {
  try {
    const { types = ['daily', 'weekly'] } = req.body; // 用户订阅的类型
    const openid = req.user.wechat_openid;

    await execute(
      `UPDATE users SET notify_types=$1, notify_enabled=1 WHERE id = $1::text`,
      [JSON.stringify(types), req.user.id]
    );

    // 没有 openid（账号密码登录）时提示，但不阻止保存
    if (!openid) {
      return res.json({
        success: true,
        message: '订阅偏好已保存，微信登录后可收到推送通知'
      });
    }

    res.json({ success: true, message: '通知订阅成功' });
  } catch (err) { next(err); }
});

// POST /api/notify/unsubscribe - 取消订阅
router.post('/unsubscribe', authenticate, async (req, res, next) => {
  try {
    await execute(`UPDATE users SET notify_enabled=0 WHERE id = $1::text`, [req.user.id]);
    res.json({ success: true, message: '已取消通知' });
  } catch (err) { next(err); }
});

// GET /api/notify/status - 查询订阅状态
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const users = await query('SELECT notify_enabled, notify_types FROM users WHERE id = $1::text', [req.user.id]);
    const u = users[0] || {};
    res.json({
      success: true,
      data: {
        enabled: !!u.notify_enabled,
        types: u.notify_types ? JSON.parse(u.notify_types) : ['daily','weekly'],
      }
    });
  } catch (err) { next(err); }
});

// POST /api/notify/send-daily - 手动触发日报推送（也供定时任务调用）
router.post('/send-daily', authenticate, async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });

    const summary = await buildSummary(req.user.familyId, date, date);
    const openid = req.user.wechat_openid;

    let pushResult = null;
    if (openid && TEMPLATES.daily) {
      pushResult = await sendSubscribeMessage(openid, TEMPLATES.daily, 'pages/statistics/statistics', buildDailyData(summary, date));
    }

    res.json({
      success: true,
      data: {
        summary,
        textSummary: generateTextSummary('daily', summary, { label: date + ' 日报' }),
        pushed: !!pushResult && !pushResult.skipped,
        pushResult,
      }
    });
  } catch (err) { next(err); }
});

// POST /api/notify/send-weekly - 手动触发周报推送
router.post('/send-weekly', authenticate, async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });

    const range = weekRange(date);
    const summary = await buildSummary(req.user.familyId, range.start, range.end);
    const openid = req.user.wechat_openid;

    let pushResult = null;
    if (openid && TEMPLATES.weekly) {
      pushResult = await sendSubscribeMessage(openid, TEMPLATES.weekly, 'pages/statistics/statistics', buildWeeklyData(summary, range));
    }

    res.json({
      success: true,
      data: {
        summary,
        range,
        textSummary: generateTextSummary('weekly', summary, range),
        pushed: !!pushResult && !pushResult.skipped,
        pushResult,
      }
    });
  } catch (err) { next(err); }
});

// 内部：批量给所有订阅用户发推送（定时任务用）
export async function pushToAllUsers(period) {
  try {
    const users = await query(
      `SELECT u.id, u.wechat_openid, u.family_id, u.notify_types
       FROM users u
       WHERE u.notify_enabled=1 AND u.wechat_openid IS NOT NULL AND u.family_id IS NOT NULL`
    );

    const today = new Date().toISOString().split('T')[0];
    let sent = 0, failed = 0;

    for (const u of users) {
      try {
        const types = u.notify_types ? JSON.parse(u.notify_types) : ['daily','weekly'];
        if (!types.includes(period)) continue;

        let range, summary, templateId, msgData;

        if (period === 'daily') {
          range = { label: `${today} 日报` };
          summary = await buildSummary(u.family_id, today, today);
          templateId = TEMPLATES.daily;
          msgData = buildDailyData(summary, today);
        } else if (period === 'weekly') {
          range = weekRange(today);
          summary = await buildSummary(u.family_id, range.start, range.end);
          templateId = TEMPLATES.weekly;
          msgData = buildWeeklyData(summary, range);
        } else if (period === 'quarterly') {
          range = quarterRange(today);
          summary = await buildSummary(u.family_id, range.start, range.end);
          templateId = TEMPLATES.monthly;
          msgData = buildWeeklyData(summary, range);
        } else if (period === 'yearly') {
          range = yearRange(today);
          summary = await buildSummary(u.family_id, range.start, range.end);
          templateId = TEMPLATES.yearly;
          msgData = buildWeeklyData(summary, range);
        }

        if (templateId && u.wechat_openid) {
          await sendSubscribeMessage(u.wechat_openid, templateId, 'pages/statistics/statistics', msgData);
          sent++;
        }
      } catch (e) {
        console.error('[Notify] 推送失败 user:', u.id, e.message);
        failed++;
      }
    }

    console.log(`[Notify] ${period} 推送完成：成功 ${sent}，失败 ${failed}`);
    return { sent, failed };
  } catch (err) {
    console.error('[Notify] 批量推送异常:', err);
    return { sent: 0, failed: 0, error: err.message };
  }
}

export { sendSubscribeMessage };
export default router;
