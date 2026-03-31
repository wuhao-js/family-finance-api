// routes/ai.js - AI 自动记账解析接口（SiliconFlow LLM 版）
import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multerPkg from 'multer';
const multer = multerPkg;
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const SF_API_KEY = process.env.SILICONFLOW_API_KEY || '';
const SF_MODEL   = process.env.SILICONFLOW_MODEL   || 'deepseek-ai/DeepSeek-V3';

// 支持的分类列表（供 LLM 参考）
const EXPENSE_CATEGORIES = ['餐饮','交通','购物','娱乐','医疗','教育','水电','房租','服装','运动','宠物','旅行','数码','美容','日用','其他支出'];
const INCOME_CATEGORIES  = ['工资','奖金','理财','兼职','红包','报销','其他收入'];

// 今天日期
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 调用 SiliconFlow LLM
async function callLLM(userText) {
  const today = todayStr();
  const systemPrompt = `你是一个家庭账单智能助手，从用户的自然语言中提取账单信息。只返回 JSON，不要任何额外文字或代码块符号。

输出格式：
{"amount":数字,"type":"expense或income","category":"分类名","note":"简短备注最多10字","date":"YYYY-MM-DD"}

判断规则：
- type=income：包含"工资/薪资/奖金/收入/收到/红包/退款/报销/理财/兼职"等词
- type=expense：其他消费支出
- 今天日期：${today}，"昨天"减1天，"上个月"取上月1日

支出分类（必须选一个，不能用其他支出！）：${EXPENSE_CATEGORIES.filter(c => c !== '其他支出').join('、')}、其他支出（实在匹配不到才用）
收入分类（必须选一个）：${INCOME_CATEGORIES.join('、')}

分类选择规则（严格执行）：
- 火锅/外卖/奶茶/咖啡/餐厅/饭/食堂 → 餐饮
- 地铁/公交/打车/滴滴/高铁/飞机/加油/停车 → 交通
- 超市/淘宝/京东/拼多多/商场 → 购物
- 电影/游戏/KTV/演唱会/娱乐 → 娱乐
- 医院/药/看病/挂号/诊所/体检 → 医疗
- 鞋/靴/衣/裤/裙/外套/服装/包/手提包 → 服装
- 健身/跑步/游泳/球/运动 → 运动
- 手机/电脑/平板/耳机/数码 → 数码
- 理发/美发/美甲/护肤/化妆 → 美容
- 猫/狗/宠物/兽医 → 宠物
- 旅游/旅行/酒店/住宿 → 旅行
- 书/课程/培训/学费 → 教育
- 水费/电费/燃气/话费/宽带 → 水电
- 房租/租房/物业/房贷 → 房租

note 要精简：提取商品/地点/人名等关键词，如"耐克跑鞋"、"下午茶"、"滴滴出行"
金额无法识别时 amount 返回 null。`;

  const body = JSON.stringify({
    model: SF_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userText }
    ],
    temperature: 0.1,
    max_tokens: 200,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.siliconflow.cn',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SF_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || 'LLM 错误'));
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('LLM 请求超时')); });
    req.write(body);
    req.end();
  });
}

