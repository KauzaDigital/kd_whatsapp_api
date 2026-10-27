const express = require('express');
const crypto = require('node:crypto');
const { validateDocument } = require('../services/kd_pdf');
const kdAuth = require('../middleware/kd_auth.middleware');
const { normalize, present } = require('../services/kd_message_store');
function createRouter({ store, evolution, instance, webhookSecret }) {
    const router = express.Router();
    // Authenticate large PDF requests before decoding their JSON body.
    router.post('/messages/document', kdAuth, express.json({ limit: '14mb' }));
    router.use(express.json({ limit: '100kb' }));
    for (const [method, route, action] of [
        ['post', '/whatsapp/instance', 'setupInstance'],
        ['get', '/whatsapp/connection', 'connectionState'],
        ['get', '/whatsapp/qr', 'getQr']
    ]) {
        router[method](route, kdAuth, async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try {
                const result = await evolution[action]();
                return res.status(action === 'getQr' && !result.connected && !result.qr ? 202 : 200)
                    .json({ success: true, ...result });
            } catch (error) {
                const missing = error.response?.status === 404;
                return res.status(missing ? 404 : 502).json({ success: false,
                    error: missing ? 'Instancia no encontrada. Cree la instancia con POST /api/v1/whatsapp/instance' :
                        'No se pudo completar la operaciÃ³n con Evolution. Revise la configuraciÃ³n y disponibilidad.' });
            }
        });
    }
    async function sendAndTrack(number, send, res, next) {
        let result;
        try { result = await send(); }
        catch (error) {
            // Do not log provider errors: they may contain document data or credentials.
            return res.status(502).json({ success: false, error: 'No se pudo confirmar el envío; consulte antes de reintentar' });
        }
        if (typeof result?.key?.id !== 'string' || !result.key.id) {
            return res.status(502).json({ success: false, error: 'Evolution no devolvió un identificador de seguimiento' });
        }
        try {
            const saved = store.update(result.key.id, normalize(result.status) || 'accepted', number);
            return res.status(202).json({ success: true, ...present(saved) });
        } catch (error) { next(error); }
    }
    router.post('/messages/text', kdAuth, async (req, res, next) => {
        const { number, message } = req.body || {};
        if (typeof number !== 'string' || !/^[1-9]\d{7,14}$/.test(number) ||
            typeof message !== 'string' || !message.trim() || message.length > 4096) {
            return res.status(400).json({ success: false, error: 'Número o mensaje inválido' });
        }
        return sendAndTrack(number, () => evolution.sendText(number, message), res, next);
    });
    router.post('/messages/document', kdAuth, async (req, res, next) => {
        const result = validateDocument(req.body);
        if (result.error) return res.status(result.status).json({ success: false, error: result.error });
        return sendAndTrack(result.document.number, () => evolution.sendDocument(result.document), res, next);
    });
    router.get('/messages/:id', kdAuth, (req, res) => {
        const record = store.get(req.params.id);
        if (!record) return res.status(404).json({ success: false, error: 'Mensaje no encontrado' });
        res.json({ success: true, ...present(record) });
    });
    router.post('/webhooks/evolution', (req, res) => {
        const received = req.get('x-webhook-secret');
        if (!webhookSecret || !received || Buffer.byteLength(received) !== Buffer.byteLength(webhookSecret) ||
            !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(webhookSecret))) {
            return res.status(401).json({ success: false, error: 'Webhook no autorizado' });
        }
        const payload = req.body;
        if (!payload || payload.instance !== instance) return res.status(400).json({ success: false, error: 'Instancia invÃ¡lida' });
        if (!['messages.update', 'MESSAGES_UPDATE'].includes(payload.event)) return res.sendStatus(204);
        const updates = Array.isArray(payload.data) ? payload.data : [payload.data];
        if (!updates.length || updates.some(item => !item || typeof (item.keyId || item.key?.id) !== 'string' ||
            !(item.keyId || item.key?.id).length || !normalize(item.status ?? item.update?.status))) {
            return res.status(400).json({ success: false, error: 'ActualizaciÃ³n invÃ¡lida' });
        }
        let updated = 0;
        for (const item of updates) {
            if ((item.fromMe ?? item.key?.fromMe) !== true) continue;
            // keyId is the WhatsApp ID; messageId is Evolution's internal database ID.
            store.update(item.keyId || item.key.id, item.status ?? item.update?.status);
            updated++;
        }
        res.json({ success: true, updated });
    });
    return router;
}
module.exports = createRouter;
