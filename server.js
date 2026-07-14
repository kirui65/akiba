const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// ── Firebase init ─────────────────────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
});
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Email: free via Gmail SMTP + App Password ─────────────────────────────────
// Uses your own Gmail account to send — no third-party signup, free for normal
// volumes (Gmail's own sending limit is ~500/day, far more than a password-reset
// flow needs). Requires GMAIL_USER and GMAIL_APP_PASSWORD env vars — see setup
// notes below the routes.
const mailTransport = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    })
    : null;

async function sendResetCodeEmail(toEmail, code, name) {
    if (!mailTransport) throw new Error('Email not configured (missing GMAIL_USER/GMAIL_APP_PASSWORD)');
    await mailTransport.sendMail({
        from: `"Akiba Wealth" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        subject: `Your Akiba Wealth password reset code: ${code}`,
        text: `Hi ${name || ''},\n\nYour password reset code is ${code}. It expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.\n\n— Akiba Wealth`,
        html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px">
            <h2 style="color:#0F6E3F;margin-bottom:4px">Akiba Wealth</h2>
            <p>Hi ${name || ''},</p>
            <p>Your password reset code is:</p>
            <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#0B3B2A;margin:16px 0">${code}</p>
            <p style="color:#5A6E64;font-size:13px">This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>`
    });
}

// ── Helper: get user doc ──────────────────────────────────────────────────────
async function getUser(phone) {
    const doc = await db.collection('users').doc(phone).get();
    return doc.exists ? { ...doc.data(), phone } : null;
}
async function saveUser(phone, data) {
    await db.collection('users').doc(phone).set(data, { merge: true });
}

// ── Helper: session tokens ─────────────────────────────────────────────────────
// Every user gets a random session token on signup/login. The client stores it and
// sends it back on every request via the X-Auth-Token header. Any endpoint that reads
// or changes one specific person's data must confirm that header matches the token on
// file for that phone — otherwise one user's balance, history, and referral data would
// be readable (and in a couple of cases, spendable) by anyone who knows their number.
function genToken() {
    return crypto.randomBytes(24).toString('hex');
}
function stripPrivate(user) {
    const { password, authToken, ...safe } = user;
    return safe;
}
async function requireAuth(req, res, phone) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = await getUser(phone);
    if (!user || !token || user.authToken !== token) {
        res.status(401).json({ error: 'Session expired. Please log in again.' });
        return null;
    }
    return user;
}

// ── AUTH: Signup ──────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
    const { name, phone, password, email, refCode } = req.body;
    if (!name || !phone || !password || !email) return res.status(400).json({ error: 'Fill all fields' });
    if (!/^0(7|1)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Valid M-Pesa number required (07 or 01)' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required for password recovery' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

    const existing = await getUser(phone);
    if (existing) return res.status(400).json({ error: 'Phone already registered' });

    // Validate referral code
    let referredBy = null;
    if (refCode) {
        const code = refCode.toUpperCase();
        if (!/^AK[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Invalid referral code' });
        // Find inviter by code
        const snap = await db.collection('users').where('inviteCode', '==', code).limit(1).get();
        if (snap.empty) return res.status(400).json({ error: 'Invalid referral code' });
        const inviterPhone = snap.docs[0].id;
        if (inviterPhone === phone) return res.status(400).json({ error: 'You cannot refer yourself' });
        referredBy = inviterPhone;
    }

    // Generate invite code for new user
    let h = 0;
    for (let i = 0; i < phone.length; i++) h = Math.imul(31, h) + phone.charCodeAt(i) | 0;
    const inviteCode = 'AK' + Math.abs(h).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
    const authToken = genToken();

    const newUser = {
        name, phone, password, email, inviteCode, authToken,
        balance: 50,
        bonusAmount: 50,
        activeInvestment: null,
        totalReturnsEarned: 0,
        referralBonus: 0,
        totalReferrals: 0,
        referralHistory: [],
        firstDepositBonusGiven: false,
        referredBy: referredBy || null,
        referralBonusPaid: false,
        transactionHistory: ['🎉 Welcome bonus +KES 50 (non-withdrawable)', '📝 Account created'],
        createdAt: Date.now()
    };
    await saveUser(phone, newUser);

    // Record the join against the inviter right away, so they can see who used their
    // link even before that person makes their first deposit. This entry gets updated
    // (not duplicated) once the referral bonus is actually earned.
    if (referredBy) {
        const inviter = await getUser(referredBy);
        if (inviter) {
            await saveUser(referredBy, {
                totalReferrals: (inviter.totalReferrals || 0) + 1,
                referralHistory: [
                    { phone, name, status: 'joined', amount: 0, date: Date.now() },
                    ...(inviter.referralHistory || [])
                ]
            });
        }
    }

    res.json({ success: true, message: 'Account created! KES 50 bonus added.' });
});

// ── AUTH: Login ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Enter phone and password' });
    const user = await getUser(phone);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid phone or password' });
    const token = genToken();
    await saveUser(phone, { authToken: token });
    res.json({ success: true, user: stripPrivate({ ...user, authToken: token }), token });
});

