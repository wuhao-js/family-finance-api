import express from 'express';
import { query, execute, generateUUID } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// 所有路由需要登录
router.use(authenticate);

// ============================================================
// GET /api/budgets/summary - 获取预算概览（总预算 vs 总支出）
// 注意：/summary 和 /history 必须在 /:id 之前注册
// ============================================================
router.get('/summary', async (req, res) => {
  try {
    const { familyId } = req.user;
    const { month, year } = req.query;

    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetMonth = month || String(now.getMonth() + 1).padStart(2, '0');
    const period = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

    if (!familyId) {
      return res.json({ success: true, data: { period, totalBudget: 0, totalSpent: 0, remaining: 0 } });
    }

    // 总预算
    const budgetRows = await query(
      'SELECT SUM(budget_amount) AS total FROM budgets WHERE family_id = ? AND period = ?',
      [familyId, period]
    );

    // 总支出（当月）
    const spentRows = await query(
      `SELECT SUM(amount) AS total FROM bills
       WHERE family_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`,
      [familyId, period]
    );

    const totalBudget = parseFloat(budgetRows[0]?.total || 0);
    const totalSpent = parseFloat(spentRows[0]?.total || 0);

    res.json({
      success: true,
      data: {
        period,
        totalBudget,
        totalSpent,
        remaining: totalBudget - totalSpent,
        percentage: totalBudget > 0 ? Math.min(100, Math.round((totalSpent / totalBudget) * 100)) : 0,
        is_exceeded: totalSpent > totalBudget && totalBudget > 0
      }
    });
  } catch (error) {
    console.error('[budgets] GET /summary error:', error);
    res.status(500).json({ success: false, message: '获取预算概览失败' });
  }
});

// ============================================================
// GET /api/budgets/history - 获取历史预算记录（按月份）
// ============================================================
router.get('/history', async (req, res) => {
  try {
    const { familyId } = req.user;
    const { limit = 6 } = req.query;

    if (!familyId) {
      return res.json({ success: true, data: [] });
    }

    // 获取最近 N 个月有预算的月份列表
    const periods = await query(
      'SELECT DISTINCT period FROM budgets WHERE family_id = ? ORDER BY period DESC LIMIT ?',
      [familyId, parseInt(limit)]
    );

    const history = [];
    for (const { period } of periods) {
      const budgetRows = await query(
        'SELECT SUM(budget_amount) AS total FROM budgets WHERE family_id = ? AND period = ?',
        [familyId, period]
      );
      const spentRows = await query(
        `SELECT SUM(amount) AS total FROM bills
         WHERE family_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`,
        [familyId, period]
      );
      const totalBudget = parseFloat(budgetRows[0]?.total || 0);
      const totalSpent = parseFloat(spentRows[0]?.total || 0);
      history.push({
        period,
        totalBudget,
        totalSpent,
        remaining: totalBudget - totalSpent,
        percentage: totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0
      });
    }

    res.json({ success: true, data: history });
  } catch (error) {
    console.error('[budgets] GET /history error:', error);
    res.status(500).json({ success: false, message: '获取历史预算失败' });
  }
});

// ============================================================
// GET /api/budgets - 获取预算列表（当前家庭 + 当月）
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { familyId } = req.user;
    const { month, year } = req.query;

    // 默认当月
    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetMonth = month || String(now.getMonth() + 1).padStart(2, '0');
    const period = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

    if (!familyId) {
      return res.json({ success: true, data: [] });
    }

    // 获取预算（带已花费金额）
    const budgets = await query(
      `SELECT b.*,
        COALESCE((
          SELECT SUM(bi.amount)
          FROM bills bi
          WHERE bi.family_id = b.family_id
            AND bi.type = 'expense'
            AND (b.category = 'total' OR bi.category = b.category)
            AND strftime('%Y-%m', bi.date) = b.period
        ), 0) AS spent_amount
      FROM budgets b
      WHERE b.family_id = ? AND b.period = ?
      ORDER BY b.category`,
      [familyId, period]
    );

    // 计算剩余和百分比
    const result = budgets.map(b => ({
      ...b,
      budget_amount: parseFloat(b.budget_amount),
      spent_amount: parseFloat(b.spent_amount || 0),
      remaining: parseFloat(b.budget_amount) - parseFloat(b.spent_amount || 0),
      percentage: b.budget_amount > 0
        ? Math.min(100, Math.round((b.spent_amount / b.budget_amount) * 100))
        : 0,
      is_exceeded: parseFloat(b.spent_amount || 0) > parseFloat(b.budget_amount)
    }));

    res.json({ success: true, data: result, period });
  } catch (error) {
    console.error('[budgets] GET / error:', error);
    res.status(500).json({ success: false, message: '获取预算列表失败' });
  }
});

