import express from 'express';
import { query, execute, generateUUID } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// ==================== 创建数据备份 ====================
// GET /api/backup/create
// 导出当前家庭的所有数据为 JSON
router.get('/create', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const familyId = req.user.familyId;

    // 并行获取所有数据
    const [family, members, bills, posts] = await Promise.all([
      query('SELECT * FROM families WHERE id = ?::text', [familyId]),
      query(
        'SELECT id, username, nickname, email, role, status, created_at FROM users WHERE family_id = ?::text',
        [familyId]
      ),
      query(
        'SELECT * FROM bills WHERE family_id = ?::text ORDER BY date DESC',
        [familyId]
      ),
      query(
        'SELECT p.*, pc.content as comment_content FROM posts p LEFT JOIN post_comments pc ON p.id = pc.post_id WHERE p.family_id = ? ORDER BY p.created_at DESC',
        [familyId]
      ).catch(() => []) // posts 表可能未创建，容错处理
    ]);

    // 获取帖子评论（单独查询避免重复）
    let comments = [];
    let likes = [];
    try {
      comments = await query(
        'SELECT * FROM post_comments WHERE post_id IN (SELECT id FROM posts WHERE family_id = ?::text)',
        [familyId]
      );
      likes = await query(
        'SELECT * FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE family_id = ?::text)',
        [familyId]
      );
    } catch (_e) {
      // 忽略帖子相关表不存在的错误
    }

    // 组装备份数据包
    const backupData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.id,
      family: family[0] || null,
      members,
      bills,
      posts: posts.filter(p => p.id), // 去重
      comments,
      likes,
      meta: {
        billCount: bills.length,
        memberCount: members.length,
        postCount: posts.filter(p => p.id).length
      }
    };

    const filename = `家庭账单备份_${new Date().toISOString().split('T')[0]}.json`;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(JSON.stringify(backupData, null, 2));
  } catch (error) {
    next(error);
  }
});

// ==================== 获取备份预览信息 ====================
// GET /api/backup/preview
// 不下载文件，返回备份统计信息
router.get('/preview', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const familyId = req.user.familyId;

    const [billCount, memberCount] = await Promise.all([
      query('SELECT COUNT(*) as count FROM bills WHERE family_id = ?::text', [familyId]),
      query('SELECT COUNT(*) as count FROM users WHERE family_id = ?::text', [familyId])
    ]);

    let postCount = [{ count: 0 }];
    try {
      postCount = await query('SELECT COUNT(*) as count FROM posts WHERE family_id = ?::text', [familyId]);
    } catch (_e) { /* 忽略 */ }

    res.json({
      success: true,
      data: {
        billCount: billCount[0].count,
        memberCount: memberCount[0].count,
        postCount: postCount[0].count,
        estimatedSize: `~${Math.ceil((billCount[0].count * 0.5) + (postCount[0].count * 0.2))} KB`
      }
    });
  } catch (error) {
    next(error);
  }
});

// ==================== 恢复数据 ====================
// POST /api/backup/restore
// 从 JSON 备份恢复账单数据（仅管理员）
router.post('/restore', authenticate, async (req, res, next) => {
  try {
    // 仅管理员可执行恢复
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '只有管理员才能执行数据恢复' });
    }

    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const { backupData, mode = 'merge' } = req.body;

    // 验证备份数据格式
    if (!backupData || !backupData.version || !backupData.bills) {
      return res.status(400).json({
        success: false,
        message: '无效的备份数据格式，请确认上传了正确的备份文件'
      });
    }

    // 版本检查
    if (!['1.0.0'].includes(backupData.version)) {
      return res.status(400).json({
        success: false,
        message: `不支持的备份版本 ${backupData.version}`
      });
    }

    const familyId = req.user.familyId;
    let restoredCount = 0;
    let skippedCount = 0;
    const errors = [];

    // mode: 'merge' 跳过已存在的记录, 'overwrite' 覆盖
    if (mode === 'overwrite') {
      // 清空现有账单
      await execute('DELETE FROM bills WHERE family_id = ?::text', [familyId]);
    }

    // 逐条恢复账单
    for (const bill of backupData.bills) {
      try {
        if (!bill.type || !bill.amount || !bill.category || !bill.date) {
          skippedCount++;
          continue;
        }

        if (mode === 'merge') {
          // 检查是否已存在（按 id 去重）
          const existing = await query('SELECT id FROM bills WHERE id = ?::text AND family_id = ?', [bill.id, familyId]);
          if (existing.length > 0) {
            skippedCount++;
            continue;
          }
        }

        const billId = bill.id || generateUUID();
        await execute(
          `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, image_url, family_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             type = VALUES(type), amount = VALUES(amount), category = VALUES(category),
             date = VALUES(date), payment = VALUES(payment), note = VALUES(note)`,
          [
            billId,
            bill.type,
            bill.amount,
            bill.category,
            bill.date,
            bill.member_id || req.user.id,
            bill.payment || null,
            bill.note || null,
            bill.image_url || null,
            familyId,
            bill.created_at || new Date()
          ]
        );
        restoredCount++;
      } catch (err) {
        errors.push({ id: bill.id, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `数据恢复完成`,
      data: {
        restoredCount,
        skippedCount,
        errorCount: errors.length,
        errors: errors.slice(0, 10) // 最多返回前 10 条错误
      }
    });
  } catch (error) {
    next(error);
  }
});

// ==================== 导入账单（CSV/JSON）====================
// POST /api/backup/import
// 从 JSON 数组或 CSV 字符串批量导入账单
router.post('/import', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const { bills: importData, format = 'json' } = req.body;

    if (!Array.isArray(importData) || importData.length === 0) {
      return res.status(400).json({ success: false, message: '请提供要导入的账单数组' });
    }

    const familyId = req.user.familyId;
    let importedCount = 0;
    const errors = [];

    for (const bill of importData) {
      try {
        // 字段映射（支持中文字段名）
        const type = bill.type || (bill['类型'] === '收入' ? 'income' : 'expense') || 'expense';
        const amount = parseFloat(bill.amount || bill['金额']);
        const category = bill.category || bill['分类'] || '其他';
        const date = bill.date || bill['日期'];
        const payment = bill.payment || bill['支付方式'] || null;
        const note = bill.note || bill['备注'] || null;

        if (!amount || isNaN(amount) || !date) {
          errors.push({ row: importedCount + errors.length + 1, error: '金额或日期无效' });
          continue;
        }

        if (!['income', 'expense'].includes(type)) {
          errors.push({ row: importedCount + errors.length + 1, error: '类型无效' });
          continue;
        }

        const billId = generateUUID();
        await execute(
          `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, family_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [billId, type, amount, category, date, req.user.id, payment, note, familyId]
        );
        importedCount++;
      } catch (err) {
        errors.push({ row: importedCount + errors.length + 1, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `成功导入 ${importedCount} 条账单`,
      data: {
        importedCount,
        errorCount: errors.length,
        errors: errors.slice(0, 10)
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
