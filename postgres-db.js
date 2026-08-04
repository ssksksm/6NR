const { Pool, types } = require('pg');

types.setTypeParser(20, Number);

function replacePlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeSql(source, returnInsertedId = false) {
  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(source);
  let sql = source
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .trim()
    .replace(/;$/, '');

  sql = replacePlaceholders(sql);
  if (ignoreConflict) sql += ' ON CONFLICT DO NOTHING';
  if (returnInsertedId && /^INSERT\s+INTO/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
    sql += ' RETURNING id';
  }
  return sql;
}

function createPool() {
  if (process.env.USE_PG_MEM === '1') {
    const { newDb } = require('pg-mem');
    const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memoryDb.adapters.createPg();
    return new adapter.Pool();
  }

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URI;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const ssl = process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;
  return new Pool({ connectionString, ssl, max: 5 });
}

function reportError(error) {
  if (process.env.DB_DEBUG === '1') {
    console.error('Database query failed:', error);
  }
}

class PostgresDatabase {
  constructor() {
    this.pool = createPool();
    this.tail = Promise.resolve();
    this.initializationError = null;
  }

  enqueue(task) {
    const operation = this.tail.then(task);
    this.tail = operation.catch(() => {});
    return operation;
  }

  serialize(callback) {
    callback();
    return this;
  }

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params ||= [];

    this.enqueue(async () => {
      const result = await this.pool.query(normalizeSql(sql, true), params);
      const context = {
        lastID: result.rows[0]?.id ?? null,
        changes: result.rowCount
      };
      if (callback) callback.call(context, null);
    }).catch((error) => {
      reportError(error);
      if (callback) callback.call({ lastID: null, changes: 0 }, error);
      else this.initializationError = error;
    });
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    this.enqueue(async () => {
      const result = await this.pool.query(normalizeSql(sql), params || []);
      callback(null, result.rows[0]);
    }).catch((error) => {
      reportError(error);
      callback(error);
    });
    return this;
  }

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    this.enqueue(async () => {
      const result = await this.pool.query(normalizeSql(sql), params || []);
      callback(null, result.rows);
    }).catch((error) => {
      reportError(error);
      callback(error);
    });
    return this;
  }

  async ready() {
    await this.tail;
    if (this.initializationError) throw this.initializationError;
  }

  async close() {
    await this.tail;
    await this.pool.end();
  }
}

module.exports = { PostgresDatabase };
