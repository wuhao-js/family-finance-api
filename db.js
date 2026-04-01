import dotenv from 'dotenv';
dotenv.config();

const DB_TYPE = process.env.DB_TYPE || 'sqlite'; // 'sqlite' | 'mysql' | 'postgres'

// UUID 生成器（提前定义，供内部初始化使用）
const generateUUIDInternal = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// ==================== SQLite 适配器（better-sqlite3，原生文件数据库） ====================
// better-sqlite3 是同步 API，所有读写直接写入磁盘文件，进程崩溃/重启不丢数据
import BetterSQLite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let db = null;
let isInitialized = false;

const DB_FILE = process.env.SQLITE_DB_PATH || './data/family_finance.db';

function getDB() {
  if (db) return db;
  // 确保目录存在
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new BetterSQLite3(DB_FILE);
  // 启用 WAL 模式（并发性能更好）和外键约束
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  console.log('[SQLite] 数据库已连接:', DB_FILE);
  return db;
}

// 同步查询，返回行数组
function sqliteQuery(sql, params = []) {
  const database = getDB();
  const normalized = normalizeSQL(sql); // SQLite 模式下去掉 ?::text 等非兼容语法
  const stmt = database.prepare(normalized);
  return stmt.all(...params.map(p => p === undefined ? null : p));
}

// 同步执行写操作
function sqliteExecute(sql, params = []) {
  const database = getDB();
  const normalized = normalizeSQL(sql); // SQLite 模式下去掉 ?::text 等非兼容语法
  const stmt = database.prepare(normalized);
  const info = stmt.run(...params.map(p => p === undefined ? null : p));
  return { affectedRows: info.changes, insertId: info.lastInsertRowid };
}

