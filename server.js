const express = require('express');
const path = require('path');
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

// ── Helper: get user doc ──────────────────────────────────────────────────────
async function getUser(phone) {
    const doc = await db.collection('users').doc(phone).get();
    return doc.exists ? { ...doc.data(), phone } : null;
}
async function saveUser(phone, data) {
    await db.collection('users').doc(phone).set(data, { merge: true });
}

// ── AUTH: Signup ──────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
    const { name, phone, password, refCode } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Fill all fields' });
    if (!/^0(7|1)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Valid M-Pesa number required (07 or 01)' });
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

    const newUser = {
        name, phone, password, inviteCode,
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
    res.json({ success: true, message: 'Account created! KES 50 bonus added.' });
});

// ── AUTH: Login ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Enter phone and password' });
    const user = await getUser(phone);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid phone or password' });
    // Return user without password
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
});

// ── AUTH: Reset Password ──────────────────────────────────────────────────────
app.post('/api/reset-password', async (req, res) => {
    const { phone, pin, newPassword } = req.body;
    if (!phone || !pin || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (!/^0(7|1)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Valid M-Pesa number required (07 or 01)' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    const user = await getUser(phone);
    if (!user) return res.status(400).json({ error: 'Phone number not registered' });
    if (phone.slice(-4) !== pin) return res.status(400).json({ error: 'PIN incorrect' });
    await saveUser(phone, { password: newPassword });
    res.json({ success: true });
});

// ── USER: Get current user data ───────────────────────────────────────────────
app.get('/api/user/:phone', async (req, res) => {
    const user = await getUser(req.params.phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
});

// ── USER: Update profile ──────────────────────────────────────────────────────
app.post('/api/update-profile', async (req, res) => {
    const { phone, name } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await saveUser(phone, { name });
    res.json({ success: true });
});

// ── USER: Change password ─────────────────────────────────────────────────────
app.post('/api/change-password', async (req, res) => {
    const { phone, currentPassword, newPassword } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
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

    const user = await getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    if (user.activeInvestment) return res.status(400).json({ error: 'You have an active investment. Wait for maturity.' });

    const updatedUser = {
        ...user,
        balance: user.balance - Number(amount),
        activeInvestment: { amount: Number(amount), returnAmount, startDate: Date.now() },
        transactionHistory: [`📈 Invested KES ${Number(amount).toLocaleString()} → returns KES ${returnAmount.toLocaleString()} after 7 days`, ...(user.transactionHistory || [])].slice(0, 100)
    };
    await saveUser(phone, updatedUser);
    const { password: _, ...safeUser } = updatedUser;
    res.json({ success: true, user: safeUser });
});

// ── CHECK MATURED INVESTMENT ──────────────────────────────────────────────────
app.post('/api/check-matured', async (req, res) => {
    const { phone } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.activeInvestment) return res.json({ matured: false, user: user });

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
    const { password: _, ...safeUser } = updatedUser;
    res.json({ matured: true, user: safeUser });
});

// ── WITHDRAW (manual — admin approves) ───────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount, withdrawPhone } = req.body;
    const MIN = 200;
    if (!amount || Number(amount) < MIN) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN}` });
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });

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
    const { password: _, ...safeUser } = updatedUser;
    res.json({ success: true, user: safeUser, message: 'Withdrawal request submitted. Processing within 24 hours.' });
});

// ── DEPOSIT: Trigger Lipwa STK push ──────────────────────────────────────────
app.post('/api/deposit', async (req, res) => {
    const { amount, phone_number, api_ref } = req.body;
    if (!amount || isNaN(amount) || Number(amount) < 50) return res.status(400).json({ error: 'Minimum deposit is KES 50.' });
    if (!phone_number || !/^(07|01|254)\d{8,9}$/.test(String(phone_number).replace('+', ''))) return res.status(400).json({ error: 'Invalid phone number.' });
    if (!api_ref || typeof api_ref !== 'string' || api_ref.length > 64) return res.status(400).json({ error: 'Invalid api_ref.' });

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

        if (phone) {
            const user = await getUser(phone);
            if (user) {
                const isFirstDeposit = !user.firstDepositBonusGiven;
                const firstDepositBonus = (isFirstDeposit && amount >= 200) ? 200 : 0;
                const txNote = `📥 Deposited KES ${amount.toLocaleString()} via M-Pesa${firstDepositBonus ? ` + KES ${firstDepositBonus} first deposit bonus` : ''}`;

                let updatedUser = {
                    ...user,
                    balance: user.balance + amount + firstDepositBonus,
                    bonusAmount: (user.bonusAmount || 0) + firstDepositBonus,
                    firstDepositBonusGiven: isFirstDeposit ? true : user.firstDepositBonusGiven,
                    transactionHistory: [txNote, ...(user.transactionHistory || [])].slice(0, 100)
                };

                // Referral bonus: credit inviter KES 50 on first deposit >= 200
                if (!user.referralBonusPaid && user.referredBy && amount >= 200) {
                    updatedUser.referralBonusPaid = true;
                    updatedUser.referredBy = user.referredBy;
                    const inviter = await getUser(user.referredBy);
                    if (inviter) {
                        const REFERRAL_BONUS = 50;
                        await saveUser(user.referredBy, {
                            balance: inviter.balance + REFERRAL_BONUS,
                            bonusAmount: (inviter.bonusAmount || 0) + REFERRAL_BONUS,
                            referralBonus: (inviter.referralBonus || 0) + REFERRAL_BONUS,
                            totalReferrals: (inviter.totalReferrals || 0) + 1,
                            referralHistory: [{ name: user.name, phone: phone.slice(0, 4) + '****' + phone.slice(-2), amount, date: Date.now() }, ...(inviter.referralHistory || [])],
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
