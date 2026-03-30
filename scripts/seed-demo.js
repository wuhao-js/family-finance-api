/**
 * 演示数据脚本 - 初始化演示用户和家庭数据
 * 运行: node scripts/seed-demo.js
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { initDatabase, query, execute, generateUUID } from '../db.js';

const DEMO_PASSWORD = 'demo123';

async function seed() {
  console.log('开始初始化演示数据...\n');

  await initDatabase();

  // 检查是否已有演示数据
  const existing = await query("SELECT id FROM users WHERE username = 'demo'");
  if (existing.length > 0) {
    console.log('演示数据已存在，跳过。');
    process.exit(0);
  }

  // 创建管理员账号
  const adminId = generateUUID();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  await execute(
    `INSERT INTO users (id, username, password_hash, nickname, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [adminId, 'demo', passwordHash, '演示用户', 'admin', now]
  );
  console.log(`✓ 管理员账号: demo / ${DEMO_PASSWORD}`);

  // 创建家庭
  const familyId = generateUUID();
  await execute(
    `INSERT INTO families (id, name, admin_id, invite_code, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [familyId, '我的家庭', adminId, 'DEMO001', now]
  );
  console.log(`✓ 家庭已创建: 我的家庭 (邀请码: DEMO001)`);

  // 将管理员加入家庭
  await execute(
    `UPDATE users SET family_id = ? WHERE id = ?`,
    [familyId, adminId]
  );

  // 添加更多家庭成员
  const member1Id = generateUUID();
  const member1Hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await execute(
    `INSERT INTO users (id, username, password_hash, nickname, role, family_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [member1Id, 'zhangsan', member1Hash, '张三', 'member', familyId, now]
  );

  const member2Id = generateUUID();
  const member2Hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await execute(
    `INSERT INTO users (id, username, password_hash, nickname, role, family_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [member2Id, 'lisi', member2Hash, '李四', 'member', familyId, now]
  );
  console.log(`✓ 成员账号: zhangsan / ${DEMO_PASSWORD}`);
  console.log(`✓ 成员账号: lisi / ${DEMO_PASSWORD}`);

  // 添加示例账单（最近 30 天）
  const categories = {
    income: ['工资', '奖金', '投资收益', '副业收入'],
    expense: ['餐饮', '交通', '购物', '娱乐', '医疗', '教育', '房租', '通讯']
  };

  const payments = ['微信支付', '支付宝', '现金', '银行卡'];

  for (let i = 0; i < 25; i++) {
    const billId = generateUUID();
    const isIncome = Math.random() < 0.2;
    const type = isIncome ? 'income' : 'expense';
    const categoryList = categories[type];
    const category = categoryList[Math.floor(Math.random() * categoryList.length)];
    const amount = isIncome
      ? Math.round((3000 + Math.random() * 5000) * 100) / 100
      : Math.round((10 + Math.random() * 500) * 100) / 100;

    const memberId = [adminId, member1Id, member2Id][Math.floor(Math.random() * 3)];
    const payment = payments[Math.floor(Math.random() * payments.length)];
    const daysAgo = Math.floor(Math.random() * 30);
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = date.toISOString().split('T')[0];

    const notes = [
      '', '', '', // 大部分无备注
      '日常生活开支',
      '网购',
      '外出就餐',
      '加油',
      '周末聚会',
      '给孩子报班'
    ];
    const note = notes[Math.floor(Math.random() * notes.length)];

    await execute(
      `INSERT INTO bills (id, type, amount, category, date, member_id, payment, note, family_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [billId, type, amount, category, dateStr, memberId, payment, note, familyId, now]
    );
  }
  console.log(`✓ 随机账单: 25 条（分布在最近 30 天）`);

  // 添加示例帖子
  const posts = [
    { content: '今天买了新电视，大家来看看！', type: 'normal' },
    { content: '提醒：本月的水电费该交了，记得及时缴费哦～', type: 'remind' },
    { content: '下周末家庭聚会，大家有什么建议吗？', type: 'normal' }
  ];

  for (const post of posts) {
    const postId = generateUUID();
    await execute(
      `INSERT INTO posts (id, content, type, author_id, family_id, likes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [postId, post.content, post.type, adminId, familyId, Math.floor(Math.random() * 5), now]
    );
  }
  console.log(`✓ 家庭圈帖子: ${posts.length} 条`);

  console.log('\n========================================');
  console.log('演示数据初始化完成！');
  console.log('========================================');
  console.log('\n登录信息：');
  console.log(`  管理员: demo / ${DEMO_PASSWORD}`);
  console.log(`  成员1:  zhangsan / ${DEMO_PASSWORD}`);
  console.log(`  成员2:  lisi / ${DEMO_PASSWORD}`);
  console.log(`  家庭邀请码: DEMO001`);
  console.log('\n启动后端后访问: http://localhost:3001');
  console.log('');
}

seed().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
