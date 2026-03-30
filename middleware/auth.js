import jwt from 'jsonwebtoken';
import { query } from '../db.js';

export const authenticate = async (req, res, next) => {
  try {
    // 从请求头获取token
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: '未提供认证令牌'
      });
    }

    const token = authHeader.substring(7); // 移除 'Bearer ' 前缀

    // 验证token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 从数据库实时查询最新的用户信息（确保 family_id / role 是最新的）
    const users = await query(
      'SELECT id, username, nickname, family_id, role FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }

    const dbUser = users[0];

    // 将用户信息附加到请求对象（优先使用数据库中的实时值）
    req.user = {
      id: dbUser.id,
      username: dbUser.username,
      nickname: dbUser.nickname,
      familyId: dbUser.family_id || null,
      role: dbUser.role || 'member'
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: '令牌已过期'
      });
    }

    return res.status(401).json({
      success: false,
      message: '无效的令牌'
    });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: '未认证'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: '权限不足'
      });
    }

    next();
  };
};

export const verifyFamilyAccess = async (req, res, next) => {
  try {
    // 确保用户只能访问自己家庭的数据
    const { familyId } = req.user;
    const requestedFamilyId = req.params.familyId || req.body.familyId || req.query.familyId;

    if (requestedFamilyId && requestedFamilyId !== familyId) {
      return res.status(403).json({
        success: false,
        message: '无权访问其他家庭的数据'
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};