// 后端二次校正分类（防止 LLM 偷懒用"其他支出"）
const CATEGORY_RECHECK = [
  { keywords: ['鞋','靴','运动鞋','跑鞋','球鞋','皮鞋'], category: '服装' },
  { keywords: ['衣','裤','裙','上衣','外套','羽绒','毛衣','内衣','服装','T恤'], category: '服装' },
  { keywords: ['包','手提包','背包','书包','钱包'], category: '服装' },
  { keywords: ['医院','看病','挂号','诊所','药','药店','体检','牙','牙医','手术'], category: '医疗' },
  { keywords: ['手机壳','手机','电脑','平板','耳机','充电','数码','相机','摄像'], category: '数码' },
  { keywords: ['健身','跑步','游泳','球','羽毛球','乒乓','篮球','足球','瑜伽'], category: '运动' },
  { keywords: ['理发','美发','美甲','护肤','化妆','面膜','口红','美容'], category: '美容' },
  { keywords: ['地铁','公交','打车','滴滴','出租','高铁','火车','飞机','加油','停车','ETC'], category: '交通' },
  { keywords: ['火锅','外卖','餐厅','奶茶','咖啡','饭','食堂','聚餐','烧烤','早餐','午饭','晚饭'], category: '餐饮' },
  { keywords: ['超市','淘宝','京东','拼多多','购物','网购'], category: '购物' },
  { keywords: ['电影','KTV','游戏','演唱会','门票','景区','娱乐'], category: '娱乐' },
  { keywords: ['水费','电费','燃气','话费','宽带','网费'], category: '水电' },
  { keywords: ['房租','租房','物业','房贷'], category: '房租' },
  { keywords: ['猫','狗','宠物','兽医','宠物粮'], category: '宠物' },
  { keywords: ['旅游','旅行','酒店','住宿','景点'], category: '旅行' },
  { keywords: ['书','课程','培训','学费','辅导','教育'], category: '教育' },
  { keywords: ['洗洁精','洗发水','纸巾','日用','生活用品','厨房'], category: '日用' },
];

function recheckCategory(originalText, llmCategory, type) {
  // 只在 LLM 给了"其他支出/其他收入"时才二次校正
  if (!llmCategory.includes('其他')) return llmCategory;
  const text = originalText;
  for (const rule of CATEGORY_RECHECK) {
    if (rule.keywords.some(k => text.includes(k))) return rule.category;
  }
  return llmCategory;
}
const EXPENSE_RULES = [
  { keywords: ['早餐','早饭','早点','豆浆','油条','包子'], category: '餐饮' },
  { keywords: ['午餐','午饭','外卖','点餐','吃饭','餐厅','火锅','烧烤','奶茶','咖啡','食堂','聚餐'], category: '餐饮' },
  { keywords: ['晚餐','晚饭','夜宵','宵夜'], category: '餐饮' },
  { keywords: ['地铁','公交','打车','滴滴','出租','高铁','火车','飞机','机票','加油','停车','ETC'], category: '交通' },
  { keywords: ['超市','淘宝','京东','天猫','拼多多','商场','网购','快递'], category: '购物' },
  { keywords: ['电影','游戏','娱乐','KTV','唱歌','演唱会','景区','旅游','门票'], category: '娱乐' },
  { keywords: ['医院','药','看病','挂号','体检','牙','诊所'], category: '医疗' },
  { keywords: ['学费','培训','课程','教育','辅导'], category: '教育' },
  { keywords: ['水费','电费','燃气','网费','话费','宽带'], category: '水电' },
  { keywords: ['房租','租房','物业','房贷'], category: '房租' },
  { keywords: ['衣服','裤子','鞋','包','服装'], category: '服装' },
  { keywords: ['健身','运动','游泳','跑步'], category: '运动' },
  { keywords: ['猫','狗','宠物','兽医'], category: '宠物' },
  { keywords: ['旅行','出行','酒店','住宿'], category: '旅行' },
  { keywords: ['手机','电脑','数码','维修'], category: '数码' },
  { keywords: ['理发','美容','美发','化妆','护肤'], category: '美容' },
];
const INCOME_RULES = [
  { keywords: ['工资','薪资','发薪'], category: '工资' },
  { keywords: ['奖金','绩效','年终奖','提成'], category: '奖金' },
  { keywords: ['理财','基金','股票','分红','利息'], category: '理财' },
  { keywords: ['兼职','外快','副业'], category: '兼职' },
  { keywords: ['红包','压岁钱','礼金'], category: '红包' },
  { keywords: ['报销','退款','退钱','返现'], category: '报销' },
];
const INCOME_KEYWORDS = ['收入','收到','入账','进账','工资','薪资','奖金','红包','理财','兼职','副业','报销','退款'];

