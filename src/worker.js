const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const CHUNK_CONTENT_THRESHOLD = 480 * 1024;
const CHUNK_BYTES = 128 * 1024;
const PBKDF2_ITERATIONS = 120000;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHUNK_MARKER = '@d1:';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  friend_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  blocked TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS moment_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(moment_id, user_id)
);
CREATE TABLE IF NOT EXISTS moment_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  blocked_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, blocked_user_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  read_by TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS public_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS server_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(content_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_to_status ON friend_requests(to_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_groups_user ON group_members(user_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_time ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_public_messages_time ON public_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_moments_time ON moments(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_moment ON moment_comments(moment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_chunks_id ON content_chunks(content_id, chunk_index);
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '1');
`;

let schemaReady;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: 'Server error' }, 500);
}

function intParam(value) {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseJsonArray(value) {
  const parsed = safeParse(value || '[]', []);
  return Array.isArray(parsed) ? parsed : [];
}

async function readJson(request) {
  const statedLength = Number(request.headers.get('content-length') || 0);
  if (statedLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request is too large');
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const statements = SCHEMA_SQL
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => env.DB.prepare(statement));
      await env.DB.batch(statements);
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

async function one(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

async function many(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}

async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
}

async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function passwordMatches(password, stored) {
  const [scheme, iterationsText, saltText, hashText] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !iterationsText || !saltText || !hashText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 10000 || iterations > 1000000) return false;
  const salt = base64ToBytes(saltText);
  const expected = base64ToBytes(hashText);
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, expected.length * 8);
  return constantTimeEqual(new Uint8Array(bits), expected);
}

function tokenSecret(env) {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new HttpError(503, 'Server security secret is not configured');
  }
  return env.JWT_SECRET;
}

async function signToken(env, user) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({ id: user.id, username: user.username, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(tokenSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyToken(env, token) {
  try {
    const [headerText, payloadText, signatureText] = String(token || '').split('.');
    if (!headerText || !payloadText || !signatureText) return null;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerText)));
    if (header.alg !== 'HS256') return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(tokenSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signatureText), new TextEncoder().encode(`${headerText}.${payloadText}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadText)));
    if (!intParam(payload.id) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return { id: Number(payload.id), username: String(payload.username || '') };
  } catch {
    return null;
  }
}

async function authenticate(env, request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Missing token');
  const user = await verifyToken(env, header.slice(7));
  if (!user) throw new HttpError(403, 'Invalid or expired token');
  return user;
}

function requireAdmin(env, request) {
  const configured = env.SERVER_ADMIN_PASSWORD;
  if (!configured || request.headers.get('x-admin-password') !== configured) {
    throw new HttpError(403, 'Admin password required');
  }
}

async function storeLargeContent(env, kind, content) {
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength <= CHUNK_CONTENT_THRESHOLD) return content;
  const contentId = `${kind}:${crypto.randomUUID()}`;
  const statements = [];
  for (let offset = 0, index = 0; offset < encoded.length; offset += CHUNK_BYTES, index += 1) {
    statements.push(
      env.DB.prepare('INSERT INTO content_chunks (content_id, chunk_index, data) VALUES (?, ?, ?)')
        .bind(contentId, index, bytesToBase64(encoded.subarray(offset, offset + CHUNK_BYTES)))
    );
  }
  try {
    for (let index = 0; index < statements.length; index += 10) {
      await env.DB.batch(statements.slice(index, index + 10));
    }
  } catch (error) {
    await run(env, 'DELETE FROM content_chunks WHERE content_id = ?', contentId);
    throw error;
  }
  return `${CHUNK_MARKER}${contentId}`;
}

async function hydrateContent(env, value) {
  if (typeof value !== 'string' || !value.startsWith(CHUNK_MARKER)) return value;
  const contentId = value.slice(CHUNK_MARKER.length);
  const chunks = await many(env, 'SELECT data FROM content_chunks WHERE content_id = ? ORDER BY chunk_index ASC', contentId);
  if (!chunks.length) return '';
  const decoded = chunks.map((chunk) => base64ToBytes(chunk.data));
  const length = decoded.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of decoded) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function deleteStoredContent(env, value) {
  if (typeof value === 'string' && value.startsWith(CHUNK_MARKER)) {
    await run(env, 'DELETE FROM content_chunks WHERE content_id = ?', value.slice(CHUNK_MARKER.length));
  }
}

async function hydrateRows(env, rows, field = 'content') {
  return Promise.all(rows.map(async (row) => ({ ...row, [field]: await hydrateContent(env, row[field]) })));
}

