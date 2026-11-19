const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PHONE = String(process.env.ADMIN_PHONE || '783553915').trim();
const ADMIN_DEFAULT_PASS = String(process.env.ADMIN_DEFAULT_PASS || 'Barq@2026');
const DISABLE_OTP = String(process.env.DISABLE_OTP || '').toLowerCase() === 'true';
const SEND_REGISTER_SMS = String(process.env.SEND_REGISTER_SMS || '').toLowerCase() === 'true';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'albarq_wallet.db');
const db = new sqlite3.Database(dbPath);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '').trim();
}

function formatPhoneE164(phone) {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return raw;
  const digits = normalizePhone(raw).replace(/^0+/, '');
  if (digits.startsWith('967')) return `+${digits}`;
  return `+967${digits}`;
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function generateRef(prefix = 'BRQ') {
  const rand = crypto.randomInt(1000, 9999);
  return `${prefix}-${Date.now()}-${rand}`;
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return null;
  }

  return {
    client: twilio(accountSid, authToken),
    fromNumber
  };
}

async function sendOtpViaTwilio(phone, otpCode) {
  const tw = getTwilioClient();
  if (!tw) {
    return {
      sent: false,
      reason: 'MISSING_TWILIO_CONFIG',
      message: 'تم توليد رمز التحقق (لم يتم ضبط إعدادات Twilio SMS بعد)'
    };
  }

  try {
    const toNumber = formatPhoneE164(phone);
    await tw.client.messages.create({
      body: `محفظة البرق: رمز التحقق المؤقت للدخول للإدارة هو ${otpCode}`,
      from: tw.fromNumber,
      to: toNumber
    });

    return {
      sent: true,
      reason: 'SENT',
      message: `تم إرسال رمز التحقق OTP إلى الرقم ${toNumber} عبر SMS`
    };
  } catch (err) {
    console.error('Twilio SMS error:', err.message);
    return {
      sent: false,
      reason: 'TWILIO_ERROR',
      message: 'تعذر إرسال رسالة SMS عبر Twilio حالياً، تم توفير رمز احتياطي مؤقت'
    };
  }
}

async function sendRegisterSms(phone, fullName, posCode) {
  const tw = getTwilioClient();
  if (!tw) return { sent: false };

  try {
    const toNumber = formatPhoneE164(phone);
    await tw.client.messages.create({
      body: `مرحباً ${fullName} في محفظة البرق. تم إنشاء محفظتك بنجاح ورمز نقطة البيع الخاص بك هو: ${posCode}`,
      from: tw.fromNumber,
      to: toNumber
    });
    return { sent: true };
  } catch (err) {
    console.error('Twilio register SMS error:', err.message);
    return { sent: false };
  }
}

async function sendBalanceSms(phone, { actionLabel, amount, newBalance, reference, reason }) {
  const tw = getTwilioClient();
  if (!tw) {
    return {
      sent: false,
      reason: 'MISSING_TWILIO_CONFIG'
    };
  }

  try {
    const toNumber = formatPhoneE164(phone);
    const formattedAmount = Number(amount).toFixed(2);
    const formattedBalance = Number(newBalance).toFixed(2);

    const body =
      `محفظة البرق (${reference})\n` +
      `العملية: ${actionLabel}\n` +
      `المبلغ: ${formattedAmount}\n` +
      `الرصيد المتبقي: ${formattedBalance}` +
      (reason ? `\nالبيان: ${reason}` : '');

    await tw.client.messages.create({
      body,
      from: tw.fromNumber,
      to: toNumber
    });

    return {
      sent: true,
      reason: 'SENT'
    };
  } catch (err) {
    console.error('Twilio balance SMS error:', err.message);
    return {
      sent: false,
      reason: 'TWILIO_ERROR'
    };
  }
}

