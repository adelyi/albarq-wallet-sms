const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wallet.db');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '783553915';
const ADMIN_DEFAULT_PASS = process.env.ADMIN_DEFAULT_PASS || 'Barq@2026';
const DISABLE_OTP = String(process.env.DISABLE_OTP || 'false').toLowerCase() === 'true';
const SEND_REGISTER_SMS = String(process.env.SEND_REGISTER_SMS || 'false').toLowerCase() === 'true';
const SMS_PROVIDER = String(process.env.SMS_PROVIDER || 'console').toLowerCase();
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'AlBarq';

const db = new sqlite3.Database(DB_PATH);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function createUserNotification(userPhone, title, message, txType = 'info', amount = 0, balanceAfter = null) {
  const phone = normalizePhone(userPhone);
  if (!phone) return;
  await runAsync(
    `INSERT INTO notifications (user_phone, title, message, tx_type, amount, balance_after, is_read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [phone, title, message, txType, Number(amount || 0), balanceAfter !== null ? Number(balanceAfter) : null]
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

  const adminNorm = normalizePhone(ADMIN_PHONE);
  const existingAdmin = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminNorm]);
  if (!existingAdmin) {
    await runAsync(
      `INSERT INTO users (full_name, phone, password_hash, role, balance, pos_code, kyc_status, is_active)
       VALUES (?, ?, ?, 'admin', 100000000, 'POS-ADMIN', 'verified', 1)`,
      ['إدارة محفظة البرق', adminNorm, hashPassword(ADMIN_DEFAULT_PASS)]
    );
  } else if (existingAdmin.role !== 'admin') {
    await runAsync(`UPDATE users SET role = 'admin', kyc_status = 'verified', is_active = 1 WHERE phone = ?`, [adminNorm]);
  }
}

function isAdminUser(user) {
  return user && (user.role === 'admin' || normalizePhone(user.phone) === normalizePhone(ADMIN_PHONE));
}

async function buildUserSummary(phone) {
  const normPhone = normalizePhone(phone);
  const user = await getAsync(
    `SELECT id, full_name, phone, role, balance, pos_code, kyc_status, is_active, created_at
     FROM users WHERE phone = ?`,
    [normPhone]
  );
  if (!user) return null;

  const transactions = await allAsync(
    `SELECT id, tx_ref, sender_phone, receiver_phone, tx_type, amount, note, created_at
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

// تسجيل عميل جديد مع توليد رمز OTP للمشارك وإظهاره للإدارة
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

// تفعيل حساب العميل عبر رمز OTP الذي يرسله المسؤول
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
      `INSERT INTO users (full_name, phone, password_hash, role, balance, pos_code, kyc_status, is_active)
       VALUES (?, ?, ?, 'user', 0, ?, 'verified', 1)`,
      [fullName, phone, passwordHash, posCode]
    );

    await runAsync(`UPDATE customer_otp_challenges SET used = 1 WHERE id = ?`, [challenge.id]);

    await createUserNotification(
      phone,
      'مرحباً بك في محفظة البرق',
      `تم تفعيل محفظتك بنجاح برقم ${phone} ورمز نقطة البيع ${posCode}. رصيدك الحالي: 0.00 ر.ي`,
      'welcome',
      0,
      0
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

// تسجيل الدخول (للإدارة والعملاء)
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

// تأكيد رمز OTP للإدارة
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

// جلب بيانات المحفظة والعمليات والإشعارات
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

// تعليم الإشعارات كمقروءة
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

// تحويل رصيد برقم الهاتف
app.post('/api/transfer', async (req, res) => {
  try {
    const senderPhone = normalizePhone(req.body.sender_phone);
    const receiverPhone = normalizePhone(req.body.receiver_phone);
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

    const sender = await getAsync(`SELECT * FROM users WHERE phone = ?`, [senderPhone]);
    const receiver = await getAsync(`SELECT * FROM users WHERE phone = ?`, [receiverPhone]);

    if (!sender) return res.status(404).json({ error: 'حساب المرسل غير موجود.' });
    if (!receiver) return res.status(404).json({ error: 'رقم هاتف المستلم غير مسجل في محفظة البرق.' });
    if (Number(sender.balance) < amount) {
      return res.status(400).json({ error: 'الرصيد المتاح غير كافٍ لإتمام التحويل.' });
    }

    const newSenderBal = Number(sender.balance) - amount;
    const newReceiverBal = Number(receiver.balance) + amount;
    const txRef = `BRQ-TRF-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newSenderBal, senderPhone]);
    await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newReceiverBal, receiverPhone]);
    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, note)
       VALUES (?, ?, ?, 'transfer', ?, ?)`,
      [txRef, senderPhone, receiverPhone, amount, note]
    );

    await createUserNotification(
      senderPhone,
      'إشعار تحويل صادر',
      `تم تحويل مبلغ ${amount.toFixed(2)} ر.ي إلى ${receiver.full_name} (${receiverPhone}) — البيان: ${note} — رصيدك الحالي: ${newSenderBal.toFixed(2)} ر.ي`,
      'transfer_out',
      amount,
      newSenderBal
    );

    await createUserNotification(
      receiverPhone,
      'إشعار استلام تحويل',
      `وصلك تحويل بمبلغ ${amount.toFixed(2)} ر.ي من ${sender.full_name} (${senderPhone}) — البيان: ${note} — رصيدك الحالي: ${newReceiverBal.toFixed(2)} ر.ي`,
      'transfer_in',
      amount,
      newReceiverBal
    );

    const summary = await buildUserSummary(senderPhone);
    return res.json({
      message: `تم تحويل ${amount.toFixed(2)} ر.ي بنجاح إلى ${receiver.full_name} (${receiverPhone}).`,
      tx_ref: txRef,
      ...summary,
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تنفيذ التحويل.' });
  }
});

// الدفع لنقطة بيع (POS)
app.post('/api/pay-pos', async (req, res) => {
  try {
    const payerPhone = normalizePhone(req.body.payer_phone);
    const posCode = String(req.body.pos_code || '').trim().toUpperCase();
    const amount = Number(req.body.amount);

    if (!payerPhone || !posCode) {
      return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف ورمز نقطة البيع POS.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح.' });
    }

    const payer = await getAsync(`SELECT * FROM users WHERE phone = ?`, [payerPhone]);
    const merchant = await getAsync(`SELECT * FROM users WHERE UPPER(pos_code) = ?`, [posCode]);

    if (!payer) return res.status(404).json({ error: 'حساب الدافع غير موجود.' });
    if (!merchant) return res.status(404).json({ error: 'رمز نقطة البيع POS غير صحيح.' });
    if (payer.phone === merchant.phone) {
      return res.status(400).json({ error: 'لا يمكنك الدفع لنقطة البيع الخاصة بحسابك.' });
    }
    if (Number(payer.balance) < amount) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ للدفع لنقطة البيع.' });
    }

    const newPayerBal = Number(payer.balance) - amount;
    const newMerchantBal = Number(merchant.balance) + amount;
    const txRef = `BRQ-POS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newPayerBal, payer.phone]);
    await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newMerchantBal, merchant.phone]);
    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, note)
       VALUES (?, ?, ?, 'pos_payment', ?, ?)`,
      [txRef, payer.phone, merchant.phone, amount, `دفع POS إلى ${merchant.full_name} (${posCode})`]
    );

    await createUserNotification(
      payer.phone,
      'إشعار دفع POS',
      `تم خصم مبلغ ${amount.toFixed(2)} ر.ي لصالح نقطة البيع ${posCode} (${merchant.full_name}) — رصيدك الحالي: ${newPayerBal.toFixed(2)} ر.ي`,
      'pos_out',
      amount,
      newPayerBal
    );

    await createUserNotification(
      merchant.phone,
      'إشعار مبيعات نقطة بيع POS',
      `تم استلام دفعة POS بقيمة ${amount.toFixed(2)} ر.ي من ${payer.full_name} (${payer.phone}) عبر ${posCode} — رصيدك الحالي: ${newMerchantBal.toFixed(2)} ر.ي`,
      'pos_in',
      amount,
      newMerchantBal
    );

    const summary = await buildUserSummary(payer.phone);
    return res.json({
      message: `تم الدفع بنجاح لنقطة البيع ${posCode} بمبلغ ${amount.toFixed(2)} ر.ي.`,
      tx_ref: txRef,
      ...summary,
    });
  } catch (err) {
    console.error('POS payment error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء الدفع لنقطة البيع.' });
  }
});

