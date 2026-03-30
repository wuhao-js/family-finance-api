import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multerPkg from 'multer';
const multer = multerPkg;
import { query, execute, generateUUID } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'family-finance-secret-key-2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// 注册
router.post('/register', async (req, res, next) => {
  try {
    const { username, email, phone, password, nickname } = req.body;

    // 验证必填字段
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

    // 检查邮箱是否已存在
    if (email) {
      const existingEmail = await query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      if (existingEmail.length > 0) {
        return res.status(400).json({
          success: false,
          message: '邮箱已被使用'
        });
      }
    }

    // 密码加密
    const passwordHash = await bcrypt.hash(password, 10);

    // 创建用户
    const userId = generateUUID();
    await execute(
      'INSERT INTO users (id, username, email, phone, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, username, email || null, phone || null, passwordHash, nickname || username, 'member']
    );

    // 生成Token
    const token = jwt.sign(
      { userId, familyId: null, role: 'member' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: {
        token,
        user: {
          id: userId,
          username,
          email,
          phone,
          nickname: nickname || username,
          role: 'member',
          familyId: null
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 登录
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名和密码为必填项'
      });
    }

    // 查询用户
    const users = await query(
      'SELECT * FROM users WHERE username = $1 OR email = $1 OR phone = $1',
      [username, username, username]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    const user = users[0];

    // 验证密码
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    // 检查用户是否激活
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: '账号已被禁用'
      });
    }

    // 更新最后登录时间
    await execute(
      "UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1::text",
      [user.id]
    );

    // 生成Token
    const token = jwt.sign(
      { userId: user.id, familyId: user.family_id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          nickname: user.nickname,
          avatar: user.avatar,
          role: user.role,
          familyId: user.family_id
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 登出
router.post('/logout', authenticate, (req, res) => {
  // 客户端处理Token销毁，服务端只需返回成功
  res.json({
    success: true,
    message: '登出成功'
  });
});

// 获取当前用户信息
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const users = await query(
      'SELECT id, username, email, phone, nickname, avatar, role, family_id, last_login_at, created_at FROM users WHERE id = $1::text',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    const user = users[0];

    // 获取家庭信息
    let family = null;
    if (user.family_id) {
      const families = await query(
        'SELECT id, name, description, invite_code FROM families WHERE id = $1::text',
        [user.family_id]
      );
      if (families.length > 0) {
        family = families[0];
      }
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        nickname: user.nickname,
        avatar: user.avatar,
        role: user.role,
        familyId: user.family_id,
        family,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    next(error);
  }
});

// 修改个人资料（昵称等）
router.put('/profile', authenticate, async (req, res, next) => {
  try {
    const { nickname } = req.body;
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ success: false, message: '昵称不能为空' });
    }
    await execute(
      "UPDATE users SET nickname = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $1::text",
      [nickname.trim(), req.user.id]
    );
    res.json({ success: true, message: '资料更新成功' });
  } catch (error) {
    next(error);
  }
});

// 修改密码
router.put('/password', authenticate, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: '请提供旧密码和新密码'
      });
    }

    // 获取用户当前密码
    const users = await query(
      'SELECT password_hash FROM users WHERE id = $1::text',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 验证旧密码
    const isValidPassword = await bcrypt.compare(oldPassword, users[0].password_hash);
    if (!isValidPassword) {
      return res.status(400).json({
        success: false,
        message: '旧密码错误'
      });
    }

    // 加密新密码并更新
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await execute(
      'UPDATE users SET password_hash = $1 WHERE id = $1::text',
      [newPasswordHash, req.user.id]
    );

    res.json({
      success: true,
      message: '密码修改成功'
    });
  } catch (error) {
    next(error);
  }
});

