 xcconst express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-with-a-long-random-secret';
const SALT_ROUNDS = 10;
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const db = new sqlite3.Database(path.join(__dirname, 'securechat.db'));
const clients = new Map();

function addColumn(table, definition) {
  db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`, () => {});
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    blocked TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(moment_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moment_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    blocked_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, blocked_user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    wrapped_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    from_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    read_by TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  addColumn('users', "nickname TEXT");
  addColumn('users', "avatar TEXT DEFAULT ''");
  addColumn('users', "bio TEXT DEFAULT ''");
  addColumn('messages', 'read_at DATETIME');
  addColumn('moments', "blocked TEXT DEFAULT '[]'");
  addColumn('group_members', "wrapped_key TEXT DEFAULT ''");
  addColumn('group_messages', "read_by TEXT DEFAULT '[]'");
});

function authenticateToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sendToUser(userId, payload) {
  const sockets = clients.get(Number(userId));
  if (!sockets) return;
  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function broadcastGroup(groupId, payload, exceptUserId) {
  db.all('SELECT user_id FROM group_members WHERE group_id = ?', [groupId], (err, rows) => {
    if (err) return;
    for (const row of rows || []) {
      if (Number(row.user_id) !== Number(exceptUserId)) sendToUser(row.user_id, payload);
    }
  });
}

function getPresencePeers(userId, cb) {
  db.all(
    `SELECT friend_id AS user_id FROM friends WHERE user_id = ?
     UNION
     SELECT gm2.user_id
     FROM group_members gm1
     JOIN group_members gm2 ON gm2.group_id = gm1.group_id
     WHERE gm1.user_id = ? AND gm2.user_id != ?`,
    [userId, userId, userId],
    (err, rows) => cb(err, (rows || []).map((row) => Number(row.user_id)))
  );
}

function broadcastPresence(userId, online) {
  getPresencePeers(userId, (err, peers) => {
    if (err) return;
    for (const peerId of peers) sendToUser(peerId, { type: 'presence', user_id: userId, online });
  });
}

function sendPresenceSnapshot(userId) {
  getPresencePeers(userId, (err, peers) => {
    if (err) return;
    const online = peers.filter((peerId) => clients.has(peerId));
    sendToUser(userId, { type: 'presence_snapshot', online });
  });
}

function isGroupMember(groupId, userId, cb) {
  db.get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId], (err, row) => cb(err, !!row));
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = params.get('token');
  if (!token) return ws.close(1008, 'Missing token');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    ws.userId = user.id;
    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);
    sendPresenceSnapshot(user.id);
    broadcastPresence(user.id, true);
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        if (event.type !== 'typing') return;
        const payload = {
          type: 'typing',
          from_id: user.id,
          is_typing: Boolean(event.is_typing),
          target_type: event.target_type
        };
        if (event.target_type === 'direct') {
          const toId = intParam(event.to_id);
          if (toId) sendToUser(toId, { ...payload, to_id: toId });
        }
        if (event.target_type === 'group') {
          const groupId = intParam(event.group_id);
          if (groupId) broadcastGroup(groupId, { ...payload, group_id: groupId }, user.id);
        }
      } catch {}
    });
    ws.on('close', () => {
      const sockets = clients.get(user.id);
      if (!sockets) return;
      sockets.delete(ws);
      if (sockets.size === 0) {
        clients.delete(user.id);
        broadcastPresence(user.id, false);
      }
    });
  } catch {
    ws.close(1008, 'Invalid token');
  }
});

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const publicKey = req.body.public_key;
  if (!username || !password || !publicKey) return res.status(400).json({ error: 'Username, password and public key are required' });
  if (username.length > 32) return res.status(400).json({ error: 'Username is too long' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    db.run('INSERT INTO users (username, password_hash, public_key, nickname) VALUES (?, ?, ?, ?)', [username, hash, JSON.stringify(publicKey), username], function onInsert(err) {
      if (err) {
        if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
        return res.status(500).json({ error: 'Database error' });
      }
      const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: this.lastID, username, nickname: username, avatar: '', bio: '' } });
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Incorrect username or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Incorrect username or password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname || user.username, avatar: user.avatar || '', bio: user.bio || '' } });
  });
});

app.get('/api/user/profile', authenticateToken, (req, res) => {
  db.get('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  });
});

app.put('/api/user/profile', authenticateToken, (req, res) => {
  const updates = [];
  const params = [];
  if (req.body.nickname !== undefined) {
    const nickname = String(req.body.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Nickname cannot be empty' });
    if (nickname.length > 24) return res.status(400).json({ error: 'Nickname is too long' });
    updates.push('nickname = ?');
    params.push(nickname);
  }
  if (req.body.avatar !== undefined) {
    const avatar = String(req.body.avatar || '');
    if (avatar.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Avatar image is too large' });
    updates.push('avatar = ?');
    params.push(avatar);
  }
  if (req.body.bio !== undefined) {
    const bio = String(req.body.bio || '').trim();
    if (bio.length > 160) return res.status(400).json({ error: 'Bio is too long' });
    updates.push('bio = ?');
    params.push(bio);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.user.id);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true });
  });
});

app.put('/api/user/password', authenticateToken, (req, res) => {
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Old and new password are required' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id], async (err, row) => {
    if (err || !row) return res.status(500).json({ error: 'User data error' });
    const ok = await bcrypt.compare(oldPassword, row.password_hash);
    if (!ok) return res.status(400).json({ error: 'Old password is incorrect' });
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: 'Password update failed' });
      res.json({ success: true });
    });
  });
});

app.put('/api/user/public-key', authenticateToken, (req, res) => {
  if (!req.body.public_key) return res.status(400).json({ error: 'Public key is required' });
  db.run('UPDATE users SET public_key = ? WHERE id = ?', [JSON.stringify(req.body.public_key), req.user.id], (err) => {
    if (err) return res.status(500).json({ error: 'Public key update failed' });
    res.json({ success: true });
  });
});

app.get('/api/user/:id/public-key', authenticateToken, (req, res) => {
  const userId = intParam(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });
  db.get('SELECT public_key FROM users WHERE id = ?', [userId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'User not found' });
    try {
      res.json({ public_key: JSON.parse(row.public_key) });
    } catch {
      res.status(500).json({ error: 'Invalid public key data' });
    }
  });
});

app.get('/api/user/:id/profile', authenticateToken, (req, res) => {
  const userId = intParam(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });
  db.get('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    db.all('SELECT m.*, u.username, u.nickname, u.avatar FROM moments m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 30', [userId], (momentsErr, rows) => {
      if (momentsErr) return res.status(500).json({ error: 'Query failed' });
      const moments = (rows || []).filter((m) => !parseJsonArray(m.blocked).map(Number).includes(req.user.id));
      res.json({ user, moments });
    });
  });
});

app.get('/api/search-users', authenticateToken, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  db.all('SELECT id, username, nickname, avatar, bio, public_key FROM users WHERE (username LIKE ? OR nickname LIKE ?) AND id != ? LIMIT 10', [`%${q}%`, `%${q}%`, req.user.id], (err, users) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    res.json({ users: (users || []).map((user) => ({ ...user, public_key: safeParse(user.public_key) })) });
  });
});

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

app.post('/api/friend-request', authenticateToken, (req, res) => {
  const toId = intParam(req.body.to_id);
  if (!toId) return res.status(400).json({ error: 'Invalid target user id' });
  if (toId === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
  db.get('SELECT id FROM users WHERE id = ?', [toId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    db.get('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, toId], (friendErr, existing) => {
      if (friendErr) return res.status(500).json({ error: 'Query failed' });
      if (existing) return res.status(400).json({ error: 'Already friends' });
      db.get(`SELECT id FROM friend_requests WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status = 'pending'`, [req.user.id, toId, toId, req.user.id], (pendingErr, pending) => {
        if (pendingErr) return res.status(500).json({ error: 'Query failed' });
        if (pending) return res.status(400).json({ error: 'Friend request already exists' });
        db.run('INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?)', [req.user.id, toId], (insertErr) => {
          if (insertErr) return res.status(500).json({ error: 'Request failed' });
          sendToUser(toId, { type: 'friend_request' });
          res.json({ success: true });
        });
      });
    });
  });
});

app.post('/api/friend-request/:fromId', authenticateToken, (req, res) => {
  const fromId = intParam(req.params.fromId);
  const action = req.body.action;
  if (!fromId || !['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid request' });
  db.get(`SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'`, [fromId, req.user.id], (err, request) => {
    if (err || !request) return res.status(404).json({ error: 'Request not found' });
    const status = action === 'accept' ? 'accepted' : 'rejected';
    db.run('UPDATE friend_requests SET status = ? WHERE id = ?', [status, request.id], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: 'Update failed' });
      if (action === 'reject') return res.json({ success: true });
      db.serialize(() => {
        db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [req.user.id, fromId]);
        db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [fromId, req.user.id], (friendErr) => {
          if (friendErr) return res.status(500).json({ error: 'Add friend failed' });
          sendToUser(fromId, { type: 'friends_changed' });
          res.json({ success: true });
        });
      });
    });
  });
});

