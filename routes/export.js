import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * 将账单数据转换为 CSV 字符串
 */
function billsToCSV(bills) {
  const headers = ['日期', '类型', '分类', '金额', '支付方式', '成员', '备注'];
  const rows = bills.map(bill => [
    bill.date ? new Date(bill.date).toISOString().split('T')[0] : '',
    bill.type === 'income' ? '收入' : '支出',
    bill.category || '',
    parseFloat(bill.amount).toFixed(2),
    bill.payment || '',
    bill.member_name || bill.username || '',
    bill.note || ''
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  return '\uFEFF' + csvContent; // 添加 BOM 以支持 Excel 中文显示
}

/**
 * 将账单数据转换为简单 Excel XML（Office Open XML SpreadsheetML）
 * 不依赖 exceljs，使用内置 XML 生成
 */
function billsToExcelXML(bills, title = '账单数据') {
  const headers = ['日期', '类型', '分类', '金额', '支付方式', '成员', '备注'];

  const escapeXML = (str) => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const headerRow = headers
    .map(h => `<Cell><Data ss:Type="String">${escapeXML(h)}</Data></Cell>`)
    .join('');

  const dataRows = bills.map(bill => {
    const cells = [
      bill.date ? new Date(bill.date).toISOString().split('T')[0] : '',
      bill.type === 'income' ? '收入' : '支出',
      bill.category || '',
      parseFloat(bill.amount || 0).toFixed(2),
      bill.payment || '',
      bill.member_name || bill.username || '',
      bill.note || ''
    ];
    return '<Row>' + cells.map(c => `<Cell><Data ss:Type="String">${escapeXML(c)}</Data></Cell>`).join('') + '</Row>';
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="${escapeXML(title)}">
    <Table>
      <Row>${headerRow}</Row>
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

/**
 * 构建账单查询 SQL（可复用筛选条件）
 */
function buildBillQuery(familyId, filters = {}) {
  const { type, category, memberId, startDate, endDate, keyword } = filters;

  let sql = `
    SELECT b.*, u.username, u.nickname as member_name
    FROM bills b
    LEFT JOIN users u ON b.member_id = u.id
    WHERE b.family_id = ?
  `;
  const params = [familyId];

  if (type) { sql += ' AND b.type = ?'; params.push(type); }
  if (category) { sql += ' AND b.category = ?'; params.push(category); }
  if (memberId) { sql += ' AND b.member_id = ?'; params.push(memberId); }
  if (startDate) { sql += ' AND b.date >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND b.date <= ?'; params.push(endDate); }
  if (keyword) {
    sql += ' AND (b.note LIKE ? OR b.category LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY b.date DESC, b.created_at DESC';
  return { sql, params };
}

// ==================== 导出账单为 CSV ====================
// GET /api/export/bills/csv
router.get('/bills/csv', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const { sql, params } = buildBillQuery(req.user.familyId, req.query);
    const bills = await query(sql, params);

    const csv = billsToCSV(bills);
    const filename = `账单_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// ==================== 导出账单为 Excel ====================
// GET /api/export/bills/excel
router.get('/bills/excel', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const { sql, params } = buildBillQuery(req.user.familyId, req.query);
    const bills = await query(sql, params);

    const xml = billsToExcelXML(bills, '账单数据');
    const filename = `账单_${new Date().toISOString().split('T')[0]}.xls`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

// ==================== 导出账单统计汇总为 CSV ====================
// GET /api/export/statistics/csv
router.get('/statistics/csv', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({ success: false, message: '用户未加入家庭' });
    }

    const { startDate, endDate } = req.query;
    let sql = `
      SELECT
        b.category,
        b.type,
        SUM(b.amount) as total_amount,
        COUNT(*) as count
      FROM bills b
      WHERE b.family_id = ?
    `;
    const params = [req.user.familyId];
    if (startDate) { sql += ' AND b.date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND b.date <= ?'; params.push(endDate); }
    sql += ' GROUP BY b.category, b.type ORDER BY b.type, total_amount DESC';

    const stats = await query(sql, params);

    const headers = ['分类', '类型', '总金额', '笔数'];
    const rows = stats.map(s => [
      s.category,
      s.type === 'income' ? '收入' : '支出',
      parseFloat(s.total_amount).toFixed(2),
      s.count
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const csv = '\uFEFF' + csvContent;
    const filename = `账单统计_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

export default router;
