import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute, generateUUID } from '../db.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// 获取用户列表（仅管理员）
router.get('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, keyword, role, familyId } = req.query;
    const offset = (page - 1) * pageSize;

    let sql = 'SELECT id, username, email, phone, nickname, avatar, role, family_id, is_active, last_login_at, created_at FROM users WHERE 1=1';
    const params = [];

    if (keyword) {
      sql += ' AND (username LIKE ? OR email LIKE ? OR nickname LIKE ?)';
      const likeKeyword = `%${keyword}%`;
      params.push(likeKeyword, likeKeyword, likeKeyword);
    }

    if (role) {
      sql += ' AND role = $1';
      params.push(role);
    }

    if (familyId) {
      sql += ' AND family_id = $1';
      params.push(familyId);
    }

    // 获取总数
    const countSql = sql.replace('SELECT id, username, email, phone, nickname, avatar, role, family_id, is_active, last_login_at, created_at', 'SELECT COUNT(*) as total');
    const countResult = await query(countSql, params);
    const total = countResult[0].total;

    // 获取分页数据
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), offset);

    const users = await query(sql, params);

    res.json({
      success: true,
      data: {
        list: users,
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

// 获取家庭成员列表
router.get('/family-members', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const members = await query(
      'SELECT id, username, email, phone, nickname, avatar, role, created_at FROM users WHERE family_id = $1::text ORDER BY created_at ASC',
      [req.user.familyId]
    );

    res.json({
      success: true,
      data: members
    });
  } catch (error) {
    next(error);
  }
});

// 获取指定用户信息
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const users = await query(
      'SELECT id, username, email, phone, nickname, avatar, role, family_id, created_at FROM users WHERE id = $1::text',
      [id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    res.json({
      success: true,
      data: users[0]
    });
  } catch (error) {
    next(error);
  }
});

// 添加用户（管理员）
router.post('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { username, email, phone, password, nickname, role, familyId } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名和密码为必填项'
      });
    }

    // 检查用户名是否已存在
    const existingUser = await query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    if (existingUser.length > 0) {
      return res.status(400).json({
        success: false,
        message: '用户名已存在'
      });
    }

    // 密码加密
    const passwordHash = await bcrypt.hash(password, 10);

    // 创建用户
    const userId = generateUUID();
    await execute(
      'INSERT INTO users (id, username, email, phone, password_hash, nickname, role, family_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, username, email || null, phone || null, passwordHash, nickname || username, role || 'member', familyId || null]
    );

    res.status(201).json({
      success: true,
      message: '用户创建成功',
      data: {
        id: userId,
        username,
        email,
        phone,
        nickname: nickname || username,
        role: role || 'member'
      }
    });
  } catch (error) {
    next(error);
  }
});

// 更新用户信息
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { email, phone, nickname, avatar } = req.body;

    // 权限检查：只能修改自己的信息，除非是管理员
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({
        success: false,
        message: '权限不足'
      });
    }

    // 构建更新语句
    const updates = [];
    const params = [];

    if (email !== undefined) {
      updates.push('email = $1');
      params.push(email);
    }
    if (phone !== undefined) {
      updates.push('phone = $1');
      params.push(phone);
    }
    if (nickname !== undefined) {
      updates.push('nickname = $1');
      params.push(nickname);
    }
    if (avatar !== undefined) {
      updates.push('avatar = $1');
      params.push(avatar);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有需要更新的字段'
      });
    }

    params.push(id);
    await execute(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $1::text`,
      params
    );

    res.json({
      success: true,
      message: '用户信息更新成功'
    });
  } catch (error) {
    next(error);
  }
});

// 删除用户（管理员）
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    // 不能删除自己
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: '不能删除自己的账号'
      });
    }

    const result = await execute('DELETE FROM users WHERE id = $1::text', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    res.json({
      success: true,
      message: '用户删除成功'
    });
  } catch (error) {
    next(error);
  }
});

// 修改用户角色（管理员）
router.put('/:id/role', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role || !['admin', 'member'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: '无效的角色'
      });
    }

    // 不能修改自己的角色
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: '不能修改自己的角色'
      });
    }

    await execute('UPDATE users SET role = $1::text WHERE id = $1::text', [role, id]);

    res.json({
      success: true,
      message: '角色修改成功'
    });
  } catch (error) {
    next(error);
  }
});

// 启用/禁用用户（管理员）
router.put('/:id/status', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    // 不能禁用自己
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: '不能禁用自己的账号'
      });
    }

    await execute('UPDATE users SET is_active = $1 WHERE id = $1::text', [isActive, id]);

    res.json({
      success: true,
      message: isActive ? '用户已启用' : '用户已禁用'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
