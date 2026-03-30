/**
 * 简单内存缓存工具
 * 用于缓存热点数据，减少数据库查询
 */

class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
  }

  // 获取缓存
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // 检查是否过期
    if (item.expiry && Date.now() > item.expiry) {
      this.delete(key);
      return null;
    }
    
    return item.value;
  }

  // 设置缓存
  set(key, value, ttlSeconds = 300) {
    // 清除旧定时器
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // 设置新值
    this.cache.set(key, {
      value,
      expiry: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
    });

    // 设置过期定时器
    if (ttlSeconds > 0) {
      const timer = setTimeout(() => {
        this.delete(key);
      }, ttlSeconds * 1000);
      this.timers.set(key, timer);
    }
  }

  // 删除缓存
  delete(key) {
    this.cache.delete(key);
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  // 清空缓存
  clear() {
    this.cache.clear();
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }

  // 获取或设置（原子操作）
  async getOrSet(key, factory, ttlSeconds = 300) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttlSeconds);
    return value;
  }

  // 使缓存失效（支持通配符）
  invalidate(pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.delete(key);
      }
    }
  }
}

// 导出单例
export const cache = new MemoryCache();

// 缓存键生成器
export const CacheKeys = {
  user: (id) => `user:${id}`,
  userByUsername: (username) => `user:username:${username}`,
  family: (id) => `family:${id}`,
  familyMembers: (familyId) => `family:${familyId}:members`,
  bills: (familyId, page, limit) => `bills:${familyId}:${page}:${limit}`,
  billStats: (familyId, startDate, endDate) => `stats:${familyId}:${startDate}:${endDate}`,
  posts: (familyId, page) => `posts:${familyId}:${page}`,
  notifications: (userId) => `notifications:${userId}`,
  unreadCount: (userId) => `notifications:${userId}:unread`
};

export default { cache, CacheKeys };
