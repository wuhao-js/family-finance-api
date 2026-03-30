const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ hostname: 'localhost', port: 3001, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

(async () => {
  // 1. 健康检查
  const h = await req('GET', '/health');
  console.log('健康检查:', h.status === 200 ? '✅' : '❌', JSON.stringify(h.body).slice(0, 60));

  // 2. 登录
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const token = login.body.token || login.body.data?.token;
  console.log('登录:', login.status === 200 ? '✅' : '❌', '用户:', login.body.user ? login.body.user.nickname : JSON.stringify(login.body).slice(0, 80));

  if (!token) { console.log('❌ 无法获取 token，终止测试'); return; }

  // 3. 账单列表
  const bills = await req('GET', '/api/bills', null, token);
  console.log('账单列表:', bills.status === 200 ? '✅' : '❌', bills.body.bills ? bills.body.bills.length + '条' : JSON.stringify(bills.body).slice(0, 100));

  // 4. 新增账单
  const add = await req('POST', '/api/bills', { type: 'expense', amount: 66, category: '餐饮美食', date: '2026-03-25', note: '测试新增' }, token);
  console.log('新增账单:', (add.status === 200 || add.status === 201) ? '✅' : '❌', JSON.stringify(add.body).slice(0, 100));
  const newId = add.body.id || add.body.bill?.id;

  // 5. 删除账单
  if (newId) {
    const del = await req('DELETE', '/api/bills/' + newId, null, token);
    console.log('删除账单:', del.status === 200 ? '✅' : '❌', JSON.stringify(del.body).slice(0, 60));
  }

  // 6. 帖子列表
  const posts = await req('GET', '/api/posts', null, token);
  console.log('帖子列表:', posts.status === 200 ? '✅' : '❌', Array.isArray(posts.body) ? posts.body.length + '条' : JSON.stringify(posts.body).slice(0, 100));

  // 7. 发布帖子
  const post = await req('POST', '/api/posts', { content: '测试发帖', tag: 'normal' }, token);
  console.log('发布帖子:', (post.status === 200 || post.status === 201) ? '✅' : '❌', JSON.stringify(post.body).slice(0, 100));
  const postId = post.body.id || post.body.post?.id;

  // 8. 删除帖子
  if (postId) {
    const delP = await req('DELETE', '/api/posts/' + postId, null, token);
    console.log('删除帖子:', delP.status === 200 ? '✅' : '❌');
  }

  console.log('\n测试完成！');
})().catch(e => console.error('❌ 测试出错:', e.message));
