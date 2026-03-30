import express from 'express';
import { query, execute, generateUUID } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// 获取帖子列表
router.get('/', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { page = 1, pageSize = 20, type } = req.query;
    const offset = (page - 1) * pageSize;

    let sql = `
      SELECT p.*, u.username, u.nickname as author_name, u.avatar as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.family_id = ?
    `;
    const params = [req.user.familyId];

    if (type) {
      sql += ' AND p.type = ?';
      params.push(type);
    }

    // 获取总数
    const countSql = sql.replace(/SELECT p\.\*, u\.username, u\.nickname as author_name, u\.avatar as author_avatar/, 'SELECT COUNT(*) as total');
    const countResult = await query(countSql, params);
    const total = countResult[0].total;

    // 获取分页数据
    sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), offset);

    const posts = await query(sql, params);

    // 获取每个帖子的点赞和评论数
    for (const post of posts) {
      const likes = await query(
        'SELECT COUNT(*) as count FROM likes WHERE post_id = ?',
        [post.id]
      );
      post.likeCount = likes[0].count;

      const comments = await query(
        'SELECT COUNT(*) as count FROM comments WHERE post_id = ?',
        [post.id]
      );
      post.commentCount = comments[0].count;

      // 检查当前用户是否已点赞
      const userLiked = await query(
        'SELECT id FROM likes WHERE post_id = ? AND user_id = ?',
        [post.id, req.user.id]
      );
      post.isLiked = userLiked.length > 0;
    }

    res.json({
      success: true,
      data: {
        list: posts,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取指定帖子
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const posts = await query(
      `SELECT p.*, u.username, u.nickname as author_name, u.avatar as author_avatar
       FROM posts p
       LEFT JOIN users u ON p.author_id = u.id
       WHERE p.id = ? AND p.family_id = ?`,
      [id, req.user.familyId]
    );

    if (posts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在'
      });
    }

    const post = posts[0];

    // 获取点赞数
    const likes = await query(
      'SELECT COUNT(*) as count FROM likes WHERE post_id = ?',
      [id]
    );
    post.likeCount = likes[0].count;

    // 检查当前用户是否已点赞
    const userLiked = await query(
      'SELECT id FROM likes WHERE post_id = ? AND user_id = ?',
      [id, req.user.id]
    );
    post.isLiked = userLiked.length > 0;

    // 获取评论列表
    const comments = await query(
      `SELECT c.*, u.username, u.nickname as author_name, u.avatar as author_avatar
       FROM comments c
       LEFT JOIN users u ON c.author_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`,
      [id]
    );
    post.comments = comments;

    res.json({
      success: true,
      data: post
    });
  } catch (error) {
    next(error);
  }
});

// 创建帖子
router.post('/', authenticate, async (req, res, next) => {
  try {
    if (!req.user.familyId) {
      return res.status(400).json({
        success: false,
        message: '用户未加入家庭'
      });
    }

    const { content, type, mentionedUserIds } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        message: '内容为必填项'
      });
    }

    const postId = generateUUID();
    await execute(
      'INSERT INTO posts (id, content, type, author_id, family_id) VALUES (?, ?, ?, ?, ?)',
      [postId, content, type || 'normal', req.user.id, req.user.familyId]
    );

    // 处理@提及
    if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
      for (const userId of mentionedUserIds) {
        const mentionId = generateUUID();
        await execute(
          'INSERT INTO mentions (id, post_id, user_id) VALUES (?, ?, ?)',
          [mentionId, postId, userId]
        );

        // 发送通知
        const notificationId = generateUUID();
        await execute(
          'INSERT INTO notifications (id, type, title, content, recipient_id, sender_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            notificationId,
            'mention',
            '有人@了你',
            `${req.user.nickname || req.user.username} 在帖子中提及了你`,
            userId,
            req.user.id,
            postId
          ]
        );
      }
    }

    res.status(201).json({
      success: true,
      message: '帖子发布成功',
      data: { id: postId }
    });
  } catch (error) {
    next(error);
  }
});

