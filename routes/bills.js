import express from 'express';
import { query, execute, generateUUID } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { cache, CacheKeys } from '../utils/cache.js';

const router = express.Router();

// 清除账单相关缓存
const invalidateBillCache = (familyId) => {
  cache.invalidate(`bills:${familyId}:*`);
  cache.invalidate(`stats:${familyId}:*`);
};

// 获取账单列表
router.get('/', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const {
      page = 1,
      pageSize = 20,
      type,
      category,
      memberId,
      startDate,
      endDate,
      keyword
    } = req.query;

    const offset = (page - 1) * pageSize;
    let sql = `
      SELECT b.*, u.username, u.nickname as member_name
      FROM bills b
      LEFT JOIN users u ON b.member_id = u.id
      WHERE b.family_id = ?
    `;
    const params = [req.user.familyId];

    if (type) {
      sql += ' AND b.type = ?';
      params.push(type);
    }

    if (category) {
      sql += ' AND b.category = ?';
      params.push(category);
    }

    if (memberId) {
      sql += ' AND b.member_id = ?';
      params.push(memberId);
    }

    if (startDate) {
      sql += ' AND b.date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND b.date <= ?';
      params.push(endDate);
    }

    if (keyword) {
      sql += ' AND (b.note LIKE ? OR b.category LIKE ?)';
      const likeKeyword = `%${keyword}%`;
      params.push(likeKeyword, likeKeyword);
    }

    // 获取总数
    const countSql = sql.replace(/SELECT b\.\*, u\.username, u\.nickname as member_name/, 'SELECT COUNT(*) as total');
    const countResult = await query(countSql, params);
    const total = countResult[0].total;

    // 获取分页数据
    sql += ' ORDER BY b.date DESC, b.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), offset);

    const bills = await query(sql, params);

    res.json({
      success: true,
      data: {
        list: bills,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取账单统计
router.get('/statistics', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { startDate, endDate, groupBy = 'month' } = req.query;

    // MySQL DATE_FORMAT → SQLite strftime 格式映射
    let dateFormat;
    switch (groupBy) {
      case 'year':
        dateFormat = '%Y';
        break;
      case 'month':
        dateFormat = '%Y-%m';
        break;
      case 'day':
        dateFormat = '%Y-%m-%d';
        break;
      default:
        dateFormat = '%Y-%m';
    }
    // SQLite strftime 格式
    const sqliteDateFormat = dateFormat;

    let sql = `
      SELECT
        strftime('${sqliteDateFormat}', b.date) as period,
        b.type,
        SUM(b.amount) as total_amount,
        COUNT(*) as count
      FROM bills b
      WHERE b.family_id = ?
    `;
    const params = [req.user.familyId];

    if (startDate) {
      sql += ' AND b.date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND b.date <= ?';
      params.push(endDate);
    }

    sql += ` GROUP BY period, b.type ORDER BY period DESC`;

    const statistics = await query(sql, params);

    // 计算总计
    const totalIncome = statistics
      .filter(s => s.type === 'income')
      .reduce((sum, s) => sum + parseFloat(s.total_amount), 0);
    const totalExpense = statistics
      .filter(s => s.type === 'expense')
      .reduce((sum, s) => sum + parseFloat(s.total_amount), 0);

    res.json({
      success: true,
      data: {
        statistics,
        summary: {
          totalIncome,
          totalExpense,
          balance: totalIncome - totalExpense
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取分类统计
router.get('/categories', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { startDate, endDate, type } = req.query;

    let sql = `
      SELECT
        b.category,
        b.type,
        SUM(b.amount) as total_amount,
        COUNT(*) as count
      FROM bills b
      WHERE b.family_id = ?
    `;
    const params = [req.user.familyId];

    if (type) {
      sql += ' AND b.type = ?';
      params.push(type);
    }

    if (startDate) {
      sql += ' AND b.date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND b.date <= ?';
      params.push(endDate);
    }

    sql += ' GROUP BY b.category, b.type ORDER BY total_amount DESC';

    const categories = await query(sql, params);

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    next(error);
  }
});

// 获取成员统计
router.get('/members', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { startDate, endDate } = req.query;

    let sql = `
      SELECT
        b.member_id,
        u.username,
        u.nickname as member_name,
        SUM(CASE WHEN b.type = 'income' THEN b.amount ELSE 0 END) as total_income,
        SUM(CASE WHEN b.type = 'expense' THEN b.amount ELSE 0 END) as total_expense,
        COUNT(*) as bill_count
      FROM bills b
      LEFT JOIN users u ON b.member_id = u.id
      WHERE b.family_id = ?
    `;
    const params = [req.user.familyId];

    if (startDate) {
      sql += ' AND b.date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND b.date <= ?';
      params.push(endDate);
    }

    sql += ' GROUP BY b.member_id, u.username, u.nickname ORDER BY total_expense DESC';

    const members = await query(sql, params);

    res.json({
      success: true,
      data: members
    });
  } catch (error) {
    next(error);
  }
});

// 获取单条账单
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const bills = await query(
      `SELECT b.*, u.username, u.nickname as member_name
       FROM bills b
       LEFT JOIN users u ON b.member_id = u.id
       WHERE b.id = ? AND b.family_id = ?`,
      [id, req.user.familyId]
    );

    if (bills.length === 0) {
      return res.status(404).json({
        success: false,
        message: '账单不存在'
      });
    }

    res.json({
      success: true,
      data: bills[0]
    });
  } catch (error) {
    next(error);
  }
});

// 创建账单
router.post('/', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { type, amount, category, date, memberId, payment, note, imageUrl } = req.body;

    // 验证必填字段
    if (!type || !amount || !category || !date) {
      return res.status(400).json({
        success: false,
        message: '类型、金额、分类和日期为必填项'
      });
    }

    if (!['income', 'expense'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: '类型必须是 income 或 expense'
      });
    }

    const billId = generateUUID();
    await execute(
      `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, image_url, family_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        billId,
        type,
        amount,
        category,
        date,
        memberId || req.user.id,
        payment || null,
        note || null,
        imageUrl || null,
        req.user.familyId
      ]
    );

    res.status(201).json({
      success: true,
      message: '账单创建成功',
      data: { id: billId }
    });
  } catch (error) {
    next(error);
  }
});

// 批量创建账单
router.post('/batch', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { bills } = req.body;

    if (!Array.isArray(bills) || bills.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请提供账单数组'
      });
    }

    const results = [];
    for (const bill of bills) {
      const { type, amount, category, date, memberId, payment, note, imageUrl } = bill;

      if (!type || !amount || !category || !date) {
        continue;
      }

      const billId = generateUUID();
      await execute(
        `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, image_url, family_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billId,
          type,
          amount,
          category,
          date,
          memberId || req.user.id,
          payment || null,
          note || null,
          imageUrl || null,
          req.user.familyId
        ]
      );
      results.push(billId);
    }

    res.status(201).json({
      success: true,
      message: `成功创建 ${results.length} 条账单`,
      data: { createdCount: results.length, ids: results }
    });
  } catch (error) {
    next(error);
  }
});