async function emit(env, event) {
  const id = env.CHAT_HUB.idFromName('global');
  const stub = env.CHAT_HUB.get(id);
  await stub.fetch('https://chat-hub/emit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
}

async function openWebSocket(request, env, url) {
  const user = await verifyToken(env, url.searchParams.get('token'));
  if (!user) return new Response('Invalid token', { status: 401 });
  const id = env.CHAT_HUB.idFromName('global');
  const headers = new Headers(request.headers);
  headers.set('x-user-id', String(user.id));
  return env.CHAT_HUB.get(id).fetch('https://chat-hub/connect', { headers });
}

async function isGroupMember(env, groupId, userId) {
  return Boolean(await one(env, 'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId));
}

function publicAnnouncement(row) {
  if (!row || !Number(row.active)) return null;
  return { id: row.id, title: row.title || '', content: row.content || '', created_at: row.created_at };
}

async function routeApi(request, env, url) {
  const method = request.method;
  const path = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(request) : {};

  if (method === 'POST' && path === '/api/register') return register(env, body);
  if (method === 'POST' && path === '/api/login') return login(env, body);
  if (method === 'GET' && path === '/api/server/announcement') return getAnnouncement(env);

  const user = await authenticate(env, request);

  if (method === 'GET' && path === '/api/user/profile') return getOwnProfile(env, user);
  if (method === 'PUT' && path === '/api/user/profile') return updateProfile(env, user, body);
  if (method === 'PUT' && path === '/api/user/password') return updatePassword(env, user, body);
  if (method === 'PUT' && path === '/api/user/public-key') return updatePublicKey(env, user, body);
  if (method === 'GET' && path === '/api/search-users') return searchUsers(env, user, url);
  if (method === 'POST' && path === '/api/friend-request') return createFriendRequest(env, user, body);
  if (method === 'GET' && path === '/api/friends') return getFriends(env, user);
  if (method === 'POST' && path === '/api/messages') return sendDirectMessage(env, user, body);
  if (method === 'GET' && path === '/api/chat-list') return getChatList(env, user);
  if (method === 'POST' && path === '/api/groups') return createGroup(env, user, body);
  if (method === 'GET' && path === '/api/groups') return getGroups(env, user);
  if (method === 'GET' && path === '/api/public/messages') return getPublicMessages(env);
  if (method === 'POST' && path === '/api/public/messages') return sendPublicMessage(env, user, body);
  if (method === 'GET' && path === '/api/server/status') return getServerStatus(env, request);
  if (method === 'POST' && path === '/api/server/announcement') return setAnnouncement(env, request, user, body);
  if (method === 'POST' && path === '/api/moments') return createMoment(env, user, body);
  if (method === 'GET' && path === '/api/moments') return getMoments(env, user, url);

  let match = path.match(/^\/api\/user\/(\d+)\/public-key$/);
  if (method === 'GET' && match) return getPublicKey(env, intParam(match[1]));
  match = path.match(/^\/api\/user\/(\d+)\/profile$/);
  if (method === 'GET' && match) return getUserProfile(env, user, intParam(match[1]));
  match = path.match(/^\/api\/friend-request\/(\d+)$/);
  if (method === 'POST' && match) return answerFriendRequest(env, user, intParam(match[1]), body);
  match = path.match(/^\/api\/friends\/(\d+)$/);
  if (method === 'DELETE' && match) return deleteFriend(env, user, intParam(match[1]));
  match = path.match(/^\/api\/block\/(\d+)$/);
  if (method === 'POST' && match) return blockFriend(env, user, intParam(match[1]));
  if (method === 'DELETE' && match) return unblockFriend(env, user, intParam(match[1]));
  match = path.match(/^\/api\/messages\/(\d+)$/);
  if (method === 'GET' && match) return getDirectMessages(env, user, intParam(match[1]));
  match = path.match(/^\/api\/mark-read\/(\d+)$/);
  if (method === 'POST' && match) return markDirectRead(env, user, intParam(match[1]));
  match = path.match(/^\/api\/groups\/(\d+)\/members$/);
  if (method === 'GET' && match) return getGroupMembers(env, user, intParam(match[1]));
  match = path.match(/^\/api\/groups\/(\d+)\/messages$/);
  if (method === 'GET' && match) return getGroupMessages(env, user, intParam(match[1]));
  if (method === 'POST' && match) return sendGroupMessage(env, user, intParam(match[1]), body);
  match = path.match(/^\/api\/groups\/(\d+)\/mark-read$/);
  if (method === 'POST' && match) return markGroupRead(env, user, intParam(match[1]));
  match = path.match(/^\/api\/moments\/(\d+)\/like$/);
  if (method === 'POST' && match) return toggleMomentLike(env, user, intParam(match[1]));
  match = path.match(/^\/api\/moments\/(\d+)\/comment$/);
  if (method === 'POST' && match) return addMomentComment(env, user, intParam(match[1]), body);

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        await ensureSchema(env);
        return openWebSocket(request, env, url);
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Password',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
          }
        });
      }
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        return await routeApi(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  }
};