// 更新帖子
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content, type } = req.body;

    // 检查帖子是否存在
    const existingPosts = await query(
      'SELECT author_id FROM posts WHERE id = ? AND family_id = ?',
      [id, req.user.familyId]
    );

    if (existingPosts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在'
      });
    }

    // 权限检查：只有作者可以修改
    if (existingPosts[0].author_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '只有作者可以修改帖子'
      });
    }

    const updates = [];
    const params = [];

    if (content !== undefined) {
      updates.push('content = ?');
      params.push(content);
    }
    if (type !== undefined) {
      updates.push('type = ?');
      params.push(type);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有需要更新的字段'
      });
    }

    params.push(id);
    await execute(
      `UPDATE posts SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({
      success: true,
      message: '帖子更新成功'
    });
  } catch (error) {
    next(error);
  }
});

// 删除帖子
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // 检查帖子是否存在
    const existingPosts = await query(
      'SELECT author_id, family_id FROM posts WHERE id = ?',
      [id]
    );

    if (existingPosts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在'
      });
    }

    // 权限检查：只有作者或家庭管理员可以删除
    const post = existingPosts[0];
    if (post.author_id !== req.user.id && req.user.familyId !== post.family_id) {
      return res.status(403).json({
        success: false,
        message: '无权删除此帖子'
      });
    }

    // 还要检查用户是否是家庭管理员
    if (post.author_id !== req.user.id) {
      const families = await query(
        'SELECT admin_id FROM families WHERE id = ?',
        [post.family_id]
      );
      if (families.length === 0 || families[0].admin_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: '无权删除此帖子'
        });
      }
    }

    await execute('DELETE FROM posts WHERE id = ?', [id]);

    res.json({
      success: true,
      message: '帖子删除成功'
    });
  } catch (error) {
    next(error);
  }
});

// 点赞帖子
router.post('/:id/like', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // 检查帖子是否存在
    const posts = await query(
      'SELECT id, author_id, family_id FROM posts WHERE id = ?',
      [id]
    );

    if (posts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在'
      });
    }

    // 检查是否已点赞
    const existingLike = await query(
      'SELECT id FROM likes WHERE post_id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (existingLike.length > 0) {
      return res.status(400).json({
        success: false,
        message: '已经点赞过'
      });
    }

    // 添加点赞
    const likeId = generateUUID();
    await execute(
      'INSERT INTO likes (id, post_id, user_id) VALUES (?, ?, ?)',
      [likeId, id, req.user.id]
    );

    // 更新帖子点赞数
    await execute(
      'UPDATE posts SET likes = likes + 1 WHERE id = ?',
      [id]
    );

    // 如果不是自己发的帖子，发送通知
    if (posts[0].author_id !== req.user.id) {
      const notificationId = generateUUID();
      await execute(
        'INSERT INTO notifications (id, type, title, content, recipient_id, sender_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          notificationId,
          'like',
          '有人点赞了你的帖子',
          `${req.user.nickname || req.user.username} 点赞了你的帖子`,
          posts[0].author_id,
          req.user.id,
          id
        ]
      );
    }

    res.json({
      success: true,
      message: '点赞成功'
    });
  } catch (error) {
    next(error);
  }
});

// 取消点赞
router.delete('/:id/like', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await execute(
      'DELETE FROM likes WHERE post_id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.affectedRows > 0) {
      await execute(
        'UPDATE posts SET likes = likes - 1 WHERE id = ? AND likes > 0',
        [id]
      );
    }

    res.json({
      success: true,
      message: '取消点赞成功'
    });
  } catch (error) {
    next(error);
  }
});

// 评论帖子
router.post('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content, mentionedUserIds } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        message: '评论内容为必填项'
      });
    }

    // 检查帖子是否存在
    const posts = await query(
      'SELECT id, author_id, family_id FROM posts WHERE id = ?',
      [id]
    );

    if (posts.length === 0) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在'
      });
    }

    const commentId = generateUUID();
    await execute(
      'INSERT INTO comments (id, content, post_id, author_id) VALUES (?, ?, ?, ?)',
      [commentId, content, id, req.user.id]
    );

    // 处理@提及
    if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
      for (const userId of mentionedUserIds) {
        const mentionId = generateUUID();
        await execute(
          'INSERT INTO mentions (id, post_id, user_id) VALUES (?, ?, ?)',
          [mentionId, id, userId]
        );

        // 发送通知
        const notificationId = generateUUID();
        await execute(
          'INSERT INTO notifications (id, type, title, content, recipient_id, sender_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            notificationId,
            'mention',
            '有人@了你',
            `${req.user.nickname || req.user.username} 在评论中提及了你`,
            userId,
            req.user.id,
            id
          ]
        );
      }
    }

    // 发送评论通知给帖子作者
    if (posts[0].author_id !== req.user.id) {
      const notificationId = generateUUID();
      await execute(
        'INSERT INTO notifications (id, type, title, content, recipient_id, sender_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          notificationId,
          'comment',
          '有人评论了你的帖子',
          `${req.user.nickname || req.user.username} 评论了你的帖子`,
          posts[0].author_id,
          req.user.id,
          id
        ]
      );
    }

    res.status(201).json({
      success: true,
      message: '评论成功',
      data: { id: commentId }
    });
  } catch (error) {
    next(error);
  }
});

// 删除评论
router.delete('/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const { commentId } = req.params;

    // 检查评论是否存在
    const comments = await query(
      'SELECT author_id, post_id FROM comments WHERE id = ?',
      [commentId]
    );

    if (comments.length === 0) {
      return res.status(404).json({
        success: false,
        message: '评论不存在'
      });
    }

    const comment = comments[0];

    // 权限检查
    if (comment.author_id !== req.user.id) {
      // 检查是否是帖子作者（家庭管理员权限）
      const posts = await query(
        'SELECT author_id, family_id FROM posts WHERE id = ?',
        [comment.post_id]
      );

      if (posts.length > 0) {
        const families = await query(
          'SELECT admin_id FROM families WHERE id = ?',
          [posts[0].family_id]
        );

        const isAdmin = families.length > 0 && families[0].admin_id === req.user.id;
        if (!isAdmin && posts[0].author_id !== req.user.id) {
          return res.status(403).json({
            success: false,
            message: '无权删除此评论'
          });
        }
      }
    }

    await execute('DELETE FROM comments WHERE id = ?', [commentId]);

    res.json({
      success: true,
      message: '评论删除成功'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