app.get('/api/friends', authenticateToken, (req, res) => {
  db.all(`SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.public_key,
       (SELECT COUNT(*) FROM blocks WHERE user_id = ? AND blocked_user_id = u.id) AS is_blocked
     FROM friends f JOIN users u ON f.friend_id = u.id
     WHERE f.user_id = ?
     ORDER BY COALESCE(u.nickname, u.username) COLLATE NOCASE ASC`, [req.user.id, req.user.id], (err, friends) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    db.all(`SELECT fr.id, fr.from_id, u.username, u.nickname, u.avatar
         FROM friend_requests fr JOIN users u ON fr.from_id = u.id
         WHERE fr.to_id = ? AND fr.status = 'pending'
         ORDER BY fr.created_at DESC`, [req.user.id], (requestErr, requests) => {
      if (requestErr) return res.status(500).json({ error: 'Query failed' });
      res.json({ friends: (friends || []).map((friend) => ({ ...friend, public_key: safeParse(friend.public_key) })), requests: requests || [] });
    });
  });
});

app.delete('/api/friends/:friendId', authenticateToken, (req, res) => {
  const friendId = intParam(req.params.friendId);
  if (!friendId) return res.status(400).json({ error: 'Invalid friend id' });
  db.serialize(() => {
    db.run('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', [req.user.id, friendId, friendId, req.user.id]);
    db.run('DELETE FROM blocks WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)', [req.user.id, friendId, friendId, req.user.id]);
    db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', [req.user.id, friendId, friendId, req.user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Delete failed' });
      sendToUser(friendId, { type: 'friends_changed' });
      res.json({ success: true });
    });
  });
});

