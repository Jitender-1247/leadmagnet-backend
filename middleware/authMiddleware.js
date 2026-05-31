const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    // 1. Try HttpOnly cookie first (web clients)
    // 2. Fall back to Authorization header (mobile apps / API clients)
    const token =
        req.cookies?.token ||
        (req.headers['authorization']?.split(' ')[1]);

    if (!token) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { uid, email }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};