// ── AUTH: Forgot password — email a reset code ────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !/^0(7|1)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Valid M-Pesa number required' });
    const user = await getUser(phone);
    // Don't reveal whether the phone is registered — same generic message either way.
    const generic = { success: true, message: 'If that number has an account with an email on file, a reset code has been sent.' };
    if (!user || !user.email) return res.json(generic);

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    await saveUser(phone, { resetCode: code, resetCodeExpiry: Date.now() + 15 * 60 * 1000 });

    // Respond immediately — don't make the user wait on the Gmail SMTP round trip
    // (typically 0.5–2s). The code is already saved, so the send is fire-and-forget;
    // any failure is only logged server-side, since we already give a generic
    // response either way (to avoid revealing whether the account/email exists).
    res.json(generic);

    sendResetCodeEmail(user.email, code, user.name).catch(err => {
        console.error('Failed to send reset email:', err);
    });
});

// ── AUTH: Reset password with emailed code ────────────────────────────────────
app.post('/api/reset-password', async (req, res) => {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    const user = await getUser(phone);
    if (!user) return res.status(400).json({ error: 'Phone number not registered' });
    if (!user.resetCode || !user.resetCodeExpiry || Date.now() > user.resetCodeExpiry) {
        return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if (user.resetCode !== String(code).trim()) return res.status(400).json({ error: 'Incorrect code' });

    // Password changed — burn the code and rotate the session token so any
    // previously-leaked token/session is invalidated too.
    await saveUser(phone, {
        password: newPassword,
        authToken: genToken(),
        resetCode: null,
        resetCodeExpiry: null
    });
    res.json({ success: true });
});

// ── USER: Get current user data ───────────────────────────────────────────────
app.get('/api/user/:phone', async (req, res) => {
    const user = await requireAuth(req, res, req.params.phone);
    if (!user) return; // requireAuth already sent the 401 response
    res.json(stripPrivate(user));
});

// ── USER: Update profile ──────────────────────────────────────────────────────
app.post('/api/update-profile', async (req, res) => {
    const { phone, name, email } = req.body;
    const user = await requireAuth(req, res, phone);
    if (!user) return;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    const update = { name };
    if (email !== undefined) update.email = email || null;
    await saveUser(phone, update);
    res.json({ success: true });
});

// ── USER: Change password ─────────────────────────────────────────────────────
app.post('/api/change-password', async (req, res) => {
    const { phone, currentPassword, newPassword } = req.body;
    const user = await requireAuth(req, res, phone);
    if (!user) return;
    if (user.password !== currentPassword) return res.status(401).json({ error: 'Current password incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    await saveUser(phone, { password: newPassword });
    res.json({ success: true });
});

// ── INVEST ────────────────────────────────────────────────────────────────────
app.post('/api/invest', async (req, res) => {
    const { phone, amount } = req.body;
    const RULES = { 300: 400, 800: 1200, 1000: 1600, 2000: 3000, 5000: 6500, 10000: 15000, 20000: 30000 };
    const returnAmount = RULES[Number(amount)];
    if (!returnAmount) return res.status(400).json({ error: 'Invalid plan amount' });

    const user = await requireAuth(req, res, phone);
    if (!user) return;
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    if (user.activeInvestment) return res.status(400).json({ error: 'You have an active investment. Wait for maturity.' });

    const updatedUser = {
        ...user,
        balance: user.balance - Number(amount),
        activeInvestment: { amount: Number(amount), returnAmount, startDate: Date.now() },
        transactionHistory: [`📈 Invested KES ${Number(amount).toLocaleString()} → returns KES ${returnAmount.toLocaleString()} after 7 days`, ...(user.transactionHistory || [])].slice(0, 100)
    };
    await saveUser(phone, updatedUser);
    res.json({ success: true, user: stripPrivate(updatedUser) });
});

// ── CHECK MATURED INVESTMENT ──────────────────────────────────────────────────
app.post('/api/check-matured', async (req, res) => {
    const { phone } = req.body;
    const user = await requireAuth(req, res, phone);
    if (!user) return;
    if (!user.activeInvestment) return res.json({ matured: false, user: stripPrivate(user) });

    const elapsed = Date.now() - user.activeInvestment.startDate;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (elapsed < sevenDays) return res.json({ matured: false, user: user });

    const { amount, returnAmount } = user.activeInvestment;
    const profit = returnAmount - amount;
    const updatedUser = {
        ...user,
        balance: user.balance + returnAmount,
        totalReturnsEarned: (user.totalReturnsEarned || 0) + profit,
        activeInvestment: null,
        transactionHistory: [`💰 Investment matured! +KES ${returnAmount.toLocaleString()} (profit: KES ${profit.toLocaleString()})`, ...(user.transactionHistory || [])].slice(0, 100)
    };
    await saveUser(phone, updatedUser);
    res.json({ matured: true, user: stripPrivate(updatedUser) });
});

// ── WITHDRAW (manual — admin approves) ───────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount, withdrawPhone } = req.body;
    const MIN = 200;
    if (!amount || Number(amount) < MIN) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN}` });
    const user = await requireAuth(req, res, phone);
    if (!user) return;

    const withdrawable = user.balance - (user.bonusAmount || 0);
    if (withdrawable < Number(amount)) return res.status(400).json({ error: `Insufficient withdrawable balance. Available: KES ${withdrawable}` });

    const updatedUser = {
        ...user,
        balance: user.balance - Number(amount),
        transactionHistory: [`💸 Withdrawal KES ${Number(amount).toLocaleString()} to ${withdrawPhone} — Processing`, ...(user.transactionHistory || [])].slice(0, 100)
    };
    // Log withdrawal request for admin
    await db.collection('withdrawals').add({
        phone, withdrawPhone, amount: Number(amount),
        status: 'pending', requestedAt: Date.now()
    });
    await saveUser(phone, updatedUser);
    res.json({ success: true, user: stripPrivate(updatedUser), message: 'Withdrawal request submitted. Processing within 24 hours.' });
});

// ── DEPOSIT: Trigger Lipwa STK push ──────────────────────────────────────────
app.post('/api/deposit', async (req, res) => {
    const { phone, amount, phone_number } = req.body;
    if (!amount || isNaN(amount) || Number(amount) < 100) return res.status(400).json({ error: 'Minimum deposit is KES 100.' });
    if (!phone_number || !/^(07|01|254)\d{8,9}$/.test(String(phone_number).replace('+', ''))) return res.status(400).json({ error: 'Invalid phone number.' });

    const user = await requireAuth(req, res, phone);
    if (!user) return;
    // Built server-side (not trusted from the client) so the account that gets
    // credited is always the account whose session token was just verified above.
    const api_ref = `AKIBA-DEP-${phone}-${Date.now()}`;

    const LIPWA_KEY     = process.env.LIPWA_API_KEY;
    const LIPWA_CHANNEL = process.env.LIPWA_CHANNEL_ID;
    const CALLBACK_URL  = process.env.CALLBACK_URL;

    if (!LIPWA_KEY || !LIPWA_CHANNEL || !CALLBACK_URL) {
        console.error('Missing Lipwa env vars');
        return res.status(500).json({ error: 'Payment service not configured.' });
    }

    try {
        const lipwaRes = await fetch('https://pay.lipwa.app/api/payments', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${LIPWA_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: Number(amount), callback_url: CALLBACK_URL, channel_id: LIPWA_CHANNEL, phone_number, api_ref })
        });
        const data = await lipwaRes.json();
        if (lipwaRes.status === 201 && data.ResponseCode === '0') {
            return res.json({ success: true, checkoutRequestId: data.CheckoutRequestID, message: data.CustomerMessage || 'STK push sent. Enter M-Pesa PIN.' });
        }
        return res.status(400).json({ error: data.ResponseDescription || data.message || 'Payment request failed.' });
    } catch (err) {
        console.error('Lipwa error:', err);
        return res.status(502).json({ error: 'Could not reach payment provider. Try again.' });
    }
});

// ── DEPOSIT: Poll status ──────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
    const { ref } = req.query;
    if (!ref) return res.status(400).json({ error: 'Invalid ref.' });
    const LIPWA_KEY = process.env.LIPWA_API_KEY;
    try {
        const lipwaRes = await fetch(`https://pay.lipwa.app/api/status?ref=${encodeURIComponent(ref)}`, {
            headers: { 'Authorization': `Bearer ${LIPWA_KEY}` }
        });
        const data = await lipwaRes.json();
        res.json({ status: data.status, amount: data.amount, receipt: data.receipt, transaction_date: data.transaction_date });
    } catch (err) {
        res.status(502).json({ error: 'Could not check status.' });
    }
});

