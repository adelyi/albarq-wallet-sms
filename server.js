const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wallet.db');
const TURSO_DATABASE_URL = String(process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_AUTH_TOKEN = String(process.env.TURSO_AUTH_TOKEN || '').trim();

const ADMIN_PHONE = process.env.ADMIN_PHONE || '783553915';
const ADMIN_DEFAULT_PASS = process.env.ADMIN_DEFAULT_PASS || 'Barq@2026';
const DISABLE_OTP = String(process.env.DISABLE_OTP || 'false').toLowerCase() === 'true';
const SEND_REGISTER_SMS = String(process.env.SEND_REGISTER_SMS || 'false').toLowerCase() === 'true';
const SMS_PROVIDER = String(process.env.SMS_PROVIDER || 'console').toLowerCase();
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'AlBarq';

const ALLOWED_CURRENCIES = ['YER', 'SAR', 'USD'];
const CURRENCY_LABELS = {
  YER: 'ر.ي',
  SAR: 'ر.س',
  USD: '$',
};
const CURRENCY_COL_MAP = {
  YER: 'balance_yer',
  SAR: 'balance_sar',
  USD: 'balance_usd',
};

const useTurso = Boolean(TURSO_DATABASE_URL && TURSO_AUTH_TOKEN);
const tursoClient = useTurso
  ? createClient({
      url: TURSO_DATABASE_URL,
      authToken: TURSO_AUTH_TOKEN,
    })
  : null;

const sqliteDb = useTurso ? null : new sqlite3.Database(DB_PATH);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function normalizeCurrency(curr) {
  const c = String(curr || 'YER').trim().toUpperCase();
  return ALLOWED_CURRENCIES.includes(c) ? c : 'YER';
}

function getCurrencyCol(curr) {
  return CURRENCY_COL_MAP[normalizeCurrency(curr)];
}

function getCurrencyLabel(curr) {
  return CURRENCY_LABELS[normalizeCurrency(curr)];
}

/**
 * حساب رسوم التحويل بين حسابات العملاء:
 * - من 500 إلى 30000 => 200
 * - من 30000.01 إلى 130000 => 500
 * - كل زيادة 100000 بعد 130000 => +200 إضافية
 */
function calculateTransferFee(amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (amt < 500) return 0;
  if (amt <= 30000) return 200;
  if (amt <= 130000) return 500;
  const extraSteps = Math.ceil((amt - 130000) / 100000);
  return 500 + extraSteps * 200;
}

function normalizePhone(phone) {
  let cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.startsWith('967') && cleaned.length === 12) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('00967') && cleaned.length === 14) {
    cleaned = cleaned.slice(5);
  } else if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

function formatInternationalPhone(phone) {
  const norm = normalizePhone(phone);
  return norm.startsWith('967') ? `+${norm}` : `+967${norm}`;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generatePosCode(phone) {
  const suffix = normalizePhone(phone).slice(-4).padStart(4, '0');
  const rand = Math.floor(10 + Math.random() * 89);
  return `POS-${suffix}-${rand}`;
}

async function sendNotification(toPhone, message, purpose = 'notification') {
  const intlPhone = formatInternationalPhone(toPhone);
  console.log(`[SMS -> ${intlPhone}] [Sender: ${SMS_SENDER_ID}] [Purpose: ${purpose}]: ${message}`);

  if (SMS_PROVIDER === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      return { sent: false, provider: 'twilio', reason: 'missing_twilio_env' };
    }
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const params = new URLSearchParams({ To: intlPhone, From: from, Body: message });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const data = await res.json();
      if (!res.ok) {
        return { sent: false, provider: 'twilio', reason: data.message || 'twilio_error' };
      }
      return { sent: true, provider: 'twilio', sid: data.sid };
    } catch (err) {
      return { sent: false, provider: 'twilio', reason: err.message };
    }
  }

  return { sent: true, provider: SMS_PROVIDER || 'console' };
}

function mapRowToPlainObject(row, columns = []) {
  if (!row) return null;
  if (Array.isArray(row)) {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  }
  return { ...row };
}

