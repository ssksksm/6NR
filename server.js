const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = 'your-random-secret-change-me-to-something-long-and-random';
const SALT_ROUNDS = 10;
const PORT = process.env.PORT || 3000;

// 增加 JSON 请求体大小限制（头像可能较大）
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// 数据库初始化
const db = new sqlite3.Database('securechat.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(friend_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(from_id) REFERENCES users(id),
    FOREIGN KEY(to_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(from_id) REFERENCES users(id),
    FOREIGN KEY(to_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(moment_id, user_id),
    FOREIGN KEY(moment_id) REFERENCES moments(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moment_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(moment_id) REFERENCES moments(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    blocked_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, blocked_user_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(blocked_user_id) REFERENCES users(id)
  )`);
});

// JWT验证中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供令牌' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '令牌无效或过期' });
    req.user = user;
    next();
  });
}

// WebSocket 连接处理
const clients = new Map();
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const token = params.get('token');
  if (!token) {
    ws.close(1008, '缺少认证令牌');
    return;
  }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    ws.userId = user.id;
    clients.set(user.id, ws);
    console.log(`用户 ${user.username} 已连接 WebSocket`);

    ws.on('close', () => {
      clients.delete(user.id);
      console.log(`用户 ${user.username} 断开连接`);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'new_message') {
          const receiverId = msg.message.to_id;
          const receiverWs = clients.get(receiverId);
          if (receiverWs && receiverWs.readyState === 1) {
            receiverWs.send(JSON.stringify({ type: 'new_message', message: msg.message }));
          }
        } else if (msg.type === 'new_moment') {
          wss.clients.forEach(client => {
            if (client.readyState === 1 && client.userId !== ws.userId) {
              client.send(JSON.stringify({ type: 'new_moment' }));
            }
          });
        }
      } catch (e) {
        console.error('WebSocket消息处理错误:', e);
      }
    });
  } catch (e) {
    ws.close(1008, '无效的令牌');
  }
});

// ==================== API 路由 ====================

// 注册
app.post('/api/register', async (req, res) => {
  const { username, password, public_key } = req.body;
  if (!username || !password || !public_key) {
    return res.status(400).json({ error: '请提供用户名、密码和公钥' });
  }
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    // 默认昵称同用户名
    db.run('INSERT INTO users (username, password_hash, public_key, nickname) VALUES (?, ?, ?, ?)',
      [username, hash, JSON.stringify(public_key), username],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: '用户名已存在' });
          }
          return res.status(500).json({ error: '数据库错误' });
        }
        const userId = this.lastID;
        const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: userId, username, nickname: username } });
      });
  } catch (e) {
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请提供用户名和密码' });
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: '用户名或密码错误' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: '用户名或密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        avatar: user.avatar || ''
      }
    });
  });
});

// 获取当前用户信息
app.get('/api/user/profile', authenticateToken, (req, res) => {
  db.get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', [req.user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: '用户不存在' });
    res.json({ user: row });
  });
});

// 更新用户信息（昵称、头像）
app.put('/api/user/profile', authenticateToken, (req, res) => {
  const { nickname, avatar } = req.body;
  const updates = [];
  const params = [];
  if (nickname !== undefined) {
    updates.push('nickname = ?');
    params.push(nickname);
  }
  if (avatar !== undefined) {
    updates.push('avatar = ?');
    params.push(avatar);
  }
  if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });
  params.push(req.user.id);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
    if (err) return res.status(500).json({ error: '更新失败' });
    res.json({ success: true });
  });
});

// 修改密码
app.put('/api/user/password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请提供旧密码和新密码' });
  if (newPassword.length < 4) return res.status(400).json({ error: '新密码至少4位' });
  db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id], async (err, row) => {
    if (err || !row) return res.status(500).json({ error: '用户数据错误' });
    const match = await bcrypt.compare(oldPassword, row.password_hash);
    if (!match) return res.status(400).json({ error: '旧密码不正确' });
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id], (err) => {
      if (err) return res.status(500).json({ error: '密码更新失败' });
      res.json({ success: true });
    });
  });
});

// 更新公钥
app.put('/api/user/public-key', authenticateToken, (req, res) => {
  const { public_key } = req.body;
  if (!public_key) return res.status(400).json({ error: '缺少公钥' });
  db.run('UPDATE users SET public_key = ? WHERE id = ?', [JSON.stringify(public_key), req.user.id], (err) => {
    if (err) return res.status(500).json({ error: '更新失败' });
    res.json({ success: true });
  });
});

// 获取用户公钥
app.get('/api/user/:id/public-key', authenticateToken, (req, res) => {
  const userId = parseInt(req.params.id);
  db.get('SELECT public_key FROM users WHERE id = ?', [userId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: '用户不存在' });
    try {
      const pubKey = JSON.parse(row.public_key);
      res.json({ public_key: pubKey });
    } catch (e) {
      res.status(500).json({ error: '公钥格式错误' });
    }
  });
});

// 搜索用户
app.get('/api/search-users', authenticateToken, (req, res) => {
  const q = req.query.q || '';
  db.all('SELECT id, username, nickname FROM users WHERE (username LIKE ? OR nickname LIKE ?) AND id != ? LIMIT 10',
    [`%${q}%`, `%${q}%`, req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询错误' });
      res.json({ users: rows });
    });
});

// 发送好友请求
app.post('/api/friend-request', authenticateToken, (req, res) => {
  const { to_id } = req.body;
  if (!to_id) return res.status(400).json({ error: '缺少目标用户ID' });
  if (to_id === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });
  db.get('SELECT id FROM users WHERE id = ?', [to_id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: '用户不存在' });
    db.get('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      [req.user.id, to_id, to_id, req.user.id], (err, existing) => {
        if (err) return res.status(500).json({ error: '查询错误' });
        if (existing) return res.status(400).json({ error: '已经是好友或已存在请求' });
        db.run('INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?)',
          [req.user.id, to_id], function(err) {
            if (err) return res.status(500).json({ error: '请求发送失败' });
            res.json({ success: true });
          });
      });
  });
});

// 处理好友请求
app.post('/api/friend-request/:fromId', authenticateToken, (req, res) => {
  const fromId = parseInt(req.params.fromId);
  const { action } = req.body;
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });
  db.get('SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = "pending"',
    [fromId, req.user.id], (err, request) => {
      if (err || !request) return res.status(404).json({ error: '请求不存在或已处理' });
      if (action === 'accept') {
        db.run('UPDATE friend_requests SET status = "accepted" WHERE id = ?', [request.id]);
        db.run('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [req.user.id, fromId]);
        db.run('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [fromId, req.user.id]);
        res.json({ success: true });
      } else {
        db.run('UPDATE friend_requests SET status = "rejected" WHERE id = ?', [request.id]);
        res.json({ success: true });
      }
    });
});

// 获取好友列表（附带昵称和屏蔽状态）
app.get('/api/friends', authenticateToken, (req, res) => {
  db.all(`SELECT u.id, u.username, u.nickname, u.avatar,
    (SELECT COUNT(*) FROM blocks WHERE user_id = ? AND blocked_user_id = u.id) as is_blocked
    FROM friends f JOIN users u ON f.friend_id = u.id WHERE f.user_id = ?`,
    [req.user.id, req.user.id], (err, friends) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      db.all(`SELECT fr.id, fr.from_id, u.username, u.nickname FROM friend_requests fr
        JOIN users u ON fr.from_id = u.id WHERE fr.to_id = ? AND fr.status = 'pending'`,
        [req.user.id], (err, requests) => {
          if (err) return res.status(500).json({ error: '查询失败' });
          res.json({ friends, requests });
        });
    });
});

// 屏蔽好友
app.post('/api/block/:friendId', authenticateToken, (req, res) => {
  const friendId = parseInt(req.params.friendId);
  db.get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, friendId], (err, row) => {
    if (err || !row) return res.status(403).json({ error: '不是好友关系，无法屏蔽' });
    db.run('INSERT OR IGNORE INTO blocks (user_id, blocked_user_id) VALUES (?, ?)', [req.user.id, friendId], (err) => {
      if (err) return res.status(500).json({ error: '屏蔽失败' });
      res.json({ success: true });
    });
  });
});

// 取消屏蔽好友
app.delete('/api/block/:friendId', authenticateToken, (req, res) => {
  const friendId = parseInt(req.params.friendId);
  db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?', [req.user.id, friendId], (err) => {
    if (err) return res.status(500).json({ error: '取消屏蔽失败' });
    res.json({ success: true });
  });
});

// 获取屏蔽列表
app.get('/api/blocks', authenticateToken, (req, res) => {
  db.all('SELECT u.id, u.username, u.nickname FROM blocks b JOIN users u ON b.blocked_user_id = u.id WHERE b.user_id = ?', [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json({ blocked: rows });
  });
});

// 发送消息
app.post('/api/messages', authenticateToken, (req, res) => {
  const { to_id, content } = req.body;
  if (!to_id || !content) return res.status(400).json({ error: '缺少必要参数' });
  db.get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, to_id], (err, row) => {
    if (err || !row) return res.status(403).json({ error: '不是好友关系' });
    db.run('INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)',
      [req.user.id, to_id, content], function(err) {
        if (err) return res.status(500).json({ error: '消息发送失败' });
        const newMsg = {
          id: this.lastID,
          from_id: req.user.id,
          to_id: to_id,
          content: content,
          created_at: new Date().toISOString()
        };
        const receiverWs = clients.get(to_id);
        if (receiverWs && receiverWs.readyState === 1) {
          receiverWs.send(JSON.stringify({ type: 'new_message', message: newMsg }));
        }
        res.json({ message: newMsg });
      });
  });
});

// 获取聊天记录
app.get('/api/messages/:friendId', authenticateToken, (req, res) => {
  const friendId = parseInt(req.params.friendId);
  db.all(`SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY created_at ASC`,
    [req.user.id, friendId, friendId, req.user.id], (err, messages) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json({ messages });
    });
});

// 获取聊天列表
app.get('/api/chat-list', authenticateToken, (req, res) => {
  db.all(`SELECT 
      CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END as friend_id,
      u.username as friend_name,
      u.nickname as friend_nickname,
      (SELECT content FROM messages WHERE ((from_id = m.from_id AND to_id = m.to_id) OR (from_id = m.to_id AND to_id = m.from_id)) ORDER BY created_at DESC LIMIT 1) as last_preview,
      (SELECT created_at FROM messages WHERE ((from_id = m.from_id AND to_id = m.to_id) OR (from_id = m.to_id AND to_id = m.from_id)) ORDER BY created_at DESC LIMIT 1) as last_time
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END
    WHERE m.from_id = ? OR m.to_id = ?
    GROUP BY friend_id
    ORDER BY last_time DESC`, [req.user.id, req.user.id, req.user.id, req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json({ chats: rows });
    });
});

app.post('/api/mark-read/:friendId', authenticateToken, (req, res) => {
  res.json({ success: true });
});

// 微博相关（复用 moments 表）
app.post('/api/moments', authenticateToken, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  db.run('INSERT INTO moments (user_id, content) VALUES (?, ?)', [req.user.id, content], function(err) {
    if (err) return res.status(500).json({ error: '发布失败' });
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client.userId !== req.user.id) {
        client.send(JSON.stringify({ type: 'new_moment' }));
      }
    });
    res.json({ success: true, moment_id: this.lastID });
  });
});

app.get('/api/moments', authenticateToken, (req, res) => {
  // 获取屏蔽列表
  db.all('SELECT blocked_user_id FROM blocks WHERE user_id = ?', [req.user.id], (err, blockedRows) => {
    const blockedIds = (blockedRows || []).map(r => r.blocked_user_id);
    const blockedFilter = blockedIds.length > 0 ? `AND m.user_id NOT IN (${blockedIds.join(',')})` : '';
    
    db.all(`SELECT m.*, u.username, u.nickname, u.avatar,
      (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
      (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as liked_by_me
      FROM moments m
      JOIN users u ON m.user_id = u.id
      WHERE 1=1 ${blockedFilter}
      ORDER BY m.created_at DESC LIMIT 50`, [req.user.id], (err, moments) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        const promises = moments.map(moment => {
          return new Promise((resolve) => {
            db.all('SELECT mc.*, u.username, u.nickname FROM moment_comments mc JOIN users u ON mc.user_id = u.id WHERE mc.moment_id = ? ORDER BY mc.created_at ASC',
              [moment.id], (err, comments) => {
                moment.comments = comments || [];
                moment.likes = moment.liked_by_me ? [req.user.id] : [];
                resolve(moment);
              });
          });
        });
        Promise.all(promises).then(results => {
          res.json({ moments: results });
        });
      });
  });
});

app.post('/api/moments/:id/like', authenticateToken, (req, res) => {
  const momentId = parseInt(req.params.id);
  db.get('SELECT * FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.user.id], (err, row) => {
    if (err) return res.status(500).json({ error: '查询错误' });
    if (row) {
      db.run('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.user.id]);
      db.get('SELECT COUNT(*) as count FROM moment_likes WHERE moment_id = ?', [momentId], (err, countRow) => {
        res.json({ liked: false, like_count: countRow.count });
      });
    } else {
      db.run('INSERT INTO moment_likes (moment_id, user_id) VALUES (?, ?)', [momentId, req.user.id]);
      db.get('SELECT COUNT(*) as count FROM moment_likes WHERE moment_id = ?', [momentId], (err, countRow) => {
        res.json({ liked: true, like_count: countRow.count });
      });
    }
  });
});

app.post('/api/moments/:id/comment', authenticateToken, (req, res) => {
  const momentId = parseInt(req.params.id);
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: '评论不能为空' });
  db.run('INSERT INTO moment_comments (moment_id, user_id, content) VALUES (?, ?, ?)',
    [momentId, req.user.id, content], (err) => {
      if (err) return res.status(500).json({ error: '评论失败' });
      res.json({ success: true });
    });
});

server.listen(PORT, () => {
  console.log(`6nr 服务运行在端口 ${PORT}`);
});