async function initSQLiteSchema() {
  const database = getDB();
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      phone TEXT,
      password_hash TEXT NOT NULL DEFAULT '',
      nickname TEXT,
      avatar TEXT,
      role TEXT DEFAULT 'member',
      family_id TEXT,
      wechat_openid TEXT,
      last_login_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      member_id TEXT NOT NULL,
      payment TEXT,
      note TEXT,
      image_url TEXT,
      family_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'normal',
      author_id TEXT NOT NULL,
      family_id TEXT NOT NULL,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      recipient_id TEXT NOT NULL,
      sender_id TEXT,
      post_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      category TEXT NOT NULL,
      budget_amount REAL NOT NULL,
      period TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(family_id, category, period)
    );
  `;

  // better-sqlite3 用 exec() 一次执行整段 DDL（比逐句 run 更高效）
  database.exec(schema);

  // === Migration：给老数据库补新列 ===
  const migrations = [
    "ALTER TABLE users ADD COLUMN wechat_openid TEXT",
    "CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid)",
    // 微信账单导入支持
    "ALTER TABLE bills ADD COLUMN wechat_trade_no TEXT",
    "ALTER TABLE bills ADD COLUMN source TEXT DEFAULT 'manual'",
    "CREATE INDEX IF NOT EXISTS idx_bills_trade_no ON bills(wechat_trade_no)",
    // 服务通知订阅
    "ALTER TABLE users ADD COLUMN notify_enabled INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN notify_types TEXT DEFAULT '[\"daily\",\"weekly\"]'",
  ];
  for (const sql of migrations) {
    try { database.prepare(sql).run(); } catch (_) { /* 列/索引已存在，忽略 */ }
  }

  console.log('[SQLite] 表结构初始化完成');
}

// ==================== MySQL 适配器 ====================
import mysql from 'mysql2/promise';
let mysqlPool = null;

function getMySQLPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'family_finance',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }
  return mysqlPool;
}

async function mysqlQuery(sql, params = []) {
  const pool = getMySQLPool();
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function mysqlExecute(sql, params = []) {
  const pool = getMySQLPool();
  const [result] = await pool.execute(sql, params);
  return result;
}

async function initMySQL() {
  const pool = getMySQLPool();
  const conn = await pool.getConnection();
  console.log('[MySQL] 数据库连接成功');
  conn.release();
}

// ==================== PostgreSQL 适配器（Supabase / 云数据库）====================
import pg from 'pg';
const { Pool } = pg;
let pgPool = null;

function getPgPool() {
  if (!pgPool) {
    pgPool = new Pool({
      host: process.env.PGHOST || process.env.DB_HOST,
      port: process.env.PGPORT || process.env.DB_PORT || 5432,
      user: process.env.PGUSER || process.env.DB_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
      database: process.env.PGDATABASE || process.env.DB_NAME || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pgPool;
}

// 把 SQLite 语法转成 PostgreSQL 兼容语法
function normalizeSQL(sql) {
  if (DB_TYPE !== 'postgres') {
    // SQLite 模式：去掉所有 ?::type 类型注解（SQLite 不支持 :: 语法）
    return sql.replace(/\?::[a-zA-Z]+/g, '?');
  }
  return sql
    // datetime 函数
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/date\('now'\)/gi, 'CURRENT_DATE')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
    // SQLite strftime → PostgreSQL TO_CHAR
    // strftime('%Y-%m-%d', col) → TO_CHAR(col::date, 'YYYY-MM-DD')
    // strftime('%Y-%m', col)   → TO_CHAR(col::date, 'YYYY-MM')
    // strftime('%Y', col)      → TO_CHAR(col::date, 'YYYY')
    .replace(/strftime\('([^']+)',\s*([^)]+)\)/g, (match, fmt, col) => {
      const pgFmt = fmt
        .replace(/%Y/g, 'YYYY')
        .replace(/%m/g, 'MM')
        .replace(/%d/g, 'DD')
        .replace(/%H/g, 'HH24')
        .replace(/%M/g, 'MI')
        .replace(/%S/g, 'SS');
      const colClean = col.trim();
      return `TO_CHAR(${colClean}::date, '${pgFmt}')`;
    })
    // SQLite 的 IFNULL → COALESCE
    .replace(/\bIFNULL\(/gi, 'COALESCE(')
    // SQLite 的 SUBSTR → SUBSTRING
    .replace(/\bSUBSTR\(/gi, 'SUBSTRING(')
    // SQLite 的 LENGTH → CHAR_LENGTH（已在 PostgreSQL 中兼容，可选）
    // .replace(/\bLENGTH\(/gi, 'CHAR_LENGTH(')
    // SQLite 的 GROUP_CONCAT → STRING_AGG（需同时传分隔符，暂不自动转）
    // JSON 函数（如有需要再补）
    .replace(/\bjson_object\(/gi, 'json_build_object(')
    ;
}

// 把 ? 占位符转成 $1, $2...（适配 pg）
// 注意：? 后面可能跟 ::type 类型注解（如 ?::text），这是有效的 PG 语法，直接保留
function convertPlaceholders(sql) {
  let counter = 0;
  return sql.replace(/\?/g, () => `$${++counter}`);
}

async function pgQuery(sql, params = []) {
  const pool = getPgPool();
  const normalized = normalizeSQL(sql);
  const converted = convertPlaceholders(normalized);
  const result = await pool.query(converted, params);
  return result.rows;
}

async function pgExecute(sql, params = []) {
  const pool = getPgPool();
  const normalized = normalizeSQL(sql);
  const converted = convertPlaceholders(normalized);
  const result = await pool.query(converted, params);
  return { affectedRows: result.rowCount, insertId: null };
}

async function initPostgres() {
  const pool = getPgPool();
  const client = await pool.connect();
  console.log('[PostgreSQL] 数据库连接成功');
  client.release();
}

// PostgreSQL 表结构（适配 Supabase）
async function initPostgresSchema() {
  const pool = getPgPool();
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      phone TEXT,
      password_hash TEXT NOT NULL DEFAULT '',
      nickname TEXT,
      avatar TEXT,
      role TEXT DEFAULT 'member',
      family_id TEXT,
      wechat_openid TEXT,
      last_login_at TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      member_id TEXT NOT NULL,
      payment TEXT,
      note TEXT,
      image_url TEXT,
      family_id TEXT NOT NULL,
      wechat_trade_no TEXT,
      source TEXT DEFAULT 'manual',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'normal',
      author_id TEXT NOT NULL,
      family_id TEXT NOT NULL,
      likes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      recipient_id TEXT NOT NULL,
      sender_id TEXT,
      post_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      category TEXT NOT NULL,
      budget_amount DOUBLE PRECISION NOT NULL,
      period TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(family_id, category, period)
    );
  `;

  // 逐条执行DDL
  for (const stmt of schema.split(';').filter(s => s.trim())) {
    try { await pool.query(stmt); } catch (_) {}
  }

  // Migration：补新列
  const migrations = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid TEXT",
    "CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid)",
    "ALTER TABLE bills ADD COLUMN IF NOT EXISTS wechat_trade_no TEXT",
    "ALTER TABLE bills ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'",
    "CREATE INDEX IF NOT EXISTS idx_bills_trade_no ON bills(wechat_trade_no)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_enabled INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_types TEXT DEFAULT '[\"daily\",\"weekly\"]'",
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (_) {}
  }

  console.log('[PostgreSQL] 表结构初始化完成');
}