async function register(env, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const publicKey = body.public_key;
  if (!username || !password || !publicKey) {
    throw new HttpError(400, 'Username, password and public key are required');
  }
  if (username.length > 32) throw new HttpError(400, 'Username is too long');
  if (password.length < 4) throw new HttpError(400, 'Password must be at least 4 characters');
  const hash = await passwordHash(password);
  let result;
  try {
    result = await run(
      env,
      'INSERT INTO users (username, password_hash, public_key, nickname) VALUES (?, ?, ?, ?)',
      username,
      hash,
      JSON.stringify(publicKey),
      username
    );
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) throw new HttpError(409, 'Username already exists');
    throw error;
  }
  const id = Number(result.meta.last_row_id);
  const token = await signToken(env, { id, username });
  return json({ token, user: { id, username, nickname: username, avatar: '', bio: '' } });
}

async function login(env, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw new HttpError(400, 'Username and password are required');
  const user = await one(env, 'SELECT * FROM users WHERE username = ? COLLATE NOCASE', username);
  if (!user || !(await passwordMatches(password, user.password_hash))) {
    throw new HttpError(400, 'Incorrect username or password');
  }
  const token = await signToken(env, user);
  return json({
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname || user.username,
      avatar: user.avatar || '',
      bio: user.bio || ''
    }
  });
}

async function getOwnProfile(env, user) {
  const profile = await one(env, 'SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', user.id);
  if (!profile) throw new HttpError(404, 'User not found');
  return json({ user: profile });
}

async function updateProfile(env, user, body) {
  const updates = [];
  const params = [];
  if (body.nickname !== undefined) {
    const nickname = String(body.nickname || '').trim();
    if (!nickname) throw new HttpError(400, 'Nickname cannot be empty');
    if (nickname.length > 24) throw new HttpError(400, 'Nickname is too long');
    updates.push('nickname = ?');
    params.push(nickname);
  }
  if (body.avatar !== undefined) {
    const avatar = String(body.avatar || '');
    if (avatar.length > 5 * 1024 * 1024) throw new HttpError(400, 'Avatar image is too large');
    updates.push('avatar = ?');
    params.push(avatar);
  }
  if (body.bio !== undefined) {
    const bio = String(body.bio || '').trim();
    if (bio.length > 160) throw new HttpError(400, 'Bio is too long');
    updates.push('bio = ?');
    params.push(bio);
  }
  if (!updates.length) throw new HttpError(400, 'No fields to update');
  await run(env, `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params, user.id);
  return json({ success: true });
}

async function updatePassword(env, user, body) {
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!oldPassword || !newPassword) throw new HttpError(400, 'Old and new password are required');
  if (newPassword.length < 4) throw new HttpError(400, 'New password must be at least 4 characters');
  const row = await one(env, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!row) throw new HttpError(500, 'User data error');
  if (!(await passwordMatches(oldPassword, row.password_hash))) throw new HttpError(400, 'Old password is incorrect');
  await run(env, 'UPDATE users SET password_hash = ? WHERE id = ?', await passwordHash(newPassword), user.id);
  return json({ success: true });
}

async function updatePublicKey(env, user, body) {
  if (!body.public_key) throw new HttpError(400, 'Public key is required');
  await run(env, 'UPDATE users SET public_key = ? WHERE id = ?', JSON.stringify(body.public_key), user.id);
  return json({ success: true });
}

async function getPublicKey(env, userId) {
  if (!userId) throw new HttpError(400, 'Invalid user id');
  const row = await one(env, 'SELECT public_key FROM users WHERE id = ?', userId);
  if (!row) throw new HttpError(404, 'User not found');
  const publicKey = safeParse(row.public_key);
  if (!publicKey) throw new HttpError(500, 'Invalid public key data');
  return json({ public_key: publicKey });
}

async function getUserProfile(env, currentUser, userId) {
  if (!userId) throw new HttpError(400, 'Invalid user id');
  const profile = await one(env, 'SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', userId);
  if (!profile) throw new HttpError(404, 'User not found');
  const rows = await many(
    env,
    `SELECT m.*, u.username, u.nickname, u.avatar
     FROM moments m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 30`,
    userId
  );
  const moments = rows.filter((moment) => !parseJsonArray(moment.blocked).map(Number).includes(currentUser.id));
  return json({ user: profile, moments });
}

async function searchUsers(env, user, url) {
  const query = String(url.searchParams.get('q') || '').trim();
  if (!query) return json({ users: [] });
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const users = await many(
    env,
    `SELECT id, username, nickname, avatar, bio, public_key FROM users
     WHERE (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\') AND id != ? LIMIT 10`,
    `%${escaped}%`,
    `%${escaped}%`,
    user.id
  );
  return json({ users: users.map((entry) => ({ ...entry, public_key: safeParse(entry.public_key) })) });
}

async function createFriendRequest(env, user, body) {
  const toId = intParam(body.to_id);
  if (!toId) throw new HttpError(400, 'Invalid target user id');
  if (toId === user.id) throw new HttpError(400, 'You cannot add yourself');
  if (!(await one(env, 'SELECT id FROM users WHERE id = ?', toId))) throw new HttpError(404, 'User not found');
  if (await one(env, 'SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', user.id, toId)) {
    throw new HttpError(400, 'Already friends');
  }
  const pending = await one(
    env,
    `SELECT id FROM friend_requests
     WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status = 'pending'`,
    user.id,
    toId,
    toId,
    user.id
  );
  if (pending) throw new HttpError(400, 'Friend request already exists');
  await run(env, 'INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?)', user.id, toId);
  await emit(env, { scope: 'user', user_ids: [toId], payload: { type: 'friend_request' } });
  return json({ success: true });
}

async function answerFriendRequest(env, user, fromId, body) {
  const action = body.action;
  if (!fromId || !['accept', 'reject'].includes(action)) throw new HttpError(400, 'Invalid request');
  const request = await one(
    env,
    `SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'`,
    fromId,
    user.id
  );
  if (!request) throw new HttpError(404, 'Request not found');
  const statements = [
    env.DB.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').bind(action === 'accept' ? 'accepted' : 'rejected', request.id)
  ];
  if (action === 'accept') {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').bind(user.id, fromId),
      env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').bind(fromId, user.id)
    );
  }
  await env.DB.batch(statements);
  if (action === 'accept') {
    await emit(env, { scope: 'user', user_ids: [fromId], payload: { type: 'friends_changed' } });
  }
  return json({ success: true });
}

