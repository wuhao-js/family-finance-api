// 404 处理中间件

export const notFoundHandler = (req, res, next) => {
  const error = new Error(`路由不存在: ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

export default notFoundHandler;
