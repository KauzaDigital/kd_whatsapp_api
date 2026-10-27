const crypto = require("node:crypto");

function kdAuth(req, res, next) {
    const expected = process.env.KD_API_KEY;
    const received = req.get("x-api-key");

    if (!expected || !received) {
        return res.status(401).json({
            success: false,
            error: "API Key requerida"
        });
    }

    const a = Buffer.from(received);
    const b = Buffer.from(expected);

    if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
    ) {
        return res.status(401).json({
            success: false,
            error: "API Key inválida"
        });
    }

    next();
}

module.exports = kdAuth;