async function getFriends(env, user) {
  const friends = await many(
    env,
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.public_key,
       (SELECT COUNT(*) FROM blocks WHERE user_id = ? AND blocked_user_id = u.id) AS is_blocked
     FROM friends f JOIN users u ON f.friend_id = u.id
     WHERE f.user_id = ?
     ORDER BY COALESCE(u.nickname, u.username) COLLATE NOCASE ASC`,
    user.id,
    user.id
  );
  const requests = await many(
    env,
    `SELECT fr.id, fr.from_id, u.username, u.nickname, u.avatar
     FROM friend_requests fr JOIN users u ON fr.from_id = u.id
     WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
    user.id
  );
  return json({
    friends: friends.map((friend) => ({ ...friend, public_key: safeParse(friend.public_key) })),
    requests
  });
}

async function deleteFriend(env, user, friendId) {
  if (!friendId) throw new HttpError(400, 'Invalid friend id');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').bind(user.id, friendId, friendId, user.id),
    env.DB.prepare('DELETE FROM blocks WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)').bind(user.id, friendId, friendId, user.id),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(user.id, friendId, friendId, user.id)
  ]);
  await emit(env, { scope: 'user', user_ids: [friendId], payload: { type: 'friends_changed' } });
  return json({ success: true });
}

async function blockFriend(env, user, friendId) {
  if (!friendId) throw new HttpError(400, 'Invalid friend id');
  if (!(await one(env, 'SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', user.id, friendId))) {
    throw new HttpError(403, 'You can only block friends');
  }
  await run(env, 'INSERT OR IGNORE INTO blocks (user_id, blocked_user_id) VALUES (?, ?)', user.id, friendId);
  return json({ success: true });
}

async function unblockFriend(env, user, friendId) {
  if (!friendId) throw new HttpError(400, 'Invalid friend id');
  await run(env, 'DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?', user.id, friendId);
  return json({ success: true });
}

async function sendDirectMessage(env, user, body) {
  const toId = intParam(body.to_id);
  const content = String(body.content || '');
  if (!toId || !content) throw new HttpError(400, 'Missing message data');
  if (content.length > MAX_CONTENT_LENGTH) throw new HttpError(400, 'Message is too large');
  if (!(await one(env, 'SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', user.id, toId))) {
    throw new HttpError(403, 'Not friends');
  }
  const storedContent = await storeLargeContent(env, 'direct', content);
  let result;
  try {
    result = await run(env, 'INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)', user.id, toId, storedContent);
  } catch (error) {
    await deleteStoredContent(env, storedContent);
    throw error;
  }
  const message = {
    id: Number(result.meta.last_row_id),
    from_id: user.id,
    to_id: toId,
    content,
    read_at: null,
    created_at: new Date().toISOString()
  };
  await emit(env, { scope: 'user', user_ids: [toId], payload: { type: 'new_message', message } });
  return json({ message });
}

async function getDirectMessages(env, user, friendId) {
  if (!friendId) throw new HttpError(400, 'Invalid friend id');
  const rows = await many(
    env,
    `SELECT * FROM messages
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
     ORDER BY created_at ASC, id ASC`,
    user.id,
    friendId,
    friendId,
    user.id
  );
  return json({ messages: await hydrateRows(env, rows) });
}