function rulesFallback(text) {
  const isIncome = INCOME_KEYWORDS.some(k => text.includes(k));
  const type = isIncome ? 'income' : 'expense';
  const rules = isIncome ? INCOME_RULES : EXPENSE_RULES;
  let category = isIncome ? '其他收入' : '其他支出';
  for (const rule of rules) {
    if (rule.keywords.some(k => text.includes(k))) { category = rule.category; break; }
  }
  const amtMatch = text.match(/(\d+(?:\.\d{1,2})?)/);
  const amount = amtMatch ? parseFloat(amtMatch[1]) : null;
  return { amount, type, category, note: text.slice(0, 20), date: todayStr() };
}

// 调用视觉模型分析图片（账单/小票/截图）
async function callVisionLLM(base64Image, imageType = 'jpeg') {
  const prompt = `你是一个家庭账单识别助手。请仔细分析这张图片（可能是购物小票、外卖截图、转账记录、账单截图等），提取账单信息。

只返回JSON，格式如下：
{"amount":数字,"type":"expense或income","category":"分类名","note":"简短备注最多15字","date":"YYYY-MM-DD","ocrText":"图片中识别到的关键文字"}

支出分类：${EXPENSE_CATEGORIES.join('、')}
收入分类：${INCOME_CATEGORIES.join('、')}

今天日期：${todayStr()}
如果是收款/转入/工资/退款，type=income。
如果看不到金额，amount 返回 null。
ocrText 填写图片中最关键的文字（商家名、金额、日期等，不超过50字）。`;

  const body = JSON.stringify({
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',  // 支持视觉的免费模型
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/${imageType};base64,${base64Image}` } },
        { type: 'text', text: prompt }
      ]
    }],
    temperature: 0.1,
    max_tokens: 300,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.siliconflow.cn',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SF_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || 'Vision LLM 错误'));
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Vision LLM 请求超时')); });
    req.write(body);
    req.end();
  });
}

// POST /api/ai/parse-bill
router.post('/parse-bill', authenticate, async (req, res, next) => {
  try {
    const { text, imageBase64, imageType } = req.body;

    // ---- 图片识别模式 ----
    if (imageBase64) {
      if (!SF_API_KEY) {
        return res.status(400).json({ success: false, message: '未配置 AI Key，无法识别图片' });
      }
      try {
        const llmResp = await callVisionLLM(imageBase64, imageType || 'jpeg');
        const clean = llmResp.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        // 找 JSON 部分（LLM 可能输出额外文字）
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('未解析到 JSON');
        const result = JSON.parse(jsonMatch[0]);
        result.category = recheckCategory(result.ocrText || '', result.category || '', result.type);

        const allCategories = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];
        if (!allCategories.includes(result.category)) {
          result.category = result.type === 'income' ? '其他收入' : '其他支出';
        }

        return res.json({
          success: true,
          message: result.amount ? '✨ 图片识别成功' : '图片已识别，但未找到金额',
          data: {
            amount: result.amount ? Number(result.amount) : null,
            type: result.type || 'expense',
            category: result.category,
            note: result.note || '',
            date: result.date || todayStr(),
            ocrText: result.ocrText || '',
            confidence: 0.9,
            engine: 'vision',
          }
        });
      } catch (e) {
        console.error('[AI] 图片识别失败:', e.message);
        return res.json({ success: false, message: '图片识别失败：' + e.message, data: null });
      }
    }

    // ---- 文字识别模式 ----
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, message: '缺少 text 或 imageBase64 参数' });
    }

    const t = text.trim();
    let result = null;
    let usedLLM = false;

    // 优先使用 LLM
    if (SF_API_KEY) {
      try {
        const llmResp = await callLLM(t);
        // 清理可能的 markdown 代码块
        const clean = llmResp.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        result = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
        // 二次校正分类
        result.category = recheckCategory(t, result.category || '', result.type);
        usedLLM = true;
      } catch (e) {
        console.warn('[AI] LLM 解析失败，降级到规则引擎:', e.message);
        result = rulesFallback(t);
      }
    } else {
      result = rulesFallback(t);
    }

    if (!result.amount || result.amount <= 0) {
      return res.json({
        success: false,
        message: '未能识别金额，请重新描述（例如：午饭花了38块）',
        data: null,
      });
    }

    // 确保分类合法
    const allCategories = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];
    if (!allCategories.includes(result.category)) {
      result.category = result.type === 'income' ? '其他收入' : '其他支出';
    }

    res.json({
      success: true,
      message: usedLLM ? '✨ AI智能识别成功' : '识别成功（规则引擎）',
      data: {
        amount: Number(result.amount),
        type: result.type || 'expense',
        category: result.category,
        note: result.note || '',
        date: result.date || todayStr(),
        confidence: usedLLM ? 0.95 : 0.75,
        raw: t,
        engine: usedLLM ? 'llm' : 'rules',
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/ai/voice-to-text  语音文件 → 文字（multipart 上传）
// 小程序通过 wx.uploadFile 发送录音 mp3/aac 文件
// ============================================================
const voiceUploadDir = path.join(os.tmpdir(), 'voice-uploads');
if (!fs.existsSync(voiceUploadDir)) {
  fs.mkdirSync(voiceUploadDir, { recursive: true });
}
const upload = multer({
  dest: voiceUploadDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 最大 5MB
});

// 使用 SiliconFlow 语音转写 API（FunAudioLLM/SenseVoiceSmall）
async function callSpeechToText(audioFilePath, mimeType = 'audio/mpeg') {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(audioFilePath);
    const boundary = `----FormBoundary${Date.now()}`;

    // 构造 multipart/form-data 请求体
    const ext = path.extname(audioFilePath).replace('.', '') || 'mp3';
    const filename = `voice.${ext}`;

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const middle = fileBuffer;
    const footer = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `FunAudioLLM/SenseVoiceSmall\r\n` +
      `--${boundary}--\r\n`
    );

    const body = Buffer.concat([header, middle, footer]);

    const req = https.request({
      hostname: 'api.siliconflow.cn',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SF_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || '语音识别失败'));
          resolve(json.text || '');
        } catch(e) { reject(new Error('语音识别响应解析失败: ' + data)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('语音识别请求超时')); });
    req.write(body);
    req.end();
  });
}

router.post('/voice-to-text', authenticate, upload.single('file'), async (req, res, next) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, message: '未收到音频文件，请重新录音' });
  }

  try {
    if (!SF_API_KEY) {
      // 无 API Key 时返回提示
      fs.unlinkSync(file.path);
      return res.json({ success: false, message: '未配置 AI Key，语音识别不可用' });
    }

    // 转写
    const mimeType = file.mimetype || 'audio/mpeg';
    const text = await callSpeechToText(file.path, mimeType);

    // 清理临时文件
    try { fs.unlinkSync(file.path); } catch(e) { /* 忽略 */ }

    if (!text || !text.trim()) {
      return res.json({ success: false, message: '未能识别到语音内容，请重新录音并说清楚' });
    }

    // 转写成功后，顺便用 LLM 解析账单信息
    let billData = null;
    try {
      const llmResp = await callLLM(text.trim());
      const clean = llmResp.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      billData = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
      billData.category = recheckCategory(text, billData.category || '', billData.type);
    } catch(e) {
      // LLM 解析失败时只返回文字，让前端自行处理
      console.warn('[AI] 语音账单解析失败:', e.message);
    }

    res.json({
      success: true,
      message: '语音识别成功',
      data: {
        text: text.trim(),
        bill: billData,
      }
    });
  } catch (err) {
    try { if (file && file.path) fs.unlinkSync(file.path); } catch(e) { /* 忽略 */ }
    console.error('[AI] 语音识别失败:', err.message);
    res.json({ success: false, message: '语音识别失败：' + err.message });
  }
});

export default router;