async function initDatabase() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      balance REAL NOT NULL DEFAULT 0.0,
      pos_code TEXT UNIQUE NOT NULL,
      kyc_status TEXT NOT NULL DEFAULT 'unverified',
      account_status TEXT NOT NULL DEFAULT 'active',
      daily_limit REAL NOT NULL DEFAULT 50000.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      sender_phone TEXT,
      receiver_phone TEXT,
      pos_code TEXT,
      amount REAL NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_reference TEXT NOT NULL,
      account_code TEXT NOT NULL,
      debit REAL NOT NULL DEFAULT 0.0,
      credit REAL NOT NULL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS otp_challenges (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  const existingAdmin = await getAsync('SELECT * FROM users WHERE phone = ?', [ADMIN_PHONE]);
  if (!existingAdmin) {
    await runAsync(
      `INSERT INTO users (full_name, phone, password_hash, role, balance, pos_code, kyc_status, account_status, daily_limit)
       VALUES (?, ?, ?, 'admin', 0.0, 'POS-ADMIN', 'verified', 'active', 999999999.0)`,
      ['إدارة محفظة البرق', ADMIN_PHONE, hashPassword(ADMIN_DEFAULT_PASS)]
    );
  } else {
    await runAsync(
      `UPDATE users SET role = 'admin', kyc_status = 'verified', daily_limit = 999999999.0 WHERE phone = ?`,
      [ADMIN_PHONE]
    );
  }
}

async function recordDoubleEntry(txRef, debitAccount, creditAccount, amount) {
  await runAsync(
    `INSERT INTO ledger_entries (tx_reference, account_code, debit, credit) VALUES (?, ?, ?, 0.0)`,
    [txRef, debitAccount, amount]
  );
  await runAsync(
    `INSERT INTO ledger_entries (tx_reference, account_code, debit, credit) VALUES (?, ?, 0.0, ?)`,
    [txRef, creditAccount, amount]
  );
}

// إنشاء حساب جديد (التسجيل)
app.post('/api/register', async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');

    if (!fullName || phone.length < 7 || password.length < 4) {
      return res.status(400).json({ ok: false, message: 'يرجى إدخال الاسم الكامل ورقم هاتف صحيح وكلمة مرور (4 أحرف فأكثر)' });
    }

    if (phone === ADMIN_PHONE) {
      return res.status(403).json({ ok: false, message: 'هذا الرقم محجوز لحساب الإدارة' });
    }

    const exists = await getAsync('SELECT id FROM users WHERE phone = ?', [phone]);
    if (exists) {
      return res.status(409).json({ ok: false, message: 'رقم الهاتف مسجل مسبقاً' });
    }

    const posCode = `POS-${phone.slice(-6)}-${crypto.randomInt(10, 99)}`;
    await runAsync(
      `INSERT INTO users (full_name, phone, password_hash, role, balance, pos_code, kyc_status, account_status, daily_limit)
       VALUES (?, ?, ?, 'user', 0.0, ?, 'unverified', 'active', 50000.0)`,
      [fullName, phone, hashPassword(password), posCode]
    );

    const user = await getAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit FROM users WHERE phone = ?',
      [phone]
    );

    let registerSmsSent = false;
    if (SEND_REGISTER_SMS) {
      const smsRes = await sendRegisterSms(phone, fullName, posCode);
      registerSmsSent = smsRes.sent;
    }

    return res.json({ ok: true, user, registerSmsSent });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'حدث خطأ أثناء إنشاء المحفظة' });
  }
});

// تسجيل الدخول (مع إمكانية إيقاف OTP عبر DISABLE_OTP)
app.post('/api/login', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');

    const user = await getAsync('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ ok: false, message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    }

    if (user.account_status !== 'active') {
      return res.status(403).json({ ok: false, message: 'هذا الحساب مجمّد حالياً' });
    }

    if (!DISABLE_OTP && user.role === 'admin' && user.phone === ADMIN_PHONE) {
      const otpCode = generateOtpCode();
      const expiresAt = Date.now() + 5 * 60 * 1000;

      await runAsync(
        `INSERT INTO otp_challenges (phone, code, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`,
        [ADMIN_PHONE, otpCode, expiresAt]
      );

      const smsResult = await sendOtpViaTwilio(ADMIN_PHONE, otpCode);

      return res.json({
        ok: true,
        otpRequired: true,
        otpSent: smsResult.sent,
        message: smsResult.message,
        fallbackOtp: smsResult.sent ? undefined : otpCode
      });
    }

    const safeUser = {
      id: user.id,
      full_name: user.full_name,
      phone: user.phone,
      role: user.role,
      balance: user.balance,
      pos_code: user.pos_code,
      kyc_status: user.kyc_status,
      account_status: user.account_status,
      daily_limit: user.daily_limit
    };

    return res.json({ ok: true, otpRequired: false, user: safeUser });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'تعذر إتمام تسجيل الدخول' });
  }
});

