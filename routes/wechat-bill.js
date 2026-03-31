// routes/wechat-bill.js - 微信账单 CSV 解析导入
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { query, execute, generateUUID } from '../db.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// multer 临时存储
const upload = multer({
  dest: './tmp/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('只支持 CSV 文件'));
    }
  }
});

// 微信支付账单 CSV 字段映射
// 微信账单导出格式（2024版本）：
// 交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
const WECHAT_FIELDS = {
  time: '交易时间',
  type: '交易类型',
  peer: '交易对方',
  goods: '商品',
  direction: '收/支',
  amount: '金额(元)',
  method: '支付方式',
  status: '当前状态',
  tradeNo: '交易单号',
  remark: '备注',
};

// 分类映射（微信商家名 → 账单分类）
const CATEGORY_MAP = [
  { keywords: ['美团','饿了么','肯德基','麦当劳','星巴克','奶茶','外卖','餐饮','饭','食堂','厨房','烧烤','火锅','咖啡','便利店'], cat: '餐饮' },
  { keywords: ['滴滴','地铁','公交','出行','加油','停车','高铁','火车','机票','航空','uber','顺风车'], cat: '交通' },
  { keywords: ['淘宝','天猫','京东','拼多多','当当','苏宁','购物','商城','超市','沃尔玛','永辉','盒马'], cat: '购物' },
  { keywords: ['电影','爱奇艺','优酷','腾讯视频','Netflix','bilibili','哔哩','游戏','KTV','娱乐','门票','景区'], cat: '娱乐' },
  { keywords: ['医院','药店','医疗','诊所','体检','挂号','平安','好大夫'], cat: '医疗' },
  { keywords: ['学费','培训','课程','教育','学而思','新东方','书本','文具'], cat: '教育' },
  { keywords: ['水费','电费','燃气','话费','宽带','电信','联通','移动','网络'], cat: '水电' },
  { keywords: ['房租','物业','房贷','租房','公寓'], cat: '房租' },
  { keywords: ['工资','薪资','发薪','补贴','奖金','绩效'], cat: '工资' },
  { keywords: ['退款','退还','退货'], cat: '报销' },
  { keywords: ['转账','收款','付款'], cat: '转账' },
];

function inferCategory(peer = '', goods = '', direction = '') {
  const text = (peer + goods).toLowerCase();
  for (const rule of CATEGORY_MAP) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) return rule.cat;
    }
  }
  if (direction === '收入') return '其他收入';
  return '其他支出';
}

// 解析微信 CSV 内容（处理 BOM 和编码）
function parseWechatCSV(content) {
  // 去掉 BOM
  content = content.replace(/^\uFEFF/, '');

  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { headers: [], records: [] };

  // 找到 header 行（包含「交易时间」）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    if (lines[i].includes('交易时间')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { headers: [], records: [] };

  const headers = parseCSVLine(lines[headerIdx]);
  const records = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('----')) continue;
    const cols = parseCSVLine(line);
    if (cols.length < headers.length - 2) continue;

    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (cols[idx] || '').trim();
    });

    // 只处理明确的收支
    const direction = row['收/支'] || '';
    if (!['收入', '支出'].includes(direction)) continue;

    // 跳过失败/退款中状态
    const status = row['当前状态'] || '';
    if (status.includes('退款') || status.includes('已退') || status.includes('失败')) continue;

    // 解析金额（去掉 ¥ 符号）
    const amountStr = (row['金额(元)'] || '0').replace(/[¥,\s]/g, '');
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) continue;

    // 解析日期
    const timeStr = row['交易时间'] || '';
    const dateMatch = timeStr.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!dateMatch) continue;
    const date = `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`;

    const peer = row['交易对方'] || '';
    const goods = row['商品'] || '';
    const type = direction === '收入' ? 'income' : 'expense';
    const category = inferCategory(peer, goods, direction);
    const tradeNo = row['交易单号'] || '';

    records.push({ amount, type, category, date, note: goods || peer, peer, tradeNo });
  }

  return { headers, records };
}

function parseCSVLine(line) {
  const cols = [];
  let inQuote = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur);
  return cols;
}

// POST /api/wechat-bill/parse - 预览解析结果（不导入）
router.post('/parse', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: '未收到文件' });

    const content = fs.readFileSync(req.file.path, 'utf-8');
    fs.unlinkSync(req.file.path); // 立即删除临时文件

    const { records } = parseWechatCSV(content);
    if (!records.length) {
      return res.json({ success: false, message: '未解析到有效账单，请确认是微信支付账单 CSV 文件' });
    }

    res.json({
      success: true,
      data: {
        total: records.length,
        preview: records.slice(0, 20),
        records,
      },
      message: `解析成功，共 ${records.length} 条账单`
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    next(err);
  }
});

// POST /api/wechat-bill/import - 正式导入（支持去重）
router.post('/import', authenticate, async (req, res, next) => {
  try {
    const { records, skipDuplicates = true } = req.body;
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ success: false, message: '缺少账单数据' });
    }
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    let imported = 0, skipped = 0;

    for (const r of records) {
      // 去重：相同日期+金额+类型+交易单号
      if (skipDuplicates && r.tradeNo) {
        const exist = await query(
          'SELECT id FROM bills WHERE family_id = ?::text AND wechat_trade_no=?',
          [req.user.familyId, r.tradeNo]
        );
        if (exist.length > 0) { skipped++; continue; }
      }

      const id = generateUUID();
      await execute(
        `INSERT INTO bills (id, family_id, member_id, type, category, amount, note, date, wechat_trade_no, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wechat_import', CURRENT_TIMESTAMP)`,
        [id, req.user.familyId, req.user.id, r.type, r.category, r.amount, r.note || '', r.date, r.tradeNo || null]
      );
      imported++;
    }

    res.json({
      success: true,
      data: { imported, skipped, total: records.length },
      message: `导入完成：${imported} 条成功，${skipped} 条重复跳过`
    });
  } catch (err) {
    next(err);
  }
});

export default router;