// ========== 微信小程序登录 ==========
// 流程：前端 wx.login() → code → 后端换 openid → 查/建用户 → 返回 JWT
router.post('/wechat-login', async (req, res, next) => {
  try {
    const { code, nickname, avatarUrl } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: '缺少 code 参数' });
    }

    const APPID = process.env.WECHAT_APPID;
    const SECRET = process.env.WECHAT_SECRET;

    if (!APPID || !SECRET) {
      return res.status(500).json({
        success: false,
        message: '服务器未配置微信 AppID/Secret，请联系管理员'
      });
    }

    // 调用微信 code2session 接口
    const wxRes = await new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${SECRET}&js_code=${code}&grant_type=authorization_code`;
      https.get(url, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk; });
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('微信接口返回格式错误')); }
        });
      }).on('error', reject);
    });

    if (wxRes.errcode) {
      console.error('[WxLogin] code2session 失败:', wxRes);
      return res.status(400).json({
        success: false,
        message: `微信授权失败：${wxRes.errmsg || wxRes.errcode}`
      });
    }

    const openid = wxRes.openid;
    const unionid = wxRes.unionid || null;

    // 查找是否已有绑定该 openid 的用户
    let users = await query(
      'SELECT * FROM users WHERE wechat_openid = $1::text',
      [openid]
    );

    let user;
    let isNewUser = false;

    if (users.length > 0) {
      // 已有账号 → 直接登录，顺便更新昵称/头像
      user = users[0];
      const updates = [];
      const params = [];
      if (nickname && nickname !== user.nickname) {
        updates.push('nickname = $1'); params.push(nickname);
      }
      if (avatarUrl && avatarUrl !== user.avatar) {
        updates.push('avatar = $1'); params.push(avatarUrl);
      }
      updates.push("last_login_at = CURRENT_TIMESTAMP");
      params.push(user.id);
      await execute(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $1::text`,
        params
      );
    } else {
      // 新用户 → 自动创建账号
      isNewUser = true;
      const userId = generateUUID();
      const wxNickname = nickname || `微信用户_${openid.slice(-6)}`;
      const wxUsername = `wx_${openid.slice(-10)}`; // 唯一用户名

      // 确保 users 表有 wechat_openid 列（兼容旧数据库）
      try {
        await execute("ALTER TABLE users ADD COLUMN wechat_openid TEXT", []);
        await execute("CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid)", []);
      } catch {
        // 列已存在，忽略
      }

      await execute(
        `INSERT INTO users (id, username, password_hash, nickname, avatar, wechat_openid, role, is_active, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, 'member', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, wxUsername, wxNickname, avatarUrl || null, openid]
      );

      const newUsers = await query('SELECT * FROM users WHERE id = $1::text', [userId]);
      user = newUsers[0];
    }

    // 重新读取（确保数据最新）
    const freshUsers = await query('SELECT * FROM users WHERE id = $1::text', [user.id]);
    user = freshUsers[0];

    // 生成 JWT
    const token = jwt.sign(
      { userId: user.id, familyId: user.family_id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      message: isNewUser ? '注册并登录成功' : '登录成功',
      data: {
        token,
        isNewUser,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatar: user.avatar,
          role: user.role,
          familyId: user.family_id
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 刷新Token
router.post('/refresh-token', authenticate, async (req, res, next) => {
  try {
    const users = await query(
      'SELECT family_id, role FROM users WHERE id = $1::text',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    const user = users[0];

    // 生成新Token
    const token = jwt.sign(
      { userId: req.user.id, familyId: user.family_id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      data: { token }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/avatar - 上传用户头像（multipart, 保存到 public/avatars/）
const avatarUploadDir = path.join(process.cwd(), 'public', 'avatars');
if (!fs.existsSync(avatarUploadDir)) fs.mkdirSync(avatarUploadDir, { recursive: true });
const avatarUpload = multer({
  dest: avatarUploadDir,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

router.post('/avatar', authenticate, avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: '未收到图片' });
    // 改为 .jpg 扩展名
    const newName = `${req.user.id}_${Date.now()}.jpg`;
    const newPath = path.join(avatarUploadDir, newName);
    fs.renameSync(req.file.path, newPath);

    // 构造访问 URL（后端需要 serve static files for /public/avatars/）
    const baseUrl = process.env.API_BASE_URL || `http://127.0.0.1:3001`;
    const avatarUrl = `${baseUrl}/avatars/${newName}`;

    // 更新数据库
    await execute('UPDATE users SET avatar = $1 WHERE id = $1::text', [avatarUrl, req.user.id]);

    res.json({ success: true, data: { avatarUrl } });
  } catch (err) {
    next(err);
  }
});

export default router;
