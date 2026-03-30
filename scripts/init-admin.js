/**
 * 初始化 admin 用户并创建家庭
 */
import { initDatabase, query, execute, generateUUID, flushSave } from '../db.js';
import bcrypt from 'bcryptjs';

async function init() {
  await initDatabase();

  // 检查是否已有 admin
  const existing = await query("SELECT id FROM users WHERE username = 'admin'");
  if (existing.length > 0) {
    console.log('✅ admin 用户已存在，跳过初始化');
    process.exit(0);
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // 先创建 admin 用户（不带 family_id）
  const adminId = generateUUID();
  const pwHash = await bcrypt.hash('admin123', 10);
  await execute(
    `INSERT INTO users (id, username, password_hash, nickname, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [adminId, 'admin', pwHash, '管理员', 'admin', 1, now]
  );
  console.log('✅ admin 用户创建成功：admin / admin123');

  // 创建家庭（带 admin_id）
  const familyId = generateUUID();
  await execute(
    `INSERT INTO families (id, name, admin_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)`,
    [familyId, '我的家庭', adminId, 'FAM001', now]
  );
  console.log('✅ 家庭已创建，邀请码: FAM001');

  // 更新 admin 的 family_id
  await execute(`UPDATE users SET family_id = ? WHERE id = ?`, [familyId, adminId]);

  // 创建演示账单
  const cats = ['餐饮', '交通', '购物', '水电气费', '娱乐'];
  const today = new Date();
  for (let i = 0; i < 5; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i * 2);
    const dateStr = d.toISOString().split('T')[0];
    await execute(
      `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, family_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateUUID(), 'expense', parseFloat((30 + Math.random() * 200).toFixed(2)),
       cats[i], dateStr, adminId, '微信支付', '演示数据', familyId, now]
    );
  }
  // 收入
  const firstDay = today.toISOString().split('T')[0].slice(0, 7) + '-01';
  await execute(
    `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, family_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generateUUID(), 'income', 8000, '工资', firstDay, adminId, '银行卡', '本月工资', familyId, now]
  );
  console.log('✅ 演示账单已创建 (6 条)');

  // 创建演示帖子
  await execute(
    `INSERT INTO posts (id, content, type, author_id, family_id, likes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateUUID(), '大家好！欢迎来到家庭圈 🎉', 'normal', adminId, familyId, 0, now]
  );
  await execute(
    `INSERT INTO posts (id, content, type, author_id, family_id, likes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateUUID(), '⚠️ 提醒：本月水电费还没交，记得月底前缴费！', 'remind', adminId, familyId, 0, now]
  );
  console.log('✅ 演示帖子已创建 (2 条)');

  console.log('\n🎉 初始化完成！');
  console.log('   登录账号: admin / admin123');
  console.log('   家庭邀请码: FAM001');

  // 强制写盘后退出
  await flushSave();
  process.exit(0);
}

init().catch(e => { console.error('❌ 初始化失败:', e.message); process.exit(1); });