// ==================== 自动初始化默认数据 ====================
async function autoSeedIfEmpty() {
  // 检查是否有用户，没有则自动创建 admin
  const users = await query('SELECT id FROM users LIMIT 1');
  if (users.length > 0) return; // 已有数据，跳过

  console.log('[DB] 检测到空数据库，自动初始化默认数据...');
  
  // 用 bcryptjs 生成密码哈希
  let bcrypt;
  try { bcrypt = (await import('bcryptjs')).default; } catch(_) {}
  
  const now = new Date().toISOString();
  const adminId = generateUUIDInternal();
  const pwHash = bcrypt ? await bcrypt.hash('admin123', 10) : 'BCRYPT_UNAVAILABLE';
  const familyId = generateUUIDInternal();

  // 创建 admin 用户（统一使用 ? 占位符，normalizeSQL 会在 PG 模式下自动转 $1,$2...）
  await execute(
    `INSERT INTO users (id, username, password_hash, nickname, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [adminId, 'admin', pwHash, '管理员', 'admin', 1, now, now]
  );

  // 创建家庭
  await execute(
    `INSERT INTO families (id, name, admin_id, invite_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [familyId, '我的家庭', adminId, 'FAM001', now, now]
  );

  // 关联用户和家庭
  await execute(`UPDATE users SET family_id = ? WHERE id = ?`, [familyId, adminId]);

  console.log('[DB] 默认账号已创建: admin / admin123，家庭邀请码: FAM001');
}

// ==================== 统一接口 ====================
let initialized = false;

export const initDatabase = async () => {
  if (initialized) return true;
  if (DB_TYPE === 'mysql') {
    await initMySQL();
  } else if (DB_TYPE === 'postgres') {
    await initPostgres();
    await initPostgresSchema();
    await autoSeedIfEmpty();
  } else {
    await initSQLiteSchema();
    await autoSeedIfEmpty(); // 自动初始化默认数据
  }
  initialized = true;
  return true;
};

export const query = async (sql, params = []) => {
  if (DB_TYPE === 'mysql') return mysqlQuery(sql, params);
  if (DB_TYPE === 'postgres') return pgQuery(sql, params);
  // better-sqlite3 是同步的，但这里包一层 async 保持上层调用方式不变
  return sqliteQuery(sql, params);
};

export const execute = async (sql, params = []) => {
  if (DB_TYPE === 'mysql') return mysqlExecute(sql, params);
  if (DB_TYPE === 'postgres') return pgExecute(sql, params);
  return sqliteExecute(sql, params);
};

export const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export const closePool = async () => {
  // better-sqlite3 关闭连接
  if (db) { try { db.close(); } catch(_) {} db = null; isInitialized = false; }
  if (mysqlPool) { await mysqlPool.end(); mysqlPool = null; }
  if (pgPool) { await pgPool.end(); pgPool = null; }
};

// better-sqlite3 直接写盘，flushSave 保留兼容接口但无需实际操作
export const flushSave = async () => {
  // better-sqlite3 所有写操作已直接落盘，此函数仅保留接口兼容性
};

export default { initDatabase, query, execute, generateUUID, closePool, flushSave };
