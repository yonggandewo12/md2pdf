/**
 * SQLite 服务：sqlite_query / sqlite_exec / sqlite_tables 工具的实现后端。
 *
 * 基于 better-sqlite3（原生模块，npm 提供各平台预编译，Node 18-26 实测可用）。
 * - query：SELECT，返回全部行（参数化绑定）；
 * - exec：INSERT/UPDATE/DELETE/DDL，返回 changes 与 lastInsertRowid；
 * - tables：列出表名与建表语句。
 *
 * 惰性加载：模块加载不 require better-sqlite3，首次调用才装载，
 * 二进制缺失时仅该工具报错，不影响 server 启动与其他工具。
 *
 * @author Liang.Xu
 */
import { existsSync } from 'fs';

export interface SqliteQueryOptions {
  dbPath: string;
  sql: string;
  /** 参数化绑定值，防 SQL 注入。 */
  params?: unknown[];
}

export interface SqliteRow {
  [column: string]: unknown;
}

export interface SqliteResult {
  success: boolean;
  rows?: SqliteRow[];
  rowCount?: number;
  changes?: number;
  lastInsertRowid?: number | bigint;
  tables?: { name: string; schema: string }[];
  error?: string;
  details?: { processingTime: number };
}

type SqliteDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  pragma(source: string, options?: Record<string, unknown>): unknown;
  close(): void;
};

/** 惰性加载 better-sqlite3 原生模块（预编译二进制缺失时抛带指引的错误）。 */
async function openDatabase(dbPath: string, allowCreate = false): Promise<SqliteDatabase> {
  let Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase;
  try {
    const mod = await import('better-sqlite3');
    Database = (mod.default ?? mod) as typeof Database;
  } catch (err) {
    throw new Error(
      `better-sqlite3 加载失败: ${err instanceof Error ? err.message : String(err)}。` +
        '请重新执行 npm install 安装预编译二进制。',
    );
  }
  return new Database(dbPath, { fileMustExist: !allowCreate });
}

function toRows(values: unknown[]): SqliteRow[] {
  return values.map((row) => {
    if (row !== null && typeof row === 'object') {
      return row as SqliteRow;
    }
    return { value: row };
  });
}

/** BigInt/Buffer 等 JSON 不友好值的可序列化包装。 */
function jsonify(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Buffer.isBuffer(value)) return { type: 'blob', length: value.length, base64: value.toString('base64') };
  return value;
}

export async function sqliteQuery(options: SqliteQueryOptions): Promise<SqliteResult> {
  const start = Date.now();
  try {
    if (!existsSync(options.dbPath)) {
      throw new Error(`数据库文件不存在: ${options.dbPath}`);
    }
    if (!options.sql.trim()) {
      throw new Error('sql 不能为空');
    }
    const db = await openDatabase(options.dbPath);
    try {
      const stmt = db.prepare(options.sql);
      const rows = toRows(stmt.all(...(options.params ?? [])) as unknown[]);
      return {
        success: true,
        rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonify(v)]))),
        rowCount: rows.length,
        details: { processingTime: Date.now() - start },
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), details: { processingTime: Date.now() - start } };
  }
}

export async function sqliteExec(options: SqliteQueryOptions): Promise<SqliteResult> {
  const start = Date.now();
  try {
    if (!options.sql.trim()) {
      throw new Error('sql 不能为空');
    }
    // exec 允许数据库文件不存在（新建库场景）
    const db = await openDatabase(options.dbPath, true);
    try {
      const stmt = db.prepare(options.sql);
      const info = stmt.run(...(options.params ?? []));
      return {
        success: true,
        changes: Number(info.changes),
        lastInsertRowid: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : undefined,
        details: { processingTime: Date.now() - start },
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), details: { processingTime: Date.now() - start } };
  }
}

export async function sqliteTables(dbPath: string): Promise<SqliteResult> {
  const start = Date.now();
  try {
    if (!existsSync(dbPath)) {
      throw new Error(`数据库文件不存在: ${dbPath}`);
    }
    const db = await openDatabase(dbPath);
    try {
      const rows = toRows(
        db
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as unknown[],
      );
      return {
        success: true,
        tables: rows.map((r) => ({ name: String(r.name), schema: String(r.sql ?? '') })),
        details: { processingTime: Date.now() - start },
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), details: { processingTime: Date.now() - start } };
  }
}
