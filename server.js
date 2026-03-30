import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 路由导入
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import billRoutes from './routes/bills.js';
import familyRoutes from './routes/families.js';
import postRoutes from './routes/posts.js';
import notificationRoutes from './routes/notifications.js';
import exportRoutes from './routes/export.js';
import backupRoutes from './routes/backup.js';
import budgetRoutes from './routes/budgets.js';
import aiRoutes from './routes/ai.js';
import wechatBillRoutes from './routes/wechat-bill.js';
import summaryRoutes from './routes/summary.js';
import notifyRoutes from './routes/notify.js';

// 中间件
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFound.js';

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS配置 - 支持动态来源（ngrok/局域网/自定义域名）
const allowedOriginPatterns = [
  /^http:\/\/localhost:\d+$/,         // 本地开发
  /^http:\/\/127\.0\.0\.1:\d+$/,      // 本地IP
  /^https?:\/\/.*\.ngrok\.io$/,       // ngrok
  /^https?:\/\/.*\.ngrok-free\.app$/, // ngrok free tier
  /^https?:\/\/.*\.loca\.lt$/,        // localtunnel
  /^https?:\/\/.*\.serveo\.net$/,     // serveo
];

// 从环境变量追加自定义域名
const customOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    // 无 origin（Server-to-Server / curl）或开发模式放行
    if (!origin) return callback(null, true);

    // 自定义白名单
    if (customOrigins.includes(origin)) return callback(null, true);

    // 正则匹配
    const allowed = allowedOriginPatterns.some(pattern => pattern.test(origin));
    if (allowed) return callback(null, true);

    // 开发模式下全部放行，生产模式下拒绝
    if (process.env.NODE_ENV !== 'production') return callback(null, true);

    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// 压缩
app.use(compression());

// 日志
app.use(morgan('combined'));

// 解析JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 限流（开发/测试环境 1000次/15min，生产环境 200次/15min）
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 200 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '请求过于频繁，请稍后再试' },
  skip: (req) => {
    // 健康检查不计入限流
    return req.path === '/health';
  },
});
app.use('/api', limiter);

// 静态文件 - 头像图片（供小程序访问 /avatars/*.jpg）
app.use('/avatars', express.static(path.join(__dirname, 'public', 'avatars')));

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/families', familyRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/wechat-bill', wechatBillRoutes);
app.use('/api/summary', summaryRoutes);
app.use('/api/notify', notifyRoutes);

// 根路径
app.get('/', (req, res) => {
  res.json({
    message: '家庭账单系统 API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api',
      export: '/api/export',
      backup: '/api/backup'
    }
  });
});

// 错误处理
app.use(notFoundHandler);
app.use(errorHandler);

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库
    const { initDatabase } = await import('./db.js');
    await initDatabase();

    // 启动定时推送调度器
    const { startScheduler } = await import('./scheduler.js');
    startScheduler();

    app.listen(PORT, () => {
      console.log(`
  ╔═════════════════════════════════════════════╗
  ║   家庭账单系统 - API服务                      ║
  ╚═════════════════════════════════════════════╝

  🚀 服务器运行中...
  📍 http://localhost:${PORT}
  🌍 环境: ${process.env.NODE_ENV || 'development'}
  📊 健康检查: http://localhost:${PORT}/health
  💾 数据库: ${process.env.DB_TYPE || 'sqlite'}

      `);
    });
  } catch (error) {
    console.error('服务器启动失败:', error);
    process.exit(1);
  }
}

startServer();

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号,正在关闭服务器...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT 信号,正在关闭服务器...');
  process.exit(0);
});

export default app;