// طلب توثيق KYC
app.post('/api/kyc-request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const user = await getAsync(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود.' });

    await runAsync(`UPDATE users SET kyc_status = 'verified' WHERE phone = ?`, [phone]);
    await createUserNotification(
      phone,
      'تأكيد التوثيق KYC',
      'تمت مراجعة وتوثيق حسابك في محفظة البرق بنجاح.',
      'kyc',
      0,
      Number(user.balance)
    );
    const summary = await buildUserSummary(phone);
    return res.json({ message: 'تم توثيق الحساب بنجاح.', ...summary });
  } catch (err) {
    return res.status(500).json({ error: 'تعذر تنفيذ طلب التوثيق.' });
  }
});

// بيانات لوحة الإدارة (رموز OTP المعلقة، العملاء، الإحصائيات، وتقرير العمليات الشامل)
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.query.admin_phone);
    const adminUser = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminPhone]);
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

    const users = await allAsync(
      `SELECT id, full_name, phone, role, balance, pos_code, kyc_status, is_active, created_at
       FROM users
       ORDER BY id DESC`
    );

    const transactions = await allAsync(
      `SELECT t.id, t.tx_ref, t.sender_phone, t.receiver_phone, t.tx_type, t.amount, t.note, t.created_at,
              s.full_name AS sender_name, r.full_name AS receiver_name
       FROM transactions t
       LEFT JOIN users s ON t.sender_phone = s.phone
       LEFT JOIN users r ON t.receiver_phone = r.phone
       ORDER BY t.id DESC
       LIMIT 250`
    );

    const treasuryUser = await getAsync(`SELECT balance FROM users WHERE phone = ?`, [normalizePhone(ADMIN_PHONE)]);
    const customersBalanceSumRow = await getAsync(
      `SELECT COALESCE(SUM(balance), 0) AS total FROM users WHERE phone != ?`,
      [normalizePhone(ADMIN_PHONE)]
    );
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
        customersBalance: Number(customersBalanceSumRow?.total || 0),
        totalAccounts: Number(totalAccountsRow?.count || 0),
        totalTransactions: Number(totalTxRow?.count || 0),
        treasuryBalance: Number(treasuryUser?.balance || 0),
      },
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحميل لوحة الإدارة.' });
  }
});