// 更新账单
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, amount, category, date, memberId, payment, note, imageUrl } = req.body;

    // 检查账单是否存在
    const existingBills = await query(
      'SELECT id FROM bills WHERE id = ? AND family_id = ?',
      [id, req.user.familyId]
    );

    if (existingBills.length === 0) {
      return res.status(404).json({
        success: false,
        message: '账单不存在'
      });
    }

    // 构建更新语句
    const updates = [];
    const params = [];

    if (type !== undefined) {
      updates.push('type = ?');
      params.push(type);
    }
    if (amount !== undefined) {
      updates.push('amount = ?');
      params.push(amount);
    }
    if (category !== undefined) {
      updates.push('category = ?');
      params.push(category);
    }
    if (date !== undefined) {
      updates.push('date = ?');
      params.push(date);
    }
    if (memberId !== undefined) {
      updates.push('member_id = ?');
      params.push(memberId);
    }
    if (payment !== undefined) {
      updates.push('payment = ?');
      params.push(payment);
    }
    if (note !== undefined) {
      updates.push('note = ?');
      params.push(note);
    }
    if (imageUrl !== undefined) {
      updates.push('image_url = ?');
      params.push(imageUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有需要更新的字段'
      });
    }

    params.push(id);
    await execute(
      `UPDATE bills SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      success: true,
      message: '账单更新成功'
    });
  } catch (error) {
    next(error);
  }
});

// 删除账单
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await execute(
      'DELETE FROM bills WHERE id = ? AND family_id = ?',
      [id, req.user.familyId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '账单不存在'
      });
    }

    res.json({
      success: true,
      message: '账单删除成功'
    });
  } catch (error) {
    next(error);
  }
});

// 批量删除账单
router.delete('/', authenticate, async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请提供要删除的账单ID数组'
      });
    }

    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `DELETE FROM bills WHERE id IN (${placeholders}) AND family_id = ?`,
      [...ids, req.user.familyId]
    );

    res.json({
      success: true,
      message: `成功删除 ${result.affectedRows} 条账单`
    });
  } catch (error) {
    next(error);
  }
});

export default router;