// تأكيد OTP للإدارة
app.post('/api/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || ADMIN_PHONE);
    const code = String(req.body.code || '').trim();

    if (phone !== ADMIN_PHONE) {
      return res.status(403).json({ ok: false, message: 'التحقق عبر OTP مخصص لحساب الإدارة فقط' });
    }

    const challenge = await getAsync('SELECT * FROM otp_challenges WHERE phone = ?', [ADMIN_PHONE]);
    if (!challenge || challenge.code !== code || Date.now() > challenge.expires_at) {
      return res.status(400).json({ ok: false, message: 'رمز التحقق OTP غير صحيح أو منتهي الصلاحية' });
    }

    await runAsync('DELETE FROM otp_challenges WHERE phone = ?', [ADMIN_PHONE]);

    const adminUser = await getAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit FROM users WHERE phone = ?',
      [ADMIN_PHONE]
    );

    return res.json({ ok: true, user: adminUser });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'تعذر التحقق من رمز OTP' });
  }
});

// جلب بيانات المستخدم وسجل عملياته
app.get('/api/wallet/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const user = await getAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit FROM users WHERE phone = ?',
      [phone]
    );

    if (!user) {
      return res.status(404).json({ ok: false, message: 'الحساب غير موجود' });
    }

    const transactions = await allAsync(
      `SELECT * FROM transactions
       WHERE sender_phone = ? OR receiver_phone = ?
       ORDER BY id DESC LIMIT 50`,
      [phone, phone]
    );

    return res.json({ ok: true, user, transactions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'خطأ في جلب بيانات المحفظة' });
  }
});

// تحويل رصيد برقم الهاتف
app.post('/api/transfer', async (req, res) => {
  try {
    const senderPhone = normalizePhone(req.body.senderPhone);
    const receiverPhone = normalizePhone(req.body.receiverPhone);
    const amount = Number(req.body.amount);
    const note = String(req.body.note || 'تحويل محفظة البرق').trim();

    if (!senderPhone || !receiverPhone || senderPhone === receiverPhone || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, message: 'بيانات التحويل غير مكتملة أو غير صحيحة' });
    }

    const sender = await getAsync('SELECT * FROM users WHERE phone = ?', [senderPhone]);
    const receiver = await getAsync('SELECT * FROM users WHERE phone = ?', [receiverPhone]);

    if (!sender || !receiver) {
      return res.status(404).json({ ok: false, message: 'تأكد من صحة رقم المرسل ورقم المستلم' });
    }

    if (sender.account_status !== 'active' || receiver.account_status !== 'active') {
      return res.status(403).json({ ok: false, message: 'أحد الحسابين مجمّد' });
    }

    if (sender.balance < amount) {
      return res.status(400).json({ ok: false, message: 'الرصيد غير كافٍ لإتمام التحويل' });
    }

    if (amount > sender.daily_limit) {
      return res.status(400).json({ ok: false, message: 'المبلغ يتجاوز الحد اليومي المسموح للحساب' });
    }

    const txRef = generateRef('TRF');
    await runAsync('UPDATE users SET balance = balance - ? WHERE phone = ?', [amount, senderPhone]);
    await runAsync('UPDATE users SET balance = balance + ? WHERE phone = ?', [amount, receiverPhone]);

    await runAsync(
      `INSERT INTO transactions (reference, type, sender_phone, receiver_phone, amount, note)
       VALUES (?, 'transfer', ?, ?, ?, ?)`,
      [txRef, senderPhone, receiverPhone, amount, note]
    );

    await recordDoubleEntry(txRef, `WALLET:${receiverPhone}`, `WALLET:${senderPhone}`, amount);

    const updatedSender = await getAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit FROM users WHERE phone = ?',
      [senderPhone]
    );

    return res.json({ ok: true, reference: txRef, user: updatedSender });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'حدث خطأ أثناء تنفيذ التحويل' });
  }
});