// ── Lipwa webhook: payment confirmed ─────────────────────────────────────────
app.post('/api/callback', async (req, res) => {
    const payload = req.body;
    console.log('Lipwa callback:', JSON.stringify(payload));

    if (payload.status === 'payment.success') {
        // api_ref format: AKIBA-DEP-07XXXXXXXX-timestamp
        const parts = payload.api_ref?.split('-');
        const phone = parts?.[2];
        const amount = Number(payload.amount);

        if (!phone) {
            console.error('Callback: could not extract phone from api_ref:', payload.api_ref);
        }

        if (phone) {
            const user = await getUser(phone);
            if (!user) {
                console.error('Callback: no user found for phone:', phone);
            }
            if (user) {
                const isFirstDeposit = !user.firstDepositBonusGiven;
                const firstDepositBonus = (isFirstDeposit && amount >= 200) ? 75 : 0;
                const mpesaCode = payload.mpesa_code || null;
                const txNote = `📥 Deposited KES ${amount.toLocaleString()} via M-Pesa${mpesaCode ? ` (${mpesaCode})` : ''}${firstDepositBonus ? ` + KES ${firstDepositBonus} first deposit bonus` : ''}`;

                let updatedUser = {
                    ...user,
                    balance: user.balance + amount + firstDepositBonus,
                    bonusAmount: (user.bonusAmount || 0) + firstDepositBonus,
                    firstDepositBonusGiven: isFirstDeposit ? true : user.firstDepositBonusGiven,
                    transactionHistory: [txNote, ...(user.transactionHistory || [])].slice(0, 100)
                };

                // Referral bonus: credit inviter KES 50 once their friend's first deposit clears KES 75.
                // The "joined" entry for this person was already recorded on the inviter's side at
                // signup — we update that same entry here instead of adding a second one.
                if (!user.referralBonusPaid && user.referredBy && amount >= 200) {
                    updatedUser.referralBonusPaid = true;
                    const inviter = await getUser(user.referredBy);
                    if (inviter) {
                        const REFERRAL_BONUS = 50;
                        const updatedHistory = (inviter.referralHistory || []).map(function(entry) {
                            if (entry.phone === phone && entry.status === 'joined') {
                                return { ...entry, status: 'bonus earned', amount, date: Date.now() };
                            }
                            return entry;
                        });
                        await saveUser(user.referredBy, {
                            balance: inviter.balance + REFERRAL_BONUS,
                            bonusAmount: (inviter.bonusAmount || 0) + REFERRAL_BONUS,
                            referralBonus: (inviter.referralBonus || 0) + REFERRAL_BONUS,
                            referralHistory: updatedHistory,
                            transactionHistory: [`🤝 Referral bonus +KES ${REFERRAL_BONUS} — ${user.name} deposited!`, ...(inviter.transactionHistory || [])].slice(0, 100)
                        });
                    }
                }

                await saveUser(phone, updatedUser);

                // Log transaction
                await db.collection('transactions').add({
                    phone, amount, receipt: payload.mpesa_code || null,
                    status: 'success', createdAt: Date.now(), api_ref: payload.api_ref
                });
            }
        }
    }
    res.json({ received: true });
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Akiba Wealth running on port ${PORT}`));