app.post('/api/block/:friendId', authenticateToken, (req, res) => {
  const friendId = intParam(req.params.friendId);
  if (!friendId) return res.status(400).json({ error: 'Invalid friend id' });
  db.get('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, friendId], (err, row) => {
    if (err || !row) return res.status(403).json({ error: 'You can only block friends' });
    db.run('INSERT OR IGNORE INTO blocks (user_id, blocked_user_id) VALUES (?, ?)', [req.user.id, friendId], (insertErr) => {
      if (insertErr) return res.status(500).json({ error: 'Block failed' });
      res.json({ success: true });
    });
  });
});

app.delete('/api/block/:friendId', authenticateToken, (req, res) => {
  const friendId = intParam(req.params.friendId);
  if (!friendId) return res.status(400).json({ error: 'Invalid friend id' });
  db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?', [req.user.id, friendId], (err) => {
    if (err) return res.status(500).json({ error: 'Unblock failed' });
    res.json({ success: true });
  });
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const toId = intParam(req.body.to_id);
  const content = String(req.body.content || '');
  if (!toId || !content) return res.status(400).json({ error: 'Missing message data' });
  if (content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Message is too large' });
  db.get('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, toId], (err, row) => {
    if (err || !row) return res.status(403).json({ error: 'Not friends' });
    db.run('INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)', [req.user.id, toId, content], function onInsert(insertErr) {
      if (insertErr) return res.status(500).json({ error: 'Send failed' });
      const message = { id: this.lastID, from_id: req.user.id, to_id: toId, content, read_at: null, created_at: new Date().toISOString() };
      sendToUser(toId, { type: 'new_message', message });
      res.json({ message });
    });
  });
});

