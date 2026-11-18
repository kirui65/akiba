// google-auth.js — Google sign-in for Akiba (free, via Firebase Authentication).
// Adds two endpoints without changing the existing phone + password login:
//
//   POST /api/auth/google        { idToken }
//     Signs in a Google account that has already been linked to an Akiba account.
//     Returns { user, token } in the same shape as /api/login.
//     If the Google account isn't linked yet, returns 404 { needsLink: true }.
//
//   POST /api/auth/google/link   { idToken }   (header: Authorization: Bearer <token>)
//     Links the Google account to the Akiba account that is currently signed in
//     with phone + password. Google alone can never take over a balance.
//
// Usage in server.js:  require('./google-auth')(app, { db, admin });

const crypto = require('crypto');

module.exports = function registerGoogleAuth(app, { db, admin }) {
    const usersCol = db.collection('users');
    const linksCol = db.collection('google_links'); // doc id = Google uid, fields: phone

    // Remove private fields before sending a user to the browser
    function publicUser(u) {
        const { password, authToken, resetCode, resetCodeExpiry, ...rest } = u;
        return rest;
    }

    async function verifyIdToken(idToken) {
        if (!idToken || typeof idToken !== 'string') throw new Error('Missing Google token.');
        // Throws if the token is invalid, expired, or from another Firebase project
        return admin.auth().verifyIdToken(idToken);
    }

    // Issues a fresh session token, the same way phone login does
    async function issueSession(phone, user) {
        const token = crypto.randomBytes(24).toString('hex');
        await usersCol.doc(phone).update({ authToken: token });
        return { user: publicUser({ ...user, authToken: token }), token };
    }

    app.post('/api/auth/google', async (req, res) => {
        try {
            const decoded = await verifyIdToken(req.body && req.body.idToken);
            const link = await linksCol.doc(decoded.uid).get();
            if (!link.exists) {
                return res.status(404).json({
                    needsLink: true,
                    error: 'This Google account is not linked to an Akiba account yet. Sign in with your phone number and password first, then link Google in Settings.'
                });
            }
            const phone = link.data().phone;
            const userSnap = await usersCol.doc(phone).get();
            if (!userSnap.exists) {
                return res.status(404).json({ error: 'The linked account no longer exists.' });
            }
            const session = await issueSession(phone, userSnap.data());
            res.json(session);
        } catch (err) {
            console.error('Google sign-in error:', err.message);
            res.status(401).json({ error: 'Google sign-in failed. Try again.' });
        }
    });

    app.post('/api/auth/google/link', async (req, res) => {
        try {
            const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!bearer) return res.status(401).json({ error: 'Log in first.' });

            // Find the signed-in account by its session token
            const found = await usersCol.where('authToken', '==', bearer).limit(1).get();
            if (found.empty) return res.status(401).json({ error: 'Session expired. Log in again.' });
            const phone = found.docs[0].id;

            const decoded = await verifyIdToken(req.body && req.body.idToken);

            // A Google account can be linked to only one Akiba account
            const existing = await linksCol.doc(decoded.uid).get();
            if (existing.exists && existing.data().phone !== phone) {
                return res.status(409).json({ error: 'This Google account is already linked to another Akiba account.' });
            }

            const batch = db.batch();
            batch.set(linksCol.doc(decoded.uid), { phone, linkedAt: Date.now() });
            batch.update(usersCol.doc(phone), {
                googleUid: decoded.uid,
                googleEmail: decoded.email || null
            });
            await batch.commit();

            res.json({ success: true, googleEmail: decoded.email || null });
        } catch (err) {
            console.error('Google link error:', err.message);
            res.status(400).json({ error: 'Could not link Google. Try again.' });
        }
    });
};
