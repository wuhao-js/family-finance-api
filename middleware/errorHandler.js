// 错误处理中间件

export const errorHandler = (err, req, res, next) => {
  console.error('错误详情:', err);

  // Mysql2 错误码处理
  if (err.code) {
    switch (err.code) {
      case 'ER_DUP_ENTRY':
        return res.status(400).json({
          success: false,
          message: '数据已存在，请勿重复提交'
        });
      case 'ER_NO_REFERENCED_ROW_2':
        return res.status(400).json({
          success: false,
          message: '关联数据不存在'
        });
      case 'ER_ROW_IS_REFERENCED_2':
        return res.status(400).json({
          success: false,
          message: '该数据被其他数据引用，无法删除'
        });
    }
  }

  // JWT 错误
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: '无效的令牌'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: '令牌已过期'
    });
  }

  // 验证错误
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }

  // 默认错误响应
  const statusCode = err.statusCode || 500;
  const message = err.message || '服务器内部错误';

  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production' && statusCode === 500
      ? '服务器内部错误'
      : message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
};

export default errorHandler;
