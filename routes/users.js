import express from 'express';
import { query, execute } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// 获取通知列表
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, isRead } = req.query;
    const offset = (page - 1) * pageSize;

    let sql = `
      SELECT n.*, u.username as sender_username, u.nickname as sender_nickname, u.avatar as sender_avatar
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      WHERE n.recipient_id = ?
    `;
    const params = [req.user.id];

    if (isRead !== undefined) {
      sql += ' AND n.is_read = ?';
      params.push(isRead === 'true');
    }

    // 获取总数
    const countSql = sql.replace(/SELECT n\.\*, u\.username as sender_username, u\.nickname as sender_nickname, u\.avatar as sender_avatar/, 'SELECT COUNT(*) as total');
    const countResult = await query(countSql, params);
    const total = countResult[0].total;

    // 获取未读数
    const unreadResult = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE recipient_id = ?::text AND is_read = FALSE',
      [req.user.id]
    );
    const unreadCount = unreadResult[0].count;

    // 获取分页数据
    sql += ' ORDER BY n.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), offset);

    const notifications = await query(sql, params);

    res.json({
      success: true,
      data: {
        list: notifications,
        unreadCount,
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

// 获取未读通知数
router.get('/unread-count', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE recipient_id = ?::text AND is_read = FALSE',
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        count: result[0].count
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取指定通知
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const notifications = await query(
      `SELECT n.*, u.username as sender_username, u.nickname as sender_nickname, u.avatar as sender_avatar
       FROM notifications n
       LEFT JOIN users u ON n.sender_id = u.id
       WHERE n.id = ? AND n.recipient_id = ?`,
      [id, req.user.id]
    );

    if (notifications.length === 0) {
      return res.status(404).json({
        success: false,
        message: '通知不存在'
      });
    }

    res.json({
      success: true,
      data: notifications[0]
    });
  } catch (error) {
    next(error);
  }
});

// 标记通知为已读
router.put('/:id/read', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    await execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = ?::text AND recipient_id = ?',
      [id, req.user.id]
    );

    res.json({
      success: true,
      message: '通知已标记为已读'
    });
  } catch (error) {
    next(error);
  }
});

// 标记所有通知为已读
router.put('/read-all', authenticate, async (req, res, next) => {
  try {
    await execute(
      'UPDATE notifications SET is_read = TRUE WHERE recipient_id = ?::text',
      [req.user.id]
    );

    res.json({
      success: true,
      message: '所有通知已标记为已读'
    });
  } catch (error) {
    next(error);
  }
});

// 删除通知
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await execute(
      'DELETE FROM notifications WHERE id = ?::text AND recipient_id = ?',
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '通知不存在'
      });
    }

    res.json({
      success: true,
      message: '通知删除成功'
    });
  } catch (error) {
    next(error);
  }
});

// 清空已读通知
router.delete('/', authenticate, async (req, res, next) => {
  try {
    const { clearRead = 'true' } = req.query;

    if (clearRead === 'true') {
      await execute(
        'DELETE FROM notifications WHERE is_read = TRUE AND recipient_id = ?',
        [req.user.id]
      );
      res.json({
        success: true,
        message: '已清空所有已读通知'
      });
    } else {
      // 删除所有通知
      await execute(
        'DELETE FROM notifications WHERE recipient_id = ?::text',
        [req.user.id]
      );
      res.json({
        success: true,
        message: '已清空所有通知'
      });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