// الإيداع / الخصم الإداري وتغذية المحافظ مع إشعار فوري داخل محفظة العميل
app.post('/api/admin/adjust-balance', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.body.admin_phone);
    const targetPhone = normalizePhone(req.body.target_phone);
    const operation = String(req.body.operation || 'deposit').trim();
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason || 'تغذية رصيد نقدي').trim();

    const adminUser = await getAsync(`SELECT * FROM users WHERE phone = ?`, [adminPhone]);
    if (!isAdminUser(adminUser)) {
      return res.status(403).json({ error: 'صلاحية الإدارة مطلوبة.' });
    }
    if (!targetPhone) {
      return res.status(400).json({ error: 'يرجى إدخال رقم هاتف العميل.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح أكبر من صفر.' });
    }

    const targetUser = await getAsync(`SELECT * FROM users WHERE phone = ?`, [targetPhone]);
    if (!targetUser) {
      return res.status(404).json({ error: 'حساب العميل غير موجود.' });
    }

    const isDeposit = operation === 'deposit';
    const isAdminAccount = normalizePhone(targetUser.phone) === normalizePhone(ADMIN_PHONE);

    if (!isDeposit && Number(targetUser.balance) < amount) {
      return res.status(400).json({ error: 'رصيد العميل غير كافٍ لتنفيذ الخصم.' });
    }

    const newTargetBalance = isDeposit
      ? Number(targetUser.balance) + amount
      : Number(targetUser.balance) - amount;

    if (!isAdminAccount) {
      const currentTreasury = Number(adminUser.balance);
      const newTreasuryBalance = isDeposit ? currentTreasury - amount : currentTreasury + amount;
      await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newTreasuryBalance, adminUser.phone]);
    }

    await runAsync(`UPDATE users SET balance = ? WHERE phone = ?`, [newTargetBalance, targetUser.phone]);

    const txRef = `BRQ-${isDeposit ? 'DEP' : 'WDR'}-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    await runAsync(
      `INSERT INTO transactions (tx_ref, sender_phone, receiver_phone, tx_type, amount, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        txRef,
        isDeposit ? adminUser.phone : targetUser.phone,
        isDeposit ? targetUser.phone : adminUser.phone,
        isDeposit ? 'admin_deposit' : 'admin_withdraw',
        amount,
        reason,
      ]
    );

    const notifTitle = isDeposit ? 'إشعار إيداع رصيد' : 'إشعار خصم إداري';
    const notifBody = isDeposit
      ? `تم إيداع مبلغ ${amount.toFixed(2)} ر.ي في محفظتك (${reason}) — رصيدك الحالي: ${newTargetBalance.toFixed(2)} ر.ي`
      : `تم خصم مبلغ ${amount.toFixed(2)} ر.ي من محفظتك (${reason}) — رصيدك الحالي: ${newTargetBalance.toFixed(2)} ر.ي`;

    await createUserNotification(
      targetUser.phone,
      notifTitle,
      notifBody,
      isDeposit ? 'deposit' : 'withdraw',
      amount,
      newTargetBalance
    );

    const smsMessage = `${SMS_SENDER_ID}: ${notifBody}`;
    await sendNotification(targetUser.phone, smsMessage, 'admin_balance_adjustment');

    return res.json({
      message: `تم تنفيذ العملية وإرسال SMS — المبلغ: ${amount.toFixed(2)} | الرصيد المتبقي: ${newTargetBalance.toFixed(2)}`,
      tx_ref: txRef,
      balance: newTargetBalance,
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
      console.log(`Al-Barq Wallet server running on port ${PORT} (SMS_PROVIDER=${SMS_PROVIDER}, SENDER=${SMS_SENDER_ID})`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
  });
