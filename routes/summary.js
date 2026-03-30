// routes/summary.js - 日/周/季/年汇总报表接口
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { query } from '../db.js';

const router = express.Router();

// 工具函数
function dateAdd(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function weekRange(date) {
  const d = new Date(date);
  const day = d.getDay() || 7; // 周一为第一天
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    start: mon.toISOString().split('T')[0],
    end: sun.toISOString().split('T')[0],
    label: `${mon.getMonth()+1}月${mon.getDate()}日 - ${sun.getMonth()+1}月${sun.getDate()}日`,
  };
}

function quarterRange(date) {
  const d = new Date(date);
  const q = Math.floor(d.getMonth() / 3); // 0-3
  const start = new Date(d.getFullYear(), q * 3, 1);
  const end = new Date(d.getFullYear(), q * 3 + 3, 0);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    label: `${d.getFullYear()}年 Q${q+1}`,
    quarter: q + 1,
    year: d.getFullYear(),
  };
}

function yearRange(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  return {
    start: `${y}-01-01`,
    end: `${y}-12-31`,
    label: `${y}年`,
    year: y,
  };
}

// 通用汇总查询
async function buildSummary(familyId, startDate, endDate) {
  // 收支总额
  const totals = await query(`
    SELECT type, SUM(amount) as total, COUNT(*) as count
    FROM bills
    WHERE family_id = $1::text AND date>=? AND date<=?
    GROUP BY type
  `, [familyId, startDate, endDate]);

  let income = 0, expense = 0, incomeCount = 0, expenseCount = 0;
  for (const r of totals) {
    if (r.type === 'income') { income = r.total || 0; incomeCount = r.count; }
    if (r.type === 'expense') { expense = r.total || 0; expenseCount = r.count; }
  }

  // 支出分类 TOP5
  const expCats = await query(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM bills
    WHERE family_id = $1::text AND date>=? AND date<=? AND type='expense'
    GROUP BY category
    ORDER BY total DESC
    LIMIT 5
  `, [familyId, startDate, endDate]);

  // 收入分类 TOP3
  const incCats = await query(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM bills
    WHERE family_id = $1::text AND date>=? AND date<=? AND type='income'
    GROUP BY category
    ORDER BY total DESC
    LIMIT 3
  `, [familyId, startDate, endDate]);

  // 最大一笔支出
  const maxExpense = await query(`
    SELECT amount, category, note, date
    FROM bills
    WHERE family_id = $1::text AND date>=? AND date<=? AND type='expense'
    ORDER BY amount DESC
    LIMIT 1
  `, [familyId, startDate, endDate]);

  // 成员消费排行
  const members = await query(`
    SELECT u.nickname, u.username, SUM(b.amount) as total, COUNT(*) as count
    FROM bills b
    LEFT JOIN users u ON b.member_id = u.id
    WHERE b.family_id=? AND b.date>=? AND b.date<=? AND b.type='expense'
    GROUP BY b.member_id
    ORDER BY total DESC
    LIMIT 5
  `, [familyId, startDate, endDate]);

  // 每日支出（用于趋势）
  const daily = await query(`
    SELECT date, SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as expense,
           SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income
    FROM bills
    WHERE family_id = $1::text AND date>=? AND date<=?
    GROUP BY date
    ORDER BY date ASC
  `, [familyId, startDate, endDate]);

  return {
    income: Math.round(income * 100) / 100,
    expense: Math.round(expense * 100) / 100,
    balance: Math.round((income - expense) * 100) / 100,
    incomeCount,
    expenseCount,
    expenseCategories: expCats,
    incomeCategories: incCats,
    maxExpense: maxExpense[0] || null,
    members,
    daily,
  };
}

// 生成文字摘要（用于推送通知）
function generateTextSummary(period, summary, range) {
  const { income, expense, balance, expenseCategories, maxExpense } = summary;
  const sign = balance >= 0 ? '结余' : '超支';
  const absBalance = Math.abs(balance).toFixed(2);
  const topCat = expenseCategories[0];

  let text = `${range.label} 财务小结：\n`;
  text += `💰 收入 ¥${income.toFixed(2)}，支出 ¥${expense.toFixed(2)}\n`;
  text += balance >= 0
    ? `✅ ${sign} ¥${absBalance}\n`
    : `⚠️ ${sign} ¥${absBalance}，注意控制开支\n`;

  if (topCat) {
    text += `📊 最大开支：${topCat.category} ¥${Number(topCat.total).toFixed(2)}\n`;
  }
  if (maxExpense) {
    text += `🔍 最大单笔：${maxExpense.category} ¥${maxExpense.amount.toFixed(2)}（${maxExpense.date}）\n`;
  }

  return text;
}

// GET /api/summary/daily?date=2026-03-27
router.get('/daily', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const data = await buildSummary(req.user.familyId, date, date);
    const range = { label: `${date} 日报` };
    res.json({ success: true, data: { ...data, range, textSummary: generateTextSummary('daily', data, range) } });
  } catch (err) { next(err); }
});

// GET /api/summary/weekly?date=2026-03-27
router.get('/weekly', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const range = weekRange(date);
    const data = await buildSummary(req.user.familyId, range.start, range.end);
    res.json({ success: true, data: { ...data, range, textSummary: generateTextSummary('weekly', data, range) } });
  } catch (err) { next(err); }
});

// GET /api/summary/quarterly?date=2026-03-27
router.get('/quarterly', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const range = quarterRange(date);
    const data = await buildSummary(req.user.familyId, range.start, range.end);
    res.json({ success: true, data: { ...data, range, textSummary: generateTextSummary('quarterly', data, range) } });
  } catch (err) { next(err); }
});

// GET /api/summary/yearly?year=2026
router.get('/yearly', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) return res.status(400).json({ success: false, message: '未加入家庭' });
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const range = yearRange(date);
    const data = await buildSummary(req.user.familyId, range.start, range.end);

    // 年报额外加：各月趋势
    const monthly = await query(`
      SELECT strftime('%Y-%m', date) as month,
             SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as expense,
             SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income
      FROM bills
      WHERE family_id = $1::text AND date>=? AND date<=?
      GROUP BY month ORDER BY month ASC
    `, [req.user.familyId, range.start, range.end]);

    res.json({ success: true, data: { ...data, range, monthly, textSummary: generateTextSummary('yearly', data, range) } });
  } catch (err) { next(err); }
});

export { buildSummary, generateTextSummary, weekRange, quarterRange, yearRange };
export default router;