async function getChatList(env, user) {
  const rows = await many(
    env,
    `SELECT u.id AS friend_id, u.username AS friend_name, u.nickname AS friend_nickname,
       u.avatar AS friend_avatar, lm.content AS last_preview, lm.created_at AS last_time,
       (SELECT COUNT(*) FROM messages unread
        WHERE unread.from_id = u.id AND unread.to_id = ? AND unread.read_at IS NULL) AS unread_count
     FROM friends f JOIN users u ON u.id = f.friend_id
     LEFT JOIN messages lm ON lm.id = (
       SELECT id FROM messages
       WHERE (from_id = ? AND to_id = u.id) OR (from_id = u.id AND to_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 1
     )
     WHERE f.user_id = ?
     ORDER BY COALESCE(lm.created_at, f.created_at) DESC`,
    user.id,
    user.id,
    user.id,
    user.id
  );
  return json({ chats: await hydrateRows(env, rows, 'last_preview') });
}

async function markDirectRead(env, user, friendId) {
  if (!friendId) throw new HttpError(400, 'Invalid friend id');
  const readAt = new Date().toISOString();
  const result = await run(
    env,
    'UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL',
    readAt,
    friendId,
    user.id
  );
  await emit(env, {
    scope: 'user',
    user_ids: [friendId],
    payload: { type: 'read_receipt', by: user.id, read_at: readAt }
  });
  return json({ success: true, updated: Number(result.meta.changes || 0), read_at: readAt });
}

async function createGroup(env, user, body) {
  const name = String(body.name || '').trim();
  const members = Array.isArray(body.members) ? body.members : [];
  if (!name || name.length > 36) throw new HttpError(400, 'Group name must be 1-36 characters');
  if (members.length < 2) throw new HttpError(400, 'Pick at least one friend');
  const normalized = new Map();
  for (const member of members) {
    const userId = intParam(member?.user_id);
    const wrappedKey = String(member?.wrapped_key || '');
    if (userId && wrappedKey && wrappedKey.length <= 128 * 1024) normalized.set(userId, wrappedKey);
  }
  if (!normalized.has(user.id)) throw new HttpError(400, 'Missing your encrypted group key');
  const groupResult = await run(env, 'INSERT INTO groups (name, owner_id) VALUES (?, ?)', name, user.id);
  const groupId = Number(groupResult.meta.last_row_id);
  try {
    await env.DB.batch(
      [...normalized].map(([userId, wrappedKey]) =>
        env.DB.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, wrapped_key) VALUES (?, ?, ?, ?)')
          .bind(groupId, userId, userId === user.id ? 'owner' : 'member', wrappedKey)
      )
    );
  } catch (error) {
    await run(env, 'DELETE FROM groups WHERE id = ?', groupId);
    throw error;
  }
  if (!(await isGroupMember(env, groupId, user.id))) throw new HttpError(500, 'Create group failed');
  await emit(env, { scope: 'user', user_ids: [...normalized.keys()], payload: { type: 'groups_changed' } });
  return json({ success: true, group_id: groupId });
}

async function getGroups(env, user) {
  const groups = await many(
    env,
    `SELECT g.id, g.name, g.owner_id, g.created_at, gm.wrapped_key,
       owner.username AS owner_username, owner.nickname AS owner_nickname, owner.public_key AS owner_public_key,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
       (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_time,
       (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_preview
     FROM group_members gm
     JOIN groups g ON g.id = gm.group_id
     JOIN users owner ON owner.id = g.owner_id
     WHERE gm.user_id = ?
     ORDER BY COALESCE(last_time, g.created_at) DESC`,
    user.id
  );
  const hydrated = await hydrateRows(env, groups, 'last_preview');
  return json({ groups: hydrated.map((group) => ({ ...group, owner_public_key: safeParse(group.owner_public_key) })) });
}

async function getGroupMembers(env, user, groupId) {
  if (!groupId) throw new HttpError(400, 'Invalid group id');
  if (!(await isGroupMember(env, groupId, user.id))) throw new HttpError(403, 'Not a group member');
  const members = await many(
    env,
    `SELECT u.id, u.username, u.nickname, u.avatar, gm.role
     FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY gm.created_at ASC`,
    groupId
  );
  return json({ members });
}

async function getGroupMessages(env, user, groupId) {
  if (!groupId) throw new HttpError(400, 'Invalid group id');
  if (!(await isGroupMember(env, groupId, user.id))) throw new HttpError(403, 'Not a group member');
  const rows = await many(
    env,
    `SELECT gm.*, u.username, u.nickname, u.avatar
     FROM group_messages gm JOIN users u ON u.id = gm.from_id
     WHERE gm.group_id = ? ORDER BY gm.created_at ASC, gm.id ASC`,
    groupId
  );
  const messages = await hydrateRows(env, rows);
  return json({ messages: messages.map((message) => ({ ...message, read_by: parseJsonArray(message.read_by) })) });
}