app.get('/api/messages/:friendId', authenticateToken, (req, res) => {
  const friendId = intParam(req.params.friendId);
  if (!friendId) return res.status(400).json({ error: 'Invalid friend id' });
  db.all(`SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY created_at ASC, id ASC`, [req.user.id, friendId, friendId, req.user.id], (err, messages) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    res.json({ messages: messages || [] });
  });
});

app.get('/api/chat-list', authenticateToken, (req, res) => {
  db.all(`SELECT u.id AS friend_id, u.username AS friend_name, u.nickname AS friend_nickname, u.avatar AS friend_avatar,
       lm.content AS last_preview, lm.created_at AS last_time,
       (SELECT COUNT(*) FROM messages unread WHERE unread.from_id = u.id AND unread.to_id = ? AND unread.read_at IS NULL) AS unread_count
     FROM friends f JOIN users u ON u.id = f.friend_id
     LEFT JOIN messages lm ON lm.id = (
       SELECT id FROM messages WHERE (from_id = ? AND to_id = u.id) OR (from_id = u.id AND to_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 1
     )
     WHERE f.user_id = ?
     ORDER BY COALESCE(lm.created_at, f.created_at) DESC`, [req.user.id, req.user.id, req.user.id, req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    res.json({ chats: rows || [] });
  });
});

app.post('/api/mark-read/:friendId', authenticateToken, (req, res) => {
  const friendId = intParam(req.params.friendId);
  if (!friendId) return res.status(400).json({ error: 'Invalid friend id' });
  const readAt = new Date().toISOString();
  db.run('UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL', [readAt, friendId, req.user.id], function onUpdate(err) {
    if (err) return res.status(500).json({ error: 'Mark read failed' });
    sendToUser(friendId, { type: 'read_receipt', by: req.user.id, read_at: readAt });
    res.json({ success: true, updated: this.changes, read_at: readAt });
  });
});

app.post('/api/groups', authenticateToken, (req, res) => {
  const name = String(req.body.name || '').trim();
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  if (!name || name.length > 36) return res.status(400).json({ error: 'Group name must be 1-36 characters' });
  if (members.length < 2) return res.status(400).json({ error: 'Pick at least one friend' });
  const normalized = new Map();
  for (const member of members) {
    const userId = intParam(member.user_id);
    const wrappedKey = String(member.wrapped_key || '');
    if (userId && wrappedKey) normalized.set(userId, wrappedKey);
  }
  if (!normalized.has(req.user.id)) return res.status(400).json({ error: 'Missing your encrypted group key' });
  db.run('INSERT INTO groups (name, owner_id) VALUES (?, ?)', [name, req.user.id], function onGroup(err) {
    if (err) return res.status(500).json({ error: 'Create group failed' });
    const groupId = this.lastID;
    db.serialize(() => {
      for (const [userId, wrappedKey] of normalized) {
        db.run('INSERT OR IGNORE INTO group_members (group_id, user_id, role, wrapped_key) VALUES (?, ?, ?, ?)', [groupId, userId, userId === req.user.id ? 'owner' : 'member', wrappedKey]);
      }
      db.get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.user.id], (memberErr, ownerRow) => {
        if (memberErr || !ownerRow) return res.status(500).json({ error: 'Create group failed' });
        for (const userId of normalized.keys()) sendToUser(userId, { type: 'groups_changed' });
        res.json({ success: true, group_id: groupId });
      });
    });
  });
});

app.get('/api/groups', authenticateToken, (req, res) => {
  db.all(`SELECT g.id, g.name, g.owner_id, g.created_at, gm.wrapped_key,
       owner.username AS owner_username, owner.nickname AS owner_nickname, owner.public_key AS owner_public_key,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
       (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_time,
       (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_preview
     FROM group_members gm
     JOIN groups g ON g.id = gm.group_id
     JOIN users owner ON owner.id = g.owner_id
     WHERE gm.user_id = ?
     ORDER BY COALESCE(last_time, g.created_at) DESC`, [req.user.id], (err, groups) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    res.json({ groups: (groups || []).map((g) => ({ ...g, owner_public_key: safeParse(g.owner_public_key) })) });
  });
});