// الدفع عبر نقطة بيع POS
app.post('/api/pos-pay', async (req, res) => {
  try {
    const payerPhone = normalizePhone(req.body.payerPhone);
    const posCode = String(req.body.posCode || '').trim();
    const amount = Number(req.body.amount);
    const note = String(req.body.note || 'مشتريات نقطة بيع').trim();

    if (!payerPhone || !posCode || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, message: 'يرجى إدخال رمز نقطة البيع والمبلغ بشكل صحيح' });
    }

    const payer = await getAsync('SELECT * FROM users WHERE phone = ?', [payerPhone]);
    const merchant = await getAsync('SELECT * FROM users WHERE pos_code = ?', [posCode]);

    if (!payer || !merchant) {
      return res.status(404).json({ ok: false, message: 'رمز نقطة البيع أو حساب الدافع غير موجود' });
    }

    if (payer.account_status !== 'active' || merchant.account_status !== 'active') {
      return res.status(403).json({ ok: false, message: 'أحد الحسابين مجمّد' });
    }

    if (payer.balance < amount) {
      return res.status(400).json({ ok: false, message: 'رصيد المحفظة غير كافٍ للدفع عبر POS' });
    }

    const txRef = generateRef('POS');
    await runAsync('UPDATE users SET balance = balance - ? WHERE phone = ?', [amount, payerPhone]);
    await runAsync('UPDATE users SET balance = balance + ? WHERE phone = ?', [amount, merchant.phone]);

    await runAsync(
      `INSERT INTO transactions (reference, type, sender_phone, receiver_phone, pos_code, amount, note)
       VALUES (?, 'pos_payment', ?, ?, ?, ?, ?)`,
      [txRef, payerPhone, merchant.phone, posCode, amount, note]
    );

    await recordDoubleEntry(txRef, `POS:${posCode}`, `WALLET:${payerPhone}`, amount);

    const updatedPayer = await getAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit FROM users WHERE phone = ?',
      [payerPhone]
    );

    return res.json({ ok: true, reference: txRef, user: updatedPayer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'حدث خطأ أثناء إتمام الدفع عبر POS' });
  }
});

// طلب التوثيق KYC من المستخدم
app.post('/api/kyc-request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const user = await getAsync('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'الحساب غير موجود' });
    }

    if (user.kyc_status === 'verified') {
      return res.json({ ok: true, kyc_status: 'verified', message: 'الحساب موثّق بالفعل' });
    }

    await runAsync("UPDATE users SET kyc_status = 'pending' WHERE phone = ?", [phone]);
    return res.json({ ok: true, kyc_status: 'pending', message: 'تم إرسال طلب التوثيق KYC للمراجعة الإدارية' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'تعذر إرسال طلب التوثيق' });
  }
});

// لوحة الإدارة العليا: ملخص النظام
app.get('/api/admin/overview', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.query.adminPhone || ADMIN_PHONE);
    if (adminPhone !== ADMIN_PHONE) {
      return res.status(403).json({ ok: false, message: 'صلاحية الإدارة غير مخولة' });
    }

    const users = await allAsync(
      'SELECT id, full_name, phone, role, balance, pos_code, kyc_status, account_status, daily_limit, created_at FROM users ORDER BY id ASC'
    );

    const transactions = await allAsync('SELECT * FROM transactions ORDER BY id DESC LIMIT 100');

    const totalUsers = users.length;
    const totalBalances = users.reduce((sum, u) => sum + Number(u.balance || 0), 0);
    const totalTransactions = transactions.length;
    const vaultBalance = 100000000.0 - totalBalances;

    return res.json({
      ok: true,
      stats: {
        totalUsers,
        totalBalances,
        vaultBalance,
        totalTransactions
      },
      users,
      transactions
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'خطأ في جلب بيانات لوحة الإدارة' });
  }
});