async function sendGroupMessage(env, user, groupId, body) {
  const content = String(body.content || '');
  if (!groupId || !content) throw new HttpError(400, 'Missing group message data');
  if (content.length > MAX_CONTENT_LENGTH) throw new HttpError(400, 'Message is too large');
  if (!(await isGroupMember(env, groupId, user.id))) throw new HttpError(403, 'Not a group member');
  const storedContent = await storeLargeContent(env, 'group', content);
  let result;
  try {
    result = await run(
      env,
      'INSERT INTO group_messages (group_id, from_id, content, read_by) VALUES (?, ?, ?, ?)',
      groupId,
      user.id,
      storedContent,
      JSON.stringify([user.id])
    );
  } catch (error) {
    await deleteStoredContent(env, storedContent);
    throw error;
  }
  const message = {
    id: Number(result.meta.last_row_id),
    group_id: groupId,
    from_id: user.id,
    content,
    read_by: [user.id],
    created_at: new Date().toISOString()
  };
  await emit(env, {
    scope: 'group',
    group_id: groupId,
    except_user_id: user.id,
    payload: { type: 'new_group_message', group_id: groupId, message }
  });
  return json({ message });
}

async function markGroupRead(env, user, groupId) {
  if (!groupId) throw new HttpError(400, 'Invalid group id');
  if (!(await isGroupMember(env, groupId, user.id))) throw new HttpError(403, 'Not a group member');
  const messages = await many(env, 'SELECT id, read_by FROM group_messages WHERE group_id = ? AND from_id != ?', groupId, user.id);
  const updates = [];
  for (const message of messages) {
    const readBy = parseJsonArray(message.read_by).map(Number);
    if (!readBy.includes(user.id)) {
      readBy.push(user.id);
      updates.push(env.DB.prepare('UPDATE group_messages SET read_by = ? WHERE id = ?').bind(JSON.stringify(readBy), message.id));
    }
  }
  if (updates.length) await env.DB.batch(updates);
  await emit(env, {
    scope: 'group',
    group_id: groupId,
    except_user_id: user.id,
    payload: { type: 'group_read_receipt', group_id: groupId, by: user.id }
  });
  return json({ success: true, updated: updates.length });
}

async function getPublicMessages(env) {
  const rows = await many(
    env,
    `SELECT * FROM (
       SELECT pm.*, u.username, u.nickname, u.avatar
       FROM public_messages pm JOIN users u ON u.id = pm.from_id
       ORDER BY pm.created_at DESC, pm.id DESC LIMIT 120
     ) ORDER BY created_at ASC, id ASC`
  );
  return json({ messages: await hydrateRows(env, rows) });
}

async function sendPublicMessage(env, user, body) {
  const content = String(body.content || '');
  if (!content) throw new HttpError(400, 'Missing message data');
  if (content.length > MAX_CONTENT_LENGTH) throw new HttpError(400, 'Message is too large');
  const storedContent = await storeLargeContent(env, 'public', content);
  let result;
  try {
    result = await run(env, 'INSERT INTO public_messages (from_id, content) VALUES (?, ?)', user.id, storedContent);
  } catch (error) {
    await deleteStoredContent(env, storedContent);
    throw error;
  }
  const profile = await one(env, 'SELECT username, nickname, avatar FROM users WHERE id = ?', user.id);
  const message = {
    id: Number(result.meta.last_row_id),
    from_id: user.id,
    content,
    created_at: new Date().toISOString(),
    username: profile?.username,
    nickname: profile?.nickname,
    avatar: profile?.avatar
  };
  await emit(env, {
    scope: 'all',
    except_user_id: user.id,
    payload: { type: 'new_public_message', message }
  });
  return json({ message });
}