app.get('/api/groups/:groupId/members', authenticateToken, (req, res) => {
  const groupId = intParam(req.params.groupId);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  isGroupMember(groupId, req.user.id, (err, ok) => {
    if (err || !ok) return res.status(403).json({ error: 'Not a group member' });
    db.all(`SELECT u.id, u.username, u.nickname, u.avatar, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.created_at ASC`, [groupId], (memberErr, members) => {
      if (memberErr) return res.status(500).json({ error: 'Query failed' });
      res.json({ members: members || [] });
    });
  });
});

app.get('/api/groups/:groupId/messages', authenticateToken, (req, res) => {
  const groupId = intParam(req.params.groupId);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  isGroupMember(groupId, req.user.id, (err, ok) => {
    if (err || !ok) return res.status(403).json({ error: 'Not a group member' });
    db.all(`SELECT gm.*, u.username, u.nickname, u.avatar FROM group_messages gm JOIN users u ON u.id = gm.from_id WHERE gm.group_id = ? ORDER BY gm.created_at ASC, gm.id ASC`, [groupId], (msgErr, messages) => {
      if (msgErr) return res.status(500).json({ error: 'Query failed' });
      res.json({ messages: (messages || []).map((message) => ({ ...message, read_by: parseJsonArray(message.read_by) })) });
    });
  });
});