// لوحة الإدارة العليا: إيداع أو خصم/سحب إداري مع إشعار SMS بالرصيد المتبقي
app.post('/api/admin/adjust-balance', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.body.adminPhone || ADMIN_PHONE);
    if (adminPhone !== ADMIN_PHONE) {
      return res.status(403).json({ ok: false, message: 'صلاحية الإدارة غير مخولة' });
    }

    const targetPhone = normalizePhone(req.body.targetPhone);
    const operation = String(req.body.operation || 'deposit');
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason || 'تغذية رصيد / تسوية').trim();

    if (!targetPhone || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, message: 'يرجى إدخال رقم حساب صحيح ومبلغ أكبر من صفر' });
    }

    const target = await getAsync('SELECT * FROM users WHERE phone = ?', [targetPhone]);
    if (!target) {
      return res.status(404).json({ ok: false, message: 'الحساب المستهدف غير موجود' });
    }

    const txRef = generateRef('BRQ');
    const isWithdraw = operation === 'withdraw';

    if (isWithdraw) {
      if (target.balance < amount) {
        return res.status(400).json({ ok: false, message: 'رصيد الحساب غير كافٍ للخصم / السحب الإداري' });
      }
      await runAsync('UPDATE users SET balance = balance - ? WHERE phone = ?', [amount, targetPhone]);
      await runAsync(
        `INSERT INTO transactions (reference, type, sender_phone, receiver_phone, amount, note)
         VALUES (?, 'admin_adjust', ?, 'VAULT', ?, ?)`,
        [txRef, targetPhone, amount, reason]
      );
      await recordDoubleEntry(txRef, 'VAULT:MAIN', `WALLET:${targetPhone}`, amount);
    } else {
      await runAsync('UPDATE users SET balance = balance + ? WHERE phone = ?', [amount, targetPhone]);
      await runAsync(
        `INSERT INTO transactions (reference, type, sender_phone, receiver_phone, amount, note)
         VALUES (?, 'admin_adjust', 'VAULT', ?, ?, ?)`,
        [txRef, targetPhone, amount, reason]
      );
      await recordDoubleEntry(txRef, `WALLET:${targetPhone}`, 'VAULT:MAIN', amount);
    }

    const updatedTarget = await getAsync('SELECT balance FROM users WHERE phone = ?', [targetPhone]);
    const remainingBalance = Number(updatedTarget ? updatedTarget.balance : 0);

    const smsNotification = await sendBalanceSms(targetPhone, {
      actionLabel: isWithdraw ? 'خصم / سحب إداري' : 'إيداع / إضافة رصيد',
      amount,
      newBalance: remainingBalance,
      reference: txRef,
      reason
    });

    return res.json({
      ok: true,
      reference: txRef,
      newBalance: remainingBalance,
      smsSent: smsNotification.sent,
      message: smsNotification.sent
        ? `تم تنفيذ العملية وإرسال SMS — المبلغ: ${Number(amount).toFixed(2)} | الرصيد المتبقي: ${remainingBalance.toFixed(2)}`
        : `تم تنفيذ العملية بنجاح — المبلغ: ${Number(amount).toFixed(2)} | الرصيد المتبقي: ${remainingBalance.toFixed(2)}`
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'حدث خطأ أثناء تعديل الرصيد' });
  }
});

// لوحة الإدارة العليا: توثيق KYC أو تجميد/تنشيط حساب
app.post('/api/admin/account-action', async (req, res) => {
  try {
    const adminPhone = normalizePhone(req.body.adminPhone || ADMIN_PHONE);
    if (adminPhone !== ADMIN_PHONE) {
      return res.status(403).json({ ok: false, message: 'صلاحية الإدارة غير مخولة' });
    }

    const targetPhone = normalizePhone(req.body.targetPhone);
    const action = String(req.body.action || '');

    const target = await getAsync('SELECT * FROM users WHERE phone = ?', [targetPhone]);
    if (!target) {
      return res.status(404).json({ ok: false, message: 'الحساب غير موجود' });
    }

    if (action === 'verify_kyc') {
      await runAsync("UPDATE users SET kyc_status = 'verified', daily_limit = 500000.0 WHERE phone = ?", [targetPhone]);
    } else if (action === 'toggle_freeze') {
      const nextStatus = target.account_status === 'active' ? 'frozen' : 'active';
      await runAsync('UPDATE users SET account_status = ? WHERE phone = ?', [nextStatus, targetPhone]);
    } else {
      return res.status(400).json({ ok: false, message: 'إجراء غير معروف' });
    }

    return res.json({ ok: true, message: 'تم تحديث حالة الحساب بنجاح' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'تعذر تحديث حالة الحساب' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Al-Barq Wallet server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
