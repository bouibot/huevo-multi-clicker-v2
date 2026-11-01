// db.mjs - SQLite (встроенный node:sqlite, без нативных зависимостей).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mskDay } from './config.mjs';

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_user_id INTEGER NOT NULL,
      tg_chat_id INTEGER NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      cookies TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      status_note TEXT NOT NULL DEFAULT '',
      balance INTEGER,
      clicks_total INTEGER NOT NULL DEFAULT 0,
      errors_total INTEGER NOT NULL DEFAULT 0,
      earned_today INTEGER NOT NULL DEFAULT 0,
      earned_day TEXT NOT NULL DEFAULT '',
      commission_paid INTEGER NOT NULL DEFAULT 0,
      last_click_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      tg_user_id INTEGER PRIMARY KEY,
      tg_chat_id INTEGER NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      tg_user_id INTEGER PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'admin',  -- 'owner' | 'admin'
      added_by INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  return new Db(db);
}

export const S = {
  RUNNING: 'running',
  LOGGING: 'logging',
  WAITING_CAPTCHA: 'waiting_captcha',
  NEED_LOGIN: 'need_login',
  CAPPED: 'capped',
  LOCKED: 'locked',
  ERROR: 'error',
  STOPPED: 'stopped',
};

export class Db {
  constructor(db) {
    this.db = db;
    this.q = {
      accAdd: db.prepare(
        `INSERT INTO accounts (tg_user_id, tg_chat_id, username, password, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
      accByUser: db.prepare(`SELECT * FROM accounts WHERE tg_user_id = ? ORDER BY id`),
      accAll: db.prepare(`SELECT * FROM accounts ORDER BY id`),
      accById: db.prepare(`SELECT * FROM accounts WHERE id = ?`),
      accByUsername: db.prepare(`SELECT * FROM accounts WHERE username = ? COLLATE NOCASE`),
      accByUserId: db.prepare(`SELECT * FROM accounts WHERE tg_user_id = ? AND id = ?`),
      accStatus: db.prepare(`UPDATE accounts SET status = ?, status_note = ? WHERE id = ?`),
      accCookies: db.prepare(`UPDATE accounts SET cookies = ? WHERE id = ?`),
      accBalance: db.prepare(
        `UPDATE accounts SET balance = ?, clicks_total = clicks_total + ?, errors_total = errors_total + ?
         WHERE id = ?`
      ),
      accEarned: db.prepare(`SELECT earned_day, earned_today, commission_paid FROM accounts WHERE id = ?`),
      accEarnedUpd: db.prepare(
        `UPDATE accounts SET earned_day = ?, earned_today = ?, commission_paid = ? WHERE id = ?`
      ),
      accLastClick: db.prepare(`UPDATE accounts SET last_click_at = ? WHERE id = ?`),
      accPassword: db.prepare(`UPDATE accounts SET password = ? WHERE id = ?`),
      accDelete: db.prepare(`DELETE FROM accounts WHERE id = ?`),
      setGet: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      setSet: db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ),
      transferAdd: db.prepare(
        `INSERT INTO transfers (ts, account_id, from_user, to_user, amount, status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      transfersLast: db.prepare(
        `SELECT * FROM transfers ORDER BY id DESC LIMIT ?`
      ),
      transfersCount: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM transfers WHERE status = 'ok'`),
      accountsActive: db.prepare(
        `SELECT COUNT(*) AS n FROM accounts WHERE status != 'stopped'`
      ),
      userUpsert: db.prepare(
        `INSERT INTO users (tg_user_id, tg_chat_id, username, first_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET
           tg_chat_id = excluded.tg_chat_id,
           username = excluded.username,
           first_name = excluded.first_name,
           last_seen_at = excluded.last_seen_at`
      ),
      broadcastTargets: db.prepare(
        `SELECT tg_chat_id FROM users
         UNION
         SELECT tg_chat_id FROM accounts`
      ),
      usersCount: db.prepare(`SELECT COUNT(*) AS n FROM users`),
      adminAll: db.prepare(`SELECT * FROM admins ORDER BY created_at`),
      adminById: db.prepare(`SELECT * FROM admins WHERE tg_user_id = ?`),
      adminAdd: db.prepare(
        `INSERT INTO admins (tg_user_id, role, added_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`
      ),
      adminDelete: db.prepare(`DELETE FROM admins WHERE tg_user_id = ?`),
    };
  }

  // -- аккаунты --
  addAccount(tgUserId, tgChatId, username, password) {
    try {
      const r = this.q.accAdd.run(tgUserId, tgChatId, username, password, Date.now());
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(String(e))) return null; // логин уже есть
      throw e;
    }
  }
  getAccount(id) { return this.q.accById.get(id) ?? null; }
  getAccountForUser(tgUserId, id) { return this.q.accByUserId.get(tgUserId, id) ?? null; }
  accountsOfUser(tgUserId) { return this.q.accByUser.all(tgUserId); }
  allAccounts() { return this.q.accAll.all(); }
  findAccountByUsername(username) { return this.q.accByUsername.get(username) ?? null; }
  deleteAccount(id) { this.q.accDelete.run(id); }
  setStatus(id, status, note = '') { this.q.accStatus.run(status, note, id); }
  saveCookies(id, cookies) { this.q.accCookies.run(JSON.stringify(cookies ?? []), id); }
  updateBalance(id, balance, clicks = 0, errors = 0) {
    this.q.accBalance.run(balance, clicks, errors, id);
    this.q.accLastClick.run(Date.now(), id);
  }

  changePassword(id, password) { this.q.accPassword.run(password, id); }

  // дневной заработок + флаг комиссии
  earnedState(id) {
    return this.q.accEarned.get(id) ?? { earned_day: '', earned_today: 0, commission_paid: 0 };
  }
  updateEarned(id, { earned_today, commission_paid }) {
    this.q.accEarnedUpd.run(mskDay(), earned_today, commission_paid ? 1 : 0, id);
  }
  /** добавляем заработок за сегодня (с авто-сбросом на новый день) */
  addEarned(id, delta) {
    const st = this.earnedState(id);
    const today = mskDay();
    const earnedToday = st.earned_day === today ? st.earned_today + delta : delta;
    const paid = st.earned_day === today ? st.commission_paid : 0;
    this.q.accEarnedUpd.run(today, earnedToday, paid, id);
    return { earnedToday, paidToday: paid };
  }

  // -- настройки --
  setting(key, def = null) {
    const r = this.q.setGet.get(key);
    return r ? r.value : def;
  }
  setSetting(key, value) { this.q.setSet.run(key, String(value)); }

  get commissionAccount() { return this.setting('commission_account', '') || ''; }
  get commissionAmount() { return Number(this.setting('commission_amount', '') || 0); }

  // сбор комиссии отключён «на сегодня» (значение - день MSK, само выключается в полночь)
  get commissionOffToday() { return this.setting('commission_off', '') === mskDay(); }
  setCommissionOff(onOrOff) { this.setSetting('commission_off', onOrOff ? mskDay() : ''); }

  // -- переводы --
  addTransfer(accountId, fromUser, toUser, amount, status, note = '') {
    this.q.transferAdd.run(Date.now(), accountId, fromUser, toUser, amount, status, note);
  }
  lastTransfers(n = 10) { return this.q.transfersLast.all(n); }
  transfersStat() {
    const r = this.q.transfersCount.get();
    return { count: Number(r.n), sum: Number(r.sum) };
  }
  activeAccountsCount() { return Number(this.q.accountsActive.get().n); }

  // -- пользователи бота (для рассылки) --
  upsertUser(tgUserId, tgChatId, username = '', firstName = '') {
    const now = Date.now();
    this.q.userUpsert.run(tgUserId, tgChatId, username ?? '', firstName ?? '', now, now);
  }
  usersCount() { return Number(this.q.usersCount.get().n); }
  /** все чаты для /broadcast: пользователи бота + владельцы аккаунтов */
  broadcastTargets() {
    return this.q.broadcastTargets.all().map((r) => Number(r.tg_chat_id));
  }

  // -- админы (мульти-админка; владелец задаётся через .env OWNER_ID) --
  allAdmins() { return this.q.adminAll.all(); }
  adminRow(tgUserId) { return this.q.adminById.get(tgUserId) ?? null; }
  isAdmin(tgUserId) { return !!this.q.adminById.get(tgUserId); }
  adminRole(tgUserId) { return this.q.adminById.get(tgUserId)?.role ?? null; }
  /**
   * добавляем/обновляем админа; role: 'owner' | 'admin'
   * возвращает false, если юзер уже админ с таким же набором (ничего не меняли)
   */
  addAdmin(tgUserId, role = 'admin', addedBy = null) {
    this.q.adminAdd.run(tgUserId, role, addedBy, Date.now());
  }
  removeAdmin(tgUserId) { this.q.adminDelete.run(tgUserId); }
}