async function getServerStatus(env, request) {
  requireAdmin(env, request);
  const stats = await one(
    env,
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM friends) AS friends,
       (SELECT COUNT(*) FROM messages) AS direct_messages,
       (SELECT COUNT(*) FROM groups) AS groups,
       (SELECT COUNT(*) FROM group_messages) AS group_messages,
       (SELECT COUNT(*) FROM public_messages) AS public_messages,
       (SELECT COUNT(*) FROM moments) AS moments,
       (SELECT value FROM app_meta WHERE key = 'created_at') AS created_at`
  );
  const hubResponse = await env.CHAT_HUB.get(env.CHAT_HUB.idFromName('global')).fetch('https://chat-hub/stats');
  const hubStats = hubResponse.ok ? await hubResponse.json() : { online_users: 0 };
  const startedAt = Date.parse(stats.created_at || '') || Date.now();
  return json({
    stats: {
      online_users: Number(hubStats.online_users || 0),
      uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      users: Number(stats.users || 0),
      friends: Number(stats.friends || 0),
      direct_messages: Number(stats.direct_messages || 0),
      groups: Number(stats.groups || 0),
      group_messages: Number(stats.group_messages || 0),
      public_messages: Number(stats.public_messages || 0),
      moments: Number(stats.moments || 0)
    }
  });
}

async function getAnnouncement(env) {
  const row = await one(env, 'SELECT * FROM server_announcements WHERE active = 1 ORDER BY id DESC LIMIT 1');
  return json({ announcement: publicAnnouncement(row) });
}

async function setAnnouncement(env, request, user, body) {
  requireAdmin(env, request);
  const title = String(body.title || '').trim().slice(0, 80);
  const content = String(body.content || '').trim();
  const active = body.active === false ? 0 : 1;
  if (active && !content) throw new HttpError(400, 'Announcement cannot be empty');
  if (content.length > 1000) throw new HttpError(400, 'Announcement is too long');
  await run(env, 'UPDATE server_announcements SET active = 0 WHERE active = 1');
  if (!active) {
    await emit(env, { scope: 'all', payload: { type: 'server_announcement', announcement: null } });
    return json({ success: true, announcement: null });
  }
  const result = await run(
    env,
    'INSERT INTO server_announcements (title, content, active, created_by) VALUES (?, ?, 1, ?)',
    title,
    content,
    user.id
  );
  const row = await one(env, 'SELECT * FROM server_announcements WHERE id = ?', result.meta.last_row_id);
  const announcement = publicAnnouncement(row);
  await emit(env, { scope: 'all', payload: { type: 'server_announcement', announcement } });
  return json({ success: true, announcement });
}

async function createMoment(env, user, body) {
  const content = String(body.content || '').trim();
  const blocked = Array.isArray(body.blocked) ? [...new Set(body.blocked.map(intParam).filter(Boolean))] : [];
  if (!content) throw new HttpError(400, 'Content cannot be empty');
  if (content.length > 1000) throw new HttpError(400, 'Content is too long');
  const result = await run(
    env,
    'INSERT INTO moments (user_id, content, blocked) VALUES (?, ?, ?)',
    user.id,
    content,
    JSON.stringify(blocked)
  );
  await emit(env, {
    scope: 'all',
    except_user_ids: [user.id, ...blocked],
    payload: { type: 'new_moment' }
  });
  return json({ success: true, moment_id: Number(result.meta.last_row_id) });
}

async function getMoments(env, user, url) {
  const profileUserId = url.searchParams.get('user_id') ? intParam(url.searchParams.get('user_id')) : null;
  const blockRows = await many(
    env,
    `SELECT blocked_user_id FROM blocks WHERE user_id = ?
     UNION SELECT user_id AS blocked_user_id FROM blocks WHERE blocked_user_id = ?`,
    user.id,
    user.id
  );
  const blockedUsers = new Set(blockRows.map((row) => Number(row.blocked_user_id)));
  const params = [user.id];
  let userFilter = '';
  if (profileUserId) {
    userFilter = 'AND m.user_id = ?';
    params.push(profileUserId);
  }
  const moments = await many(
    env,
    `SELECT m.*, u.username, u.nickname, u.avatar,
       (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) AS like_count,
       (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) AS liked_by_me
     FROM moments m JOIN users u ON m.user_id = u.id
     WHERE 1 = 1 ${userFilter}
     ORDER BY m.created_at DESC LIMIT 100`,
    ...params
  );
  const visible = moments
    .filter((moment) => !blockedUsers.has(Number(moment.user_id)))
    .filter((moment) => !parseJsonArray(moment.blocked).map(Number).includes(user.id))
    .slice(0, 50);
  if (!visible.length) return json({ moments: [] });
  const placeholders = visible.map(() => '?').join(',');
  const comments = await many(
    env,
    `SELECT mc.*, u.username, u.nickname
     FROM moment_comments mc JOIN users u ON mc.user_id = u.id
     WHERE mc.moment_id IN (${placeholders}) ORDER BY mc.created_at ASC`,
    ...visible.map((moment) => moment.id)
  );
  const commentsByMoment = new Map();
  for (const comment of comments) {
    if (!commentsByMoment.has(comment.moment_id)) commentsByMoment.set(comment.moment_id, []);
    commentsByMoment.get(comment.moment_id).push(comment);
  }
  return json({
    moments: visible.map((moment) => ({
      ...moment,
      comments: commentsByMoment.get(moment.id) || [],
      likes: moment.liked_by_me ? [user.id] : [],
      blocked: parseJsonArray(moment.blocked)
    }))
  });
}

async function toggleMomentLike(env, user, momentId) {
  if (!momentId) throw new HttpError(400, 'Invalid moment id');
  if (!(await one(env, 'SELECT id FROM moments WHERE id = ?', momentId))) throw new HttpError(404, 'Moment not found');
  const existing = await one(env, 'SELECT id FROM moment_likes WHERE moment_id = ? AND user_id = ?', momentId, user.id);
  if (existing) {
    await run(env, 'DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', momentId, user.id);
  } else {
    await run(env, 'INSERT OR IGNORE INTO moment_likes (moment_id, user_id) VALUES (?, ?)', momentId, user.id);
  }
  const count = await one(env, 'SELECT COUNT(*) AS count FROM moment_likes WHERE moment_id = ?', momentId);
  return json({ liked: !existing, like_count: Number(count.count || 0) });
}

async function addMomentComment(env, user, momentId, body) {
  const content = String(body.content || '').trim();
  if (!momentId || !content) throw new HttpError(400, 'Invalid comment');
  if (content.length > 300) throw new HttpError(400, 'Comment is too long');
  if (!(await one(env, 'SELECT id FROM moments WHERE id = ?', momentId))) throw new HttpError(404, 'Moment not found');
  await run(env, 'INSERT INTO moment_comments (moment_id, user_id, content) VALUES (?, ?, ?)', momentId, user.id, content);
  return json({ success: true });
}

export class ChatHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return this.connect(request);
    if (url.pathname === '/emit' && request.method === 'POST') {
      await this.dispatch(await request.json());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/stats') {
      return json({ online_users: this.onlineUserIds().size });
    }
    return new Response('Not found', { status: 404 });
  }

  async connect(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    const userId = intParam(request.headers.get('x-user-id'));
    if (!userId) return new Response('Invalid user', { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tag = `user:${userId}`;
    const wasOffline = this.ctx.getWebSockets(tag).length === 0;
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ userId });
    const peers = await this.presencePeers(userId);
    const online = peers.filter((peerId) => this.ctx.getWebSockets(`user:${peerId}`).length > 0);
    server.send(JSON.stringify({ type: 'presence_snapshot', online }));
    if (wasOffline) await this.broadcastPresence(userId, true, peers);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, data) {
    try {
      const event = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
      if (event.type !== 'typing') return;
      const attachment = socket.deserializeAttachment();
      const userId = intParam(attachment?.userId);
      if (!userId) return;
      const payload = {
        type: 'typing',
        from_id: userId,
        is_typing: Boolean(event.is_typing),
        target_type: event.target_type
      };
      if (event.target_type === 'direct') {
        const toId = intParam(event.to_id);
        if (toId && await one(this.env, 'SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', userId, toId)) {
          this.sendToUser(toId, { ...payload, to_id: toId });
        }
      } else if (event.target_type === 'group') {
        const groupId = intParam(event.group_id);
        if (groupId && await isGroupMember(this.env, groupId, userId)) {
          await this.sendToGroup(groupId, { ...payload, group_id: groupId }, new Set([userId]));
        }
      } else if (event.target_type === 'public') {
        this.sendToAll({ ...payload, target_type: 'public' }, new Set([userId]));
      }
    } catch (error) {
      console.error('WebSocket message error', error);
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    const userId = intParam(attachment?.userId);
    if (!userId) return;
    await Promise.resolve();
    if (this.ctx.getWebSockets(`user:${userId}`).length === 0) {
      await this.broadcastPresence(userId, false);
    }
  }

  webSocketError(socket) {
    try {
      socket.close(1011, 'WebSocket error');
    } catch {}
  }

  onlineUserIds() {
    const users = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const userId = intParam(socket.deserializeAttachment()?.userId);
      if (userId) users.add(userId);
    }
    return users;
  }

  sendToUser(userId, payload) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets(`user:${userId}`)) {
      try {
        socket.send(encoded);
      } catch {}
    }
  }

  sendToAll(payload, excluded = new Set()) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      const userId = intParam(socket.deserializeAttachment()?.userId);
      if (!userId || excluded.has(userId)) continue;
      try {
        socket.send(encoded);
      } catch {}
    }
  }

  async sendToGroup(groupId, payload, excluded = new Set()) {
    const members = await many(this.env, 'SELECT user_id FROM group_members WHERE group_id = ?', groupId);
    for (const member of members) {
      const userId = Number(member.user_id);
      if (!excluded.has(userId)) this.sendToUser(userId, payload);
    }
  }

  async dispatch(event) {
    const excluded = new Set([
      ...(event.except_user_ids || []).map(Number),
      ...(event.except_user_id ? [Number(event.except_user_id)] : [])
    ]);
    if (event.scope === 'user') {
      for (const userId of event.user_ids || []) {
        if (!excluded.has(Number(userId))) this.sendToUser(Number(userId), event.payload);
      }
    } else if (event.scope === 'group') {
      await this.sendToGroup(Number(event.group_id), event.payload, excluded);
    } else if (event.scope === 'all') {
      this.sendToAll(event.payload, excluded);
    }
  }

  async presencePeers(userId) {
    const rows = await many(
      this.env,
      `SELECT friend_id AS user_id FROM friends WHERE user_id = ?
       UNION
       SELECT gm2.user_id FROM group_members gm1
       JOIN group_members gm2 ON gm2.group_id = gm1.group_id
       WHERE gm1.user_id = ? AND gm2.user_id != ?`,
      userId,
      userId,
      userId
    );
    return rows.map((row) => Number(row.user_id));
  }

  async broadcastPresence(userId, online, knownPeers) {
    const peers = knownPeers || await this.presencePeers(userId);
    for (const peerId of peers) {
      this.sendToUser(peerId, { type: 'presence', user_id: userId, online });
    }
  }
}
