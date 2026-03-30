import express from 'express';
import https from 'https';
import { query, execute, generateUUID } from '../db.js';
import { authenticate, authorize } from '../middleware/auth.js';

const APPID  = process.env.WECHAT_APPID;
const SECRET = process.env.WECHAT_SECRET;

// 获取 access_token（带缓存）
let _wxToken = null, _wxTokenExpire = 0;
async function getWxAccessToken() {
  if (_wxToken && Date.now() < _wxTokenExpire) return _wxToken;
  return new Promise((resolve, reject) => {
    https.get(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`,
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.access_token) {
              _wxToken = j.access_token;
              _wxTokenExpire = Date.now() + (j.expires_in - 60) * 1000;
              resolve(_wxToken);
            } else {
              reject(new Error(j.errmsg || '获取 access_token 失败'));
            }
          } catch(e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

// 生成小程序码（返回 buffer）
async function genMiniQRCode(scene, page = 'pages/family/family') {
  const token = await getWxAccessToken();
  const body = JSON.stringify({ scene, page, width: 430, auto_color: false, line_color: { r: 99, g: 102, b: 241 } });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: `/wxa/getwxacodeunlimit?access_token=${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 如果是 JSON 则说明报错了
        const first = buf.slice(0, 1).toString();
        if (first === '{') {
          try {
            const err = JSON.parse(buf.toString());
            reject(new Error(err.errmsg || '生成小程序码失败'));
          } catch(e) { reject(new Error('生成小程序码失败')); }
        } else {
          resolve(buf); // 正常是 PNG 二进制
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const router = express.Router();

// 生成邀请码
const generateInviteCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// 创建家庭
router.post('/', authenticate, async (req, res, next) => {
  try {
    // 如果已有家庭，不能创建
    if (req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '您已加入家庭，请先退出当前家庭'
      });
    }

    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: '家庭名称为必填项'
      });
    }

    const familyId = generateUUID();
    const inviteCode = generateInviteCode();

    await execute(
      'INSERT INTO families (id, name, admin_id, invite_code, description) VALUES (?, ?, ?, ?, ?)',
      [familyId, name, req.user.id, inviteCode, description || null]
    );

    // 将创建者加入家庭并设为管理员
    await execute(
      'UPDATE users SET family_id = ?, role = ? WHERE id = ?',
      [familyId, 'admin', req.user.id]
    );

    res.status(201).json({
      success: true,
      message: '家庭创建成功',
      data: {
        id: familyId,
        name,
        inviteCode,
        description
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取当前家庭信息
router.get('/current', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(404).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const families = await query(
      'SELECT * FROM families WHERE id = ?',
      [req.user.familyId]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    // 获取家庭成员数量
    const members = await query(
      'SELECT COUNT(*) as count FROM users WHERE family_id = ?',
      [req.user.familyId]
    );

    // 获取家庭成员列表
    const memberList = await query(
      'SELECT id, username, nickname, avatar, role, created_at FROM users WHERE family_id = ?',
      [req.user.familyId]
    );

    res.json({
      success: true,
      data: {
        ...families[0],
        memberCount: members[0].count,
        members: memberList
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取指定家庭信息
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const families = await query(
      'SELECT * FROM families WHERE id = ?',
      [id]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    // 获取成员数量
    const members = await query(
      'SELECT COUNT(*) as count FROM users WHERE family_id = ?',
      [id]
    );

    res.json({
      success: true,
      data: {
        ...families[0],
        memberCount: members[0].count
      }
    });
  } catch (error) {
    next(error);
  }
});

// 更新家庭信息
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    // 权限检查：只有家庭管理员可以更新
    if (req.user.familyId !== id) {
      return res.status(403).json({
        success: false,
        message: '无权操作'
      });
    }

    // 检查是否是管理员
    const families = await query(
      'SELECT admin_id FROM families WHERE id = ?',
      [id]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    if (families[0].admin_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '只有家庭管理员可以更新家庭信息'
      });
    }

    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有需要更新的字段'
      });
    }

    params.push(id);
    await execute(
      `UPDATE families SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      success: true,
      message: '家庭信息更新成功'
    });
  } catch (error) {
    next(error);
  }
});

// 邀请成员
router.post('/invite', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    // 检查是否是管理员
    const families = await query(
      'SELECT admin_id, invite_code FROM families WHERE id = ?',
      [req.user.familyId]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    // 生成新的邀请码
    const newInviteCode = generateInviteCode();
    await execute(
      'UPDATE families SET invite_code = ? WHERE id = ?',
      [newInviteCode, req.user.familyId]
    );

    res.json({
      success: true,
      message: '邀请码已生成',
      data: {
        inviteCode: newInviteCode
      }
    });
  } catch (error) {
    next(error);
  }
});

// 加入家庭
router.post('/join', authenticate, async (req, res, next) => {
  try {
    if (req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '您已加入家庭，请先退出当前家庭'
      });
    }

    const { inviteCode } = req.body;

    if (!inviteCode) {
      return res.status(400).json({
        success: false,
        message: '邀请码为必填项'
      });
    }

    // 查找家庭
    const families = await query(
      'SELECT * FROM families WHERE invite_code = ?',
      [inviteCode.toUpperCase()]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '邀请码无效'
      });
    }

    const family = families[0];

    // 将用户加入家庭
    await execute(
      'UPDATE users SET family_id = ? WHERE id = ?',
      [family.id, req.user.id]
    );

    // 创建加入通知
    const notificationId = generateUUID();
    await execute(
      'INSERT INTO notifications (id, type, title, content, recipient_id, sender_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        notificationId,
        'family_join',
        '新成员加入',
        `用户 ${req.user.nickname || req.user.username} 已加入家庭`,
        family.admin_id,
        req.user.id
      ]
    );

    res.json({
      success: true,
      message: '成功加入家庭',
      data: {
        familyId: family.id,
        familyName: family.name
      }
    });
  } catch (error) {
    next(error);
  }
});

// 退出家庭
router.post('/leave', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    // 检查是否是管理员
    const families = await query(
      'SELECT admin_id FROM families WHERE id = ?',
      [req.user.familyId]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    // 如果是管理员，不能直接退出
    if (families[0].admin_id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: '管理员不能退出家庭，请先转移管理员权限或解散家庭'
      });
    }

    // 退出家庭
    await execute(
      'UPDATE users SET family_id = NULL WHERE id = ?',
      [req.user.id]
    );

    res.json({
      success: true,
      message: '已退出家庭'
    });
  } catch (error) {
    next(error);
  }
});

// 解散家庭（管理员）
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // 权限检查
    if (req.user.familyId !== id) {
      return res.status(403).json({
        success: false,
        message: '无权操作'
      });
    }

    const families = await query(
      'SELECT admin_id FROM families WHERE id = ?',
      [id]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    if (families[0].admin_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '只有家庭管理员可以解散家庭'
      });
    }

    // 解散家庭（用户的family_id会通过外键级联设置为NULL）
    await execute('DELETE FROM families WHERE id = ?', [id]);

    res.json({
      success: true,
      message: '家庭已解散'
    });
  } catch (error) {
    next(error);
  }
});

// 移除成员（管理员）
router.delete('/:id/members/:memberId', authenticate, async (req, res, next) => {
  try {
    const { id, memberId } = req.params;

    // 权限检查
    if (req.user.familyId !== id) {
      return res.status(403).json({
        success: false,
        message: '无权操作'
      });
    }

    const families = await query(
      'SELECT admin_id FROM families WHERE id = ?',
      [id]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    if (families[0].admin_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '只有家庭管理员可以移除成员'
      });
    }

    // 不能移除自己
    if (memberId === req.user.id) {
      return res.status(400).json({
        success: false,
        message: '不能移除自己'
      });
    }

    // 移除成员
    await execute(
      'UPDATE users SET family_id = NULL WHERE id = ? AND family_id = ?',
      [memberId, id]
    );

    res.json({
      success: true,
      message: '成员已移除'
    });
  } catch (error) {
    next(error);
  }
});

// 转移管理员权限
router.post('/:id/transfer-admin', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newAdminId } = req.body;

    if (!newAdminId) {
      return res.status(400).json({
        success: false,
        message: '请指定新管理员ID'
      });
    }

    // 权限检查
    if (req.user.familyId !== id) {
      return res.status(403).json({
        success: false,
        message: '无权操作'
      });
    }

    const families = await query(
      'SELECT admin_id FROM families WHERE id = ?',
      [id]
    );

    if (families.length === 0) {
      return res.status(404).json({
        success: false,
        message: '家庭不存在'
      });
    }

    if (families[0].admin_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '只有当前管理员可以转移权限'
      });
    }

    // 检查新管理员是否是家庭成员
    const members = await query(
      'SELECT id FROM users WHERE id = ? AND family_id = ?',
      [newAdminId, id]
    );

    if (members.length === 0) {
      return res.status(400).json({
        success: false,
        message: '指定用户不是家庭成员'
      });
    }

    // 更新管理员
    await execute('UPDATE families SET admin_id = ? WHERE id = ?', [newAdminId, id]);
    await execute('UPDATE users SET role = ? WHERE id = ?', ['admin', newAdminId]);
    await execute('UPDATE users SET role = ? WHERE id = ?', ['member', req.user.id]);

    res.json({
      success: true,
      message: '管理员权限已转移'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/families/qrcode - 生成带邀请码的小程序码（base64 PNG）
router.get('/qrcode', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '您未加入家庭' });
    }
    const families = await query('SELECT invite_code, name FROM families WHERE id = ?', [req.user.familyId]);
    if (!families.length) return res.status(404).json({ success: false, message: '家庭不存在' });
    const { invite_code, name } = families[0];

    // scene 最长 32 字节，用邀请码即可
    const scene = invite_code;
    const imgBuf = await genMiniQRCode(scene, 'pages/family/family');
    const base64 = imgBuf.toString('base64');

    res.json({
      success: true,
      data: {
        base64: `data:image/png;base64,${base64}`,
        inviteCode: invite_code,
        familyName: name,
      }
    });
  } catch (err) {
    console.error('[QRCode] 生成失败:', err.message);
    // 若 appid/secret 未配置或 API 调用失败，返回友好错误
    res.json({
      success: false,
      message: '小程序码生成失败：' + err.message,
    });
  }
});

export default router;
