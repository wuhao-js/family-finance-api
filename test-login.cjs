const http = require('http');
const body = JSON.stringify({ username: 'admin', password: 'admin123' });
const req = http.request({
  hostname: 'localhost', port: 3001,
  path: '/api/auth/login', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, function(res) {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      console.log('登录状态:', j.success ? '✅ 成功' : '❌ 失败', j.message || '');
      console.log('token:', j.data && j.data.token ? '✅ 有' : '❌ 无');
      console.log('user:', j.data && j.data.user ? j.data.user.username + '(' + j.data.user.role + ')' : 'none');
    } catch(e) {
      console.log('响应:', d.slice(0, 200));
    }
  });
});
req.write(body);
req.end();