// ============================================================
// POST /api/budgets - 创建或更新预算
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { familyId, id: userId } = req.user;
    const { category, budget_amount, period, note } = req.body;

    if (!familyId) {
      return res.status(400).json({ success: false, message: '请先加入家庭' });
    }
    if (!category || !budget_amount || !period) {
      return res.status(400).json({ success: false, message: 'category、budget_amount、period 为必填项' });
    }
    if (isNaN(parseFloat(budget_amount)) || parseFloat(budget_amount) <= 0) {
      return res.status(400).json({ success: false, message: '预算金额必须大于0' });
    }

    // 校验 period 格式
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ success: false, message: 'period 格式应为 YYYY-MM' });
    }

    // 查找是否已存在该类别+月份的预算
    const existing = await query(
      'SELECT id FROM budgets WHERE family_id = ? AND category = ? AND period = ?',
      [familyId, category, period]
    );

    if (existing.length > 0) {
      // 更新
      await execute(
        `UPDATE budgets SET budget_amount = ?, note = ?, updated_at = datetime('now') WHERE id = ?`,
        [parseFloat(budget_amount), note || null, existing[0].id]
      );
      const updated = await query('SELECT * FROM budgets WHERE id = ?', [existing[0].id]);
      return res.json({ success: true, message: '预算已更新', data: updated[0] });
    }

    // 创建
    const id = generateUUID();
    await execute(
      `INSERT INTO budgets (id, family_id, category, budget_amount, period, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [id, familyId, category, parseFloat(budget_amount), period, note || null, userId]
    );

    const created = await query('SELECT * FROM budgets WHERE id = ?', [id]);
    res.status(201).json({ success: true, message: '预算创建成功', data: created[0] });
  } catch (error) {
    console.error('[budgets] POST / error:', error);
    res.status(500).json({ success: false, message: '创建预算失败' });
  }
});

// ============================================================
// PUT /api/budgets/:id - 更新预算
// ============================================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { familyId } = req.user;
    const { budget_amount, note } = req.body;

    const existing = await query('SELECT * FROM budgets WHERE id = ? AND family_id = ?', [id, familyId]);
    if (!existing.length) {
      return res.status(404).json({ success: false, message: '预算不存在' });
    }

    if (budget_amount !== undefined) {
      if (isNaN(parseFloat(budget_amount)) || parseFloat(budget_amount) <= 0) {
        return res.status(400).json({ success: false, message: '预算金额必须大于0' });
      }
    }

    await execute(
      `UPDATE budgets SET
        budget_amount = COALESCE(?, budget_amount),
        note = COALESCE(?, note),
        updated_at = datetime('now')
       WHERE id = ?`,
      [budget_amount ? parseFloat(budget_amount) : null, note !== undefined ? note : null, id]
    );

    const updated = await query('SELECT * FROM budgets WHERE id = ?', [id]);
    res.json({ success: true, message: '预算更新成功', data: updated[0] });
  } catch (error) {
    console.error('[budgets] PUT /:id error:', error);
    res.status(500).json({ success: false, message: '更新预算失败' });
  }
});

// ============================================================
// DELETE /api/budgets/:id - 删除预算
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { familyId } = req.user;

    const existing = await query('SELECT * FROM budgets WHERE id = ? AND family_id = ?', [id, familyId]);
    if (!existing.length) {
      return res.status(404).json({ success: false, message: '预算不存在' });
    }

    await execute('DELETE FROM budgets WHERE id = ?', [id]);
    res.json({ success: true, message: '预算删除成功' });
  } catch (error) {
    console.error('[budgets] DELETE /:id error:', error);
    res.status(500).json({ success: false, message: '删除预算失败' });
  }
});

export default router;