app.post('/api/groups/:groupId/messages', authenticateToken, (req, res) => {
  const groupId = intParam(req.params.groupId);
  const content = String(req.body.content || '');
  if (!groupId || !content) return res.status(400).json({ error: 'Missing group message data' });
  if (content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Message is too large' });
  isGroupMember(groupId, req.user.id, (err, ok) => {
    if (err || !ok) return res.status(403).json({ error: 'Not a group member' });
    db.run('INSERT INTO group_messages (group_id, from_id, content, read_by) VALUES (?, ?, ?, ?)', [groupId, req.user.id, content, JSON.stringify([req.user.id])], function onInsert(insertErr) {
      if (insertErr) return res.status(500).json({ error: 'Send failed' });
      const message = { id: this.lastID, group_id: groupId, from_id: req.user.id, content, read_by: [req.user.id], created_at: new Date().toISOString() };
      broadcastGroup(groupId, { type: 'new_group_message', group_id: groupId, message }, req.user.id);
      res.json({ message });
    });
  });
});

app.post('/api/groups/:groupId/mark-read', authenticateToken, (req, res) => {
  const groupId = intParam(req.params.groupId);
  if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
  isGroupMember(groupId, req.user.id, (err, ok) => {
    if (err || !ok) return res.status(403).json({ error: 'Not a group member' });
    db.all('SELECT id, read_by FROM group_messages WHERE group_id = ? AND from_id != ?', [groupId, req.user.id], (msgErr, messages) => {
      if (msgErr) return res.status(500).json({ error: 'Query failed' });
      let updated = 0;
      for (const message of messages || []) {
        const readBy = parseJsonArray(message.read_by).map(Number);
        if (!readBy.includes(req.user.id)) {
          readBy.push(req.user.id);
          updated += 1;
          db.run('UPDATE group_messages SET read_by = ? WHERE id = ?', [JSON.stringify(readBy), message.id]);
        }
      }
      broadcastGroup(groupId, { type: 'group_read_receipt', group_id: groupId, by: req.user.id }, req.user.id);
      res.json({ success: true, updated });
    });
  });
});

app.post('/api/moments', authenticateToken, (req, res) => {
  const content = String(req.body.content || '').trim();
  const blocked = Array.isArray(req.body.blocked) ? req.body.blocked.map(Number).filter(Boolean) : [];
  if (!content) return res.status(400).json({ error: 'Content cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Content is too long' });
  db.run('INSERT INTO moments (user_id, content, blocked) VALUES (?, ?, ?)', [req.user.id, content, JSON.stringify(blocked)], function onInsert(err) {
    if (err) return res.status(500).json({ error: 'Post failed' });
    for (const [userId] of clients) {
      if (userId !== req.user.id && !blocked.includes(userId)) sendToUser(userId, { type: 'new_moment' });
    }
    res.json({ success: true, moment_id: this.lastID });
  });
});

app.get('/api/moments', authenticateToken, (req, res) => {
  const profileUserId = req.query.user_id ? intParam(req.query.user_id) : null;
  db.all(`SELECT blocked_user_id FROM blocks WHERE user_id = ? UNION SELECT user_id AS blocked_user_id FROM blocks WHERE blocked_user_id = ?`, [req.user.id, req.user.id], (blockErr, blockRows) => {
    if (blockErr) return res.status(500).json({ error: 'Query failed' });
    const blockedUsers = new Set((blockRows || []).map((r) => Number(r.blocked_user_id)));
    const params = [req.user.id];
    const userFilter = profileUserId ? 'AND m.user_id = ?' : '';
    if (profileUserId) params.push(profileUserId);
    db.all(`SELECT m.*, u.username, u.nickname, u.avatar,
           (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) AS like_count,
           (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) AS liked_by_me
         FROM moments m JOIN users u ON m.user_id = u.id
         WHERE 1 = 1 ${userFilter}
         ORDER BY m.created_at DESC LIMIT 100`, params, (err, moments) => {
      if (err) return res.status(500).json({ error: 'Query failed' });
      const visible = (moments || []).filter((moment) => !blockedUsers.has(Number(moment.user_id)) && !parseJsonArray(moment.blocked).map(Number).includes(req.user.id)).slice(0, 50);
      Promise.all(visible.map((moment) => new Promise((resolve) => {
        db.all('SELECT mc.*, u.username, u.nickname FROM moment_comments mc JOIN users u ON mc.user_id = u.id WHERE mc.moment_id = ? ORDER BY mc.created_at ASC', [moment.id], (commentErr, comments) => {
          moment.comments = commentErr ? [] : (comments || []);
          moment.likes = moment.liked_by_me ? [req.user.id] : [];
          moment.blocked = parseJsonArray(moment.blocked);
          resolve(moment);
        });
      }))).then((results) => res.json({ moments: results }));
    });
  });
});

app.post('/api/moments/:id/like', authenticateToken, (req, res) => {
  const momentId = intParam(req.params.id);
  if (!momentId) return res.status(400).json({ error: 'Invalid moment id' });
  db.get('SELECT id FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.user.id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Query failed' });
    const done = (liked) => db.get('SELECT COUNT(*) AS count FROM moment_likes WHERE moment_id = ?', [momentId], (countErr, countRow) => {
      if (countErr) return res.status(500).json({ error: 'Query failed' });
      res.json({ liked, like_count: countRow.count });
    });
    if (row) {
      db.run('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.user.id], (deleteErr) => {
        if (deleteErr) return res.status(500).json({ error: 'Unlike failed' });
        done(false);
      });
    } else {
      db.run('INSERT OR IGNORE INTO moment_likes (moment_id, user_id) VALUES (?, ?)', [momentId, req.user.id], (insertErr) => {
        if (insertErr) return res.status(500).json({ error: 'Like failed' });
        done(true);
      });
    }
  });
});

app.post('/api/moments/:id/comment', authenticateToken, (req, res) => {
  const momentId = intParam(req.params.id);
  const content = String(req.body.content || '').trim();
  if (!momentId || !content) return res.status(400).json({ error: 'Invalid comment' });
  if (content.length > 300) return res.status(400).json({ error: 'Comment is too long' });
  db.run('INSERT INTO moment_comments (moment_id, user_id, content) VALUES (?, ?, ?)', [momentId, req.user.id, content], (err) => {
    if (err) return res.status(500).json({ error: 'Comment failed' });
    res.json({ success: true });
  });
});

server.listen(PORT, () => {
  console.log(`6nr server listening on port ${PORT}`);
});