async function runAsync(sql, params = []) {
  if (useTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    return {
      lastID: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
      changes: res.rowsAffected ?? 0,
    };
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function getAsync(sql, params = []) {
  if (useTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    if (!res.rows || res.rows.length === 0) return undefined;
    return mapRowToPlainObject(res.rows[0], res.columns);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function allAsync(sql, params = []) {
  if (useTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    if (!res.rows || res.rows.length === 0) return [];
    return res.rows.map((r) => mapRowToPlainObject(r, res.columns));
  }
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function hydrateUserBalances(user) {
  if (!user) return null;
  const yer = Number(user.balance_yer ?? user.balance ?? 0);
  const sar = Number(user.balance_sar ?? 0);
  const usd = Number(user.balance_usd ?? 0);
  return {
    ...user,
    balance_yer: yer,
    balance_sar: sar,
    balance_usd: usd,
    balance: yer,
  };
}

async function ensureUserCurrencyColumns() {
  const columns = await allAsync(`PRAGMA table_info(users)`);
  const colNames = new Set(columns.map((c) => c.name));
  if (!colNames.has('balance_yer')) {
    await runAsync(`ALTER TABLE users ADD COLUMN balance_yer REAL DEFAULT 0`);
    await runAsync(`UPDATE users SET balance_yer = COALESCE(balance, 0) WHERE balance_yer IS NULL`);
  }
  if (!colNames.has('balance_sar')) {
    await runAsync(`ALTER TABLE users ADD COLUMN balance_sar REAL DEFAULT 0`);
  }
  if (!colNames.has('balance_usd')) {
    await runAsync(`ALTER TABLE users ADD COLUMN balance_usd REAL DEFAULT 0`);
  }

  const txCols = await allAsync(`PRAGMA table_info(transactions)`);
  const txColNames = new Set(txCols.map((c) => c.name));
  if (!txColNames.has('currency')) {
    await runAsync(`ALTER TABLE transactions ADD COLUMN currency TEXT DEFAULT 'YER'`);
  }
  if (!txColNames.has('fee_amount')) {
    await runAsync(`ALTER TABLE transactions ADD COLUMN fee_amount REAL DEFAULT 0`);
  }
}

async function createUserNotification(
  userPhone,
  title,
  message,
  txType = 'info',
  amount = 0,
  balanceAfter = null,
  currency = 'YER'
) {
  const phone = normalizePhone(userPhone);
  if (!phone) return;
  await runAsync(
    `INSERT INTO notifications (user_phone, title, message, tx_type, amount, balance_after, is_read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      phone,
      title,
      `${message} [${normalizeCurrency(currency)}]`,
      txType,
      Number(amount || 0),
      balanceAfter !== null ? Number(balanceAfter) : null,
    ]
  );
}

async function initDatabase() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      balance REAL DEFAULT 0,
      balance_yer REAL DEFAULT 0,
      balance_sar REAL DEFAULT 0,
      balance_usd REAL DEFAULT 0,
      pos_code TEXT UNIQUE,
      kyc_status TEXT DEFAULT 'verified',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_ref TEXT UNIQUE NOT NULL,
      sender_phone TEXT,
      receiver_phone TEXT,
      tx_type TEXT NOT NULL,
      amount REAL NOT NULL,
      fee_amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'YER',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_phone TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      tx_type TEXT DEFAULT 'info',
      amount REAL DEFAULT 0,
      balance_after REAL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT NOT NULL,
      payload_json TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS customer_otp_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      full_name TEXT,
      purpose TEXT NOT NULL,
      code TEXT NOT NULL,
      payload_json TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureUserCurrencyColumns();

  const adminNorm = normalizePhone(ADMIN_PHONE);
  const existingAdmin = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminNorm]);
  if (!existingAdmin) {
    await runAsync(
      `INSERT INTO users (full_name, phone, password_hash, role, balance, balance_yer, balance_sar, balance_usd, pos_code, kyc_status, is_active)
       VALUES (?, ?, ?, 'admin', 100000000, 100000000, 5000000, 1000000, 'POS-ADMIN', 'verified', 1)`,
      ['إدارة محفظة البرق', adminNorm, hashPassword(ADMIN_DEFAULT_PASS)]
    );
  } else {
    if (existingAdmin.role !== 'admin') {
      await runAsync(`UPDATE users SET role = 'admin', kyc_status = 'verified', is_active = 1 WHERE phone = ?`, [adminNorm]);
    }
    const hydrated = hydrateUserBalances(existingAdmin);
    if (Number(existingAdmin.balance_sar ?? 0) === 0 && Number(existingAdmin.balance_usd ?? 0) === 0) {
      await runAsync(
        `UPDATE users SET balance_yer = ?, balance_sar = 5000000, balance_usd = 1000000 WHERE phone = ?`,
        [hydrated.balance_yer, adminNorm]
      );
    }
  }
}

function isAdminUser(user) {
  return user && (user.role === 'admin' || normalizePhone(user.phone) === normalizePhone(ADMIN_PHONE));
}

async function buildUserSummary(phone) {
  const normPhone = normalizePhone(phone);
  const rawUser = await getAsync(
    `SELECT id, full_name, phone, role, balance, balance_yer, balance_sar, balance_usd, pos_code, kyc_status, is_active, created_at
     FROM users WHERE phone = ?`,
    [normPhone]
  );
  if (!rawUser) return null;
  const user = hydrateUserBalances(rawUser);

  const transactions = await allAsync(
    `SELECT id, tx_ref, sender_phone, receiver_phone, tx_type, amount, fee_amount, currency, note, created_at
     FROM transactions
     WHERE sender_phone = ? OR receiver_phone = ?
     ORDER BY id DESC
     LIMIT 100`,
    [normPhone, normPhone]
  );

  const notifications = await allAsync(
    `SELECT id, user_phone, title, message, tx_type, amount, balance_after, is_read, created_at
     FROM notifications
     WHERE user_phone = ?
     ORDER BY id DESC
     LIMIT 50`,
    [normPhone]
  );

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return {
    user,
    transactions,
    notifications,
    unreadCount,
  };
}

app.post('/api/register', async (req, res) => {
  try {
    const fullName = String(req.body.full_name || '').trim();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'يرجى إدخال الاسم الكامل بشكل صحيح.' });
    }
    if (!phone || phone.length < 7) {
      return res.status(400).json({ error: 'يرجى إدخال رقم هاتف صحيح.' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 4 أحرف أو أرقام على الأقل.' });
    }

    const existingUser = await getAsync(`SELECT id FROM users WHERE phone = ?`, [phone]);
    if (existingUser) {
      return res.status(409).json({ error: 'رقم الهاتف مسجل مسبقاً في محفظة البرق.' });
    }

    const code = generateOtpCode();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const payload = {
      full_name: fullName,
      phone,
      password_hash: hashPassword(password),
    };

    await runAsync(`DELETE FROM customer_otp_challenges WHERE phone = ? AND purpose = 'register' AND used = 0`, [phone]);
    await runAsync(
      `INSERT INTO customer_otp_challenges (phone, full_name, purpose, code, payload_json, expires_at, used)
       VALUES (?, ?, 'register', ?, ?, ?, 0)`,
      [phone, fullName, code, JSON.stringify(payload), expiresAt]
    );

    const smsText = `${SMS_SENDER_ID}: رمز تفعيل محفظتك هو ${code} صالح لمدة 15 دقيقة.`;
    if (SEND_REGISTER_SMS) {
      await sendNotification(phone, smsText, 'customer_register_otp');
    } else {
      console.log(`[ADMIN-OTP-QUEUE] Phone: ${phone} | Name: ${fullName} | OTP: ${code}`);
    }

    return res.status(201).json({
      requires_otp: true,
      phone,
      message: 'تم إنشاء طلب التسجيل وتوليد رمز OTP للمشارك. سيظهر الرمز في لوحة الإدارة لإرساله وتفعيل الحساب.',
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الحساب.' });
  }
});

app.post('/api/verify-customer-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();

    if (!phone || !code) {
      return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف ورمز OTP.' });
    }

    const challenge = await getAsync(
      `SELECT * FROM customer_otp_challenges
       WHERE phone = ? AND code = ? AND used = 0
       ORDER BY id DESC LIMIT 1`,
      [phone, code]
    );

    if (!challenge) {
      return res.status(400).json({ error: 'رمز OTP غير صحيح أو مستخدم مسبقاً.' });
    }
    if (Date.now() > Number(challenge.expires_at)) {
      return res.status(400).json({ error: 'انتهت صلاحية رمز OTP، يرجى إعادة التسجيل أو طلب رمز جديد.' });
    }

    const payload = challenge.payload_json ? JSON.parse(challenge.payload_json) : {};
    const fullName = payload.full_name || challenge.full_name || `عميل ${phone}`;
    const passwordHash = payload.password_hash || hashPassword('123456');

    const existingUser = await getAsync(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (existingUser) {
      await runAsync(`UPDATE customer_otp_challenges SET used = 1 WHERE id = ?`, [challenge.id]);
      const summary = await buildUserSummary(phone);
      return res.json({
        message: 'الحساب مفعّل مسبقاً.',
        ...summary,
      });
    }

    let posCode = generatePosCode(phone);
    const existingPos = await getAsync(`SELECT id FROM users WHERE pos_code = ?`, [posCode]);
    if (existingPos) {
      posCode = `${posCode}-${Math.floor(10 + Math.random() * 89)}`;
    }

    await runAsync(
      `INSERT INTO users (full_name, phone, password_hash, role, balance, balance_yer, balance_sar, balance_usd, pos_code, kyc_status, is_active)
       VALUES (?, ?, ?, 'user', 0, 0, 0, 0, ?, 'verified', 1)`,
      [fullName, phone, passwordHash, posCode]
    );

    await runAsync(`UPDATE customer_otp_challenges SET used = 1 WHERE id = ?`, [challenge.id]);

    await createUserNotification(
      phone,
      'مرحباً بك في محفظة البرق',
      `تم تفعيل محفظتك بنجاح برقم ${phone} ورمز نقطة البيع ${posCode}. رصيدك الحالي: 0.00 ر.ي`,
      'welcome',
      0,
      0,
      'YER'
    );

    const summary = await buildUserSummary(phone);
    return res.json({
      message: 'تم تأكيد رمز التحقق OTP بنجاح وتفعيل الحساب.',
      ...summary,
    });
  } catch (err) {
    console.error('Verify customer OTP error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تفعيل الحساب.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');

    if (!phone || !password) {
      return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف وكلمة المرور.' });
    }

    const user = await getAsync(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'هذا الحساب غير مفعّل حالياً.' });
    }

    if (isAdminUser(user) && !DISABLE_OTP) {
      const code = generateOtpCode();
      const expiresAt = Date.now() + 10 * 60 * 1000;
      await runAsync(`DELETE FROM otp_challenges WHERE phone = ? AND purpose = 'admin_login' AND used = 0`, [phone]);
      await runAsync(
        `INSERT INTO otp_challenges (phone, purpose, code, expires_at, used) VALUES (?, 'admin_login', ?, ?, 0)`,
        [phone, code, expiresAt]
      );
      await sendNotification(
        phone,
        `${SMS_SENDER_ID}: رمز التحقق المؤقت للدخول للإدارة هو ${code}`,
        'admin_login_otp'
      );
      return res.json({
        requires_admin_otp: true,
        phone,
        message: `تم إرسال رمز التحقق OTP إلى الرقم +967${phone}`,
      });
    }

    const summary = await buildUserSummary(phone);
    return res.json({
      requires_admin_otp: false,
      ...summary,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الدخول.' });
  }
});

app.post('/api/verify-admin-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();

    const challenge = await getAsync(
      `SELECT * FROM otp_challenges
       WHERE phone = ? AND purpose = 'admin_login' AND code = ? AND used = 0
       ORDER BY id DESC LIMIT 1`,
      [phone, code]
    );

    if (!challenge) {
      return res.status(400).json({ error: 'رمز التحقق الإداري غير صحيح.' });
    }
    if (Date.now() > Number(challenge.expires_at)) {
      return res.status(400).json({ error: 'انتهت صلاحية رمز التحقق الإداري.' });
    }

    await runAsync(`UPDATE otp_challenges SET used = 1 WHERE id = ?`, [challenge.id]);
    const summary = await buildUserSummary(phone);
    return res.json(summary);
  } catch (err) {
    console.error('Verify admin OTP error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء التحقق من الرمز.' });
  }
});

app.get('/api/wallet/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const summary = await buildUserSummary(phone);
    if (!summary) {
      return res.status(404).json({ error: 'الحساب غير موجود.' });
    }
    return res.json(summary);
  } catch (err) {
    console.error('Get wallet error:', err);
    return res.status(500).json({ error: 'تعذر جلب بيانات المحفظة.' });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب.' });
    await runAsync(`UPDATE notifications SET is_read = 1 WHERE user_phone = ?`, [phone]);
    const notifications = await allAsync(
      `SELECT id, user_phone, title, message, tx_type, amount, balance_after, is_read, created_at
       FROM notifications WHERE user_phone = ? ORDER BY id DESC LIMIT 50`,
      [phone]
    );
    return res.json({ notifications, unreadCount: 0 });
  } catch (err) {
    return res.status(500).json({ error: 'تعذر تحديث حالة الإشعارات.' });
  }
});

// تحويل رصيد بنفس العملة المستقلة مع حساب رسوم التحويل
app.post('/api/transfer', async (req, res) => {
  try {
    const senderPhone = normalizePhone(req.body.sender_phone);
    const receiverPhone = normalizePhone(req.body.receiver_phone);
    const currency = normalizeCurrency(req.body.currency);
    const amount = Number(req.body.amount);
    const note = String(req.body.note || 'تحويل رصيد').trim();

    if (!senderPhone || !receiverPhone) {
      return res.status(400).json({ error: 'يرجى إدخال رقم المرسل ورقم المستلم.' });
    }
    if (senderPhone === receiverPhone) {
      return res.status(400).json({ error: 'لا يمكن التحويل إلى نفس الرقم.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح أكبر من صفر.' });
    }

    const rawSender = await getAsync(`SELECT * FROM users WHERE phone = ?`, [senderPhone]);
    const rawReceiver = await getAsync(`SELECT * FROM users WHERE phone = ?`, [receiverPhone]);

    if (!rawSender) return res.status(404).json({ error: 'حساب المرسل غير موجود.' });
    if (!rawReceiver) return res.status(404).json({ error: 'رقم هاتف المستلم غير مسجل في محفظة البرق.' });

    const sender = hydrateUserBalances(rawSender);
    const receiver = hydrateUserBalances(rawReceiver);
    const col = getCurrencyCol(currency);
    const label = getCurrencyLabel(currency);
    const fee = currency === 'YER' ? calculateTransferFee(amount) : 0;
    const totalDebit = amount + fee;

    const senderCurrBal = Number(sender[col] || 0);
    if (senderCurrBal < totalDebit) {
      return res.status(400).json({
        error: `الرصيد غير كافٍ في عملة ${currency}. المطلوب: ${totalDebit.toFixed(2)} ${label} (المبلغ ${amount.toFixed(2)} + رسوم ${fee.toFixed(2)}).`,
      });
    }

    const newSenderCurrBal = senderCurrBal - totalDebit;
    const newReceiverCurrBal = Number(receiver[col] || 0) + amount;
    const txRef = `BRQ-TRF-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    if (currency === 'YER') {
      await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
        newSenderCurrBal,
        newSenderCurrBal,
        senderPhone,
      ]);
      await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
        newReceiverCurrBal,
        newReceiverCurrBal,
        receiverPhone,
      ]);
    } else {
      await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newSenderCurrBal, senderPhone]);
      await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newReceiverCurrBal, receiverPhone]);
    }

    const adminNorm = normalizePhone(ADMIN_PHONE);
    if (fee > 0 && senderPhone !== adminNorm && receiverPhone !== adminNorm) {
      const rawAdmin = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminNorm]);
      if (rawAdmin) {
        const adminHydrated = hydrateUserBalances(rawAdmin);
        const newAdminCurrBal = Number(adminHydrated[col] || 0) + fee;
        if (currency === 'YER') {
          await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
            newAdminCurrBal,
            newAdminCurrBal,
            adminNorm,
          ]);
        } else {
          await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newAdminCurrBal, adminNorm]);
        }
      }
    }

    const combinedNote = fee > 0 ? `${note} (رسوم: ${fee.toFixed(2)} ${label})` : note;
    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, fee_amount, currency, note)
       VALUES (?, ?, ?, 'transfer', ?, ?, ?, ?)`,
      [txRef, senderPhone, receiverPhone, amount, fee, currency, combinedNote]
    );

    await createUserNotification(
      senderPhone,
      'إشعار تحويل صادر',
      `تم تحويل ${amount.toFixed(2)} ${label} إلى ${receiver.full_name} (${receiverPhone})${fee > 0 ? ` — الرسوم: ${fee.toFixed(2)} ${label}` : ''} — البيان: ${note} — رصيد ${currency} الحالي: ${newSenderCurrBal.toFixed(2)} ${label}`,
      'transfer_out',
      amount,
      newSenderCurrBal,
      currency
    );

    await createUserNotification(
      receiverPhone,
      'إشعار استلام تحويل',
      `وصلك تحويل بمبلغ ${amount.toFixed(2)} ${label} من ${sender.full_name} (${senderPhone}) — البيان: ${note} — رصيد ${currency} الحالي: ${newReceiverCurrBal.toFixed(2)} ${label}`,
      'transfer_in',
      amount,
      newReceiverCurrBal,
      currency
    );

    const summary = await buildUserSummary(senderPhone);
    return res.json({
      message: `تم تحويل ${amount.toFixed(2)} ${label} بنجاح إلى ${receiver.full_name} (${receiverPhone})${fee > 0 ? ` — رسوم التحويل: ${fee.toFixed(2)} ${label}` : ''}.`,
      tx_ref: txRef,
      fee,
      currency,
      ...summary,
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تنفيذ التحويل.' });
  }
});

// الدفع لنقطة بيع (POS) بنفس العملة المستقلة
app.post('/api/pay-pos', async (req, res) => {
  try {
    const payerPhone = normalizePhone(req.body.payer_phone);
    const posCode = String(req.body.pos_code || '').trim().toUpperCase();
    const currency = normalizeCurrency(req.body.currency);
    const amount = Number(req.body.amount);

    if (!payerPhone || !posCode) {
      return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف ورمز نقطة البيع POS.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح.' });
    }

    const rawPayer = await getAsync(`SELECT * FROM users WHERE phone = ?`, [payerPhone]);
    const rawMerchant = await getAsync(`SELECT * FROM users WHERE UPPER(pos_code) = ?`, [posCode]);

    if (!rawPayer) return res.status(404).json({ error: 'حساب الدافع غير موجود.' });
    if (!rawMerchant) return res.status(404).json({ error: 'رمز نقطة البيع POS غير صحيح.' });

    const payer = hydrateUserBalances(rawPayer);
    const merchant = hydrateUserBalances(rawMerchant);

    if (payer.phone === merchant.phone) {
      return res.status(400).json({ error: 'لا يمكنك الدفع لنقطة البيع الخاصة بحسابك.' });
    }

    const col = getCurrencyCol(currency);
    const label = getCurrencyLabel(currency);
    const payerCurrBal = Number(payer[col] || 0);

    if (payerCurrBal < amount) {
      return res.status(400).json({ error: `الرصيد غير كافٍ في عملة ${currency} للدفع لنقطة البيع.` });
    }

    const newPayerBal = payerCurrBal - amount;
    const newMerchantBal = Number(merchant[col] || 0) + amount;
    const txRef = `BRQ-POS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    if (currency === 'YER') {
      await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
        newPayerBal,
        newPayerBal,
        payer.phone,
      ]);
      await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
        newMerchantBal,
        newMerchantBal,
        merchant.phone,
      ]);
    } else {
      await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newPayerBal, payer.phone]);
      await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newMerchantBal, merchant.phone]);
    }

    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, fee_amount, currency, note)
       VALUES (?, ?, ?, 'pos_payment', ?, 0, ?, ?)`,
      [txRef, payer.phone, merchant.phone, amount, currency, `دفع POS إلى ${merchant.full_name} (${posCode})`]
    );

    await createUserNotification(
      payer.phone,
      'إشعار دفع POS',
      `تم خصم ${amount.toFixed(2)} ${label} لصالح نقطة البيع ${posCode} (${merchant.full_name}) — رصيد ${currency} الحالي: ${newPayerBal.toFixed(2)} ${label}`,
      'pos_out',
      amount,
      newPayerBal,
      currency
    );

    await createUserNotification(
      merchant.phone,
      'إشعار مبيعات نقطة بيع POS',
      `تم استلام دفعة POS بقيمة ${amount.toFixed(2)} ${label} من ${payer.full_name} (${payer.phone}) عبر ${posCode} — رصيد ${currency} الحالي: ${newMerchantBal.toFixed(2)} ${label}`,
      'pos_in',
      amount,
      newMerchantBal,
      currency
    );

    const summary = await buildUserSummary(payer.phone);
    return res.json({
      message: `تم الدفع بنجاح لنقطة البيع ${posCode} بمبلغ ${amount.toFixed(2)} ${label}.`,
      tx_ref: txRef,
      ...summary,
    });
  } catch (err) {
    console.error('POS payment error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء الدفع لنقطة البيع.' });
  }
});

app.post('/api/kyc-request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const rawUser = await getAsync(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (!rawUser) return res.status(404).json({ error: 'الحساب غير موجود.' });
    const user = hydrateUserBalances(rawUser);

    await runAsync(`UPDATE users SET kyc_status = 'verified' WHERE phone = ?`, [phone]);
    await createUserNotification(
      phone,
      'تأكيد التوثيق KYC',
      'تمت مراجعة وتوثيق حسابك في محفظة البرق بنجاح.',
      'kyc',
      0,
      Number(user.balance_yer),
      'YER'
    );
    const summary = await buildUserSummary(phone);
    return res.json({ message: 'تم توثيق الحساب بنجاح.', ...summary });
  } catch (err) {
    return res.status(500).json({ error: 'تعذر تنفيذ طلب التوثيق.' });
  }
});

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.query.admin_phone);
    const rawAdmin = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminPhone]);
    const adminUser = hydrateUserBalances(rawAdmin);
    if (!isAdminUser(adminUser)) {
      return res.status(403).json({ error: 'صلاحية الإدارة مطلوبة.' });
    }

    const now = Date.now();
    const pendingOtps = await allAsync(
      `SELECT id, phone, full_name, purpose, code, expires_at, created_at
       FROM customer_otp_challenges
       WHERE used = 0 AND expires_at > ?
       ORDER BY id DESC`,
      [now]
    );

    const rawUsers = await allAsync(
      `SELECT id, full_name, phone, role, balance, balance_yer, balance_sar, balance_usd, pos_code, kyc_status, is_active, created_at
       FROM users
       ORDER BY id DESC`
    );
    const users = rawUsers.map(hydrateUserBalances);

    const transactions = await allAsync(
      `SELECT t.id, t.tx_ref, t.sender_phone, t.receiver_phone, t.tx_type, t.amount, t.fee_amount, t.currency, t.note, t.created_at,
              s.full_name AS sender_name, r.full_name AS receiver_name
       FROM transactions t
       LEFT JOIN users s ON t.sender_phone = s.phone
       LEFT JOIN users r ON t.receiver_phone = r.phone
       ORDER BY t.id DESC
       LIMIT 250`
    );

    const adminNorm = normalizePhone(ADMIN_PHONE);
    const rawTreasury = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminNorm]);
    const treasuryUser = hydrateUserBalances(rawTreasury);

    const customersYer = users
      .filter((u) => normalizePhone(u.phone) !== adminNorm)
      .reduce((acc, u) => acc + Number(u.balance_yer || 0), 0);
    const customersSar = users
      .filter((u) => normalizePhone(u.phone) !== adminNorm)
      .reduce((acc, u) => acc + Number(u.balance_sar || 0), 0);
    const customersUsd = users
      .filter((u) => normalizePhone(u.phone) !== adminNorm)
      .reduce((acc, u) => acc + Number(u.balance_usd || 0), 0);

    const totalAccountsRow = await getAsync(`SELECT COUNT(*) AS count FROM users`);
    const totalTxRow = await getAsync(`SELECT COUNT(*) AS count FROM transactions`);

    return res.json({
      pendingOtps: pendingOtps.map((item) => ({
        ...item,
        remainingSeconds: Math.max(0, Math.floor((Number(item.expires_at) - now) / 1000)),
      })),
      users,
      transactions,
      stats: {
        customersBalance: Number(customersYer),
        customersBalanceYer: Number(customersYer),
        customersBalanceSar: Number(customersSar),
        customersBalanceUsd: Number(customersUsd),
        totalAccounts: Number(totalAccountsRow?.count || 0),
        totalTransactions: Number(totalTxRow?.count || 0),
        treasuryBalance: Number(treasuryUser?.balance_yer || 0),
        treasuryBalanceYer: Number(treasuryUser?.balance_yer || 0),
        treasuryBalanceSar: Number(treasuryUser?.balance_sar || 0),
        treasuryBalanceUsd: Number(treasuryUser?.balance_usd || 0),
      },
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحميل لوحة الإدارة.' });
  }
});

// الإيداع / الخصم الإداري لأي عملة مستقلة (YER / SAR / USD)
app.post('/api/admin/adjust-balance', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.body.admin_phone);
    const targetPhone = normalizePhone(req.body.target_phone);
    const currency = normalizeCurrency(req.body.currency);
    const operation = String(req.body.operation || 'deposit').trim();
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason || 'تغذية رصيد نقدي').trim();

    const rawAdmin = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminPhone]);
    const adminUser = hydrateUserBalances(rawAdmin);
    if (!isAdminUser(adminUser)) {
      return res.status(403).json({ error: 'صلاحية الإدارة مطلوبة.' });
    }
    if (!targetPhone) {
      return res.status(400).json({ error: 'يرجى إدخال رقم هاتف العميل.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح أكبر من صفر.' });
    }

    const rawTarget = await getAsync(`SELECT * FROM users WHERE phone = ?`, [targetPhone]);
    if (!rawTarget) {
      return res.status(404).json({ error: 'حساب العميل غير موجود.' });
    }
    const targetUser = hydrateUserBalances(rawTarget);

    const col = getCurrencyCol(currency);
    const label = getCurrencyLabel(currency);
    const isDeposit = operation === 'deposit';
    const isAdminAccount = normalizePhone(targetUser.phone) === normalizePhone(ADMIN_PHONE);
    const currentTargetCurrBal = Number(targetUser[col] || 0);

    if (!isDeposit && currentTargetCurrBal < amount) {
      return res.status(400).json({ error: `رصيد العميل في عملة ${currency} غير كافٍ لتنفيذ الخصم.` });
    }

    const newTargetCurrBal = isDeposit ? currentTargetCurrBal + amount : currentTargetCurrBal - amount;

    if (!isAdminAccount) {
      const currentTreasuryCurrBal = Number(adminUser[col] || 0);
      const newTreasuryCurrBal = isDeposit ? currentTreasuryCurrBal - amount : currentTreasuryCurrBal + amount;
      if (currency === 'YER') {
        await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
          newTreasuryCurrBal,
          newTreasuryCurrBal,
          adminUser.phone,
        ]);
      } else {
        await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newTreasuryCurrBal, adminUser.phone]);
      }
    }

    if (currency === 'YER') {
      await runAsync(`UPDATE users SET balance_yer = ?, balance = ? WHERE phone = ?`, [
        newTargetCurrBal,
        newTargetCurrBal,
        targetUser.phone,
      ]);
    } else {
      await runAsync(`UPDATE users SET ${col} = ? WHERE phone = ?`, [newTargetCurrBal, targetUser.phone]);
    }

    const txRef = `BRQ-${isDeposit ? 'DEP' : 'WDR'}-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, fee_amount, currency, note)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        txRef,
        isDeposit ? adminUser.phone : targetUser.phone,
        isDeposit ? targetUser.phone : adminUser.phone,
        isDeposit ? 'admin_deposit' : 'admin_withdraw',
        amount,
        currency,
        reason,
      ]
    );

    const notifTitle = isDeposit ? 'إشعار إيداع رصيد' : 'إشعار خصم إداري';
    const notifBody = isDeposit
      ? `تم إيداع ${amount.toFixed(2)} ${label} في محفظتك (${reason}) — رصيد ${currency} الحالي: ${newTargetCurrBal.toFixed(2)} ${label}`
      : `تم خصم ${amount.toFixed(2)} ${label} من محفظتك (${reason}) — رصيد ${currency} الحالي: ${newTargetCurrBal.toFixed(2)} ${label}`;

    await createUserNotification(
      targetUser.phone,
      notifTitle,
      notifBody,
      isDeposit ? 'deposit' : 'withdraw',
      amount,
      newTargetCurrBal,
      currency
    );

    const smsMessage = `${SMS_SENDER_ID}: ${notifBody}`;
    await sendNotification(targetUser.phone, smsMessage, 'admin_balance_adjustment');

    return res.json({
      message: `تم تنفيذ العملية (${currency}) — المبلغ: ${amount.toFixed(2)} ${label} | الرصيد الحالي: ${newTargetCurrBal.toFixed(2)} ${label}`,
      tx_ref: txRef,
      balance: newTargetCurrBal,
      currency,
    });
  } catch (err) {
    console.error('Adjust balance error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تنفيذ العملية الإدارية.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Al-Barq Wallet server running on port ${PORT} (DB=${useTurso ? 'Turso' : 'SQLite'}, SMS_PROVIDER=${SMS_PROVIDER}, SENDER=${SMS_SENDER_ID})`
      );
    });
  })
  .catch((err) => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
  });
