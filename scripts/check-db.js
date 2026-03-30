/**
 * 直接查询数据库中的用户列表
 */
import { initDatabase, query } from '../db.js';

async function check() {
  await initDatabase();
  const users = await query('SELECT id, username, nickname, role, family_id FROM users');
  console.log('数据库中的用户:', JSON.stringify(users, null, 2));
  const families = await query('SELECT id, name, admin_id FROM families');
  console.log('数据库中的家庭:', JSON.stringify(families, null, 2));
  process.exit(0);
}

check().catch(e => { console.error('查询失败:', e.message); process.exit(1); });
