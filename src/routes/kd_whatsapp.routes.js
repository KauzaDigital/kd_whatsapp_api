const express = require('express');
const crypto = require('node:crypto');
const { validateDocument } = require('../services/kd_pdf');
const kdAuth = require('../middleware/kd_auth.middleware');
const { normalize, present } = require('../services/kd_message_store');
const { incoming, safeMedia } = require('../services/kd_incoming');
function createRouter({ store, evolution, instance, webhookSecret }) {
    const router = express.Router();
    // Authenticate large PDF requests before decoding their JSON body.
    router.post('/messages/document', kdAuth, express.json({ limit: '14mb' }));
    router.post('/messages/media', kdAuth, express.json({ limit: '14mb' }));
    router.post('/webhooks/evolution', (req,res,next) => {
        const received = req.get('x-webhook-secret');
        if (!webhookSecret || !received || Buffer.byteLength(received) !== Buffer.byteLength(webhookSecret) ||
            !crypto.timingSafeEqual(Buffer.from(received),Buffer.from(webhookSecret))) {
            return res.status(401).json({success:false,error:'Webhook no autorizado'});
        }
        next();
    }, express.json({limit:'1mb'}));
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
                        'No se pudo completar la operación con Evolution. Revise la configuración y disponibilidad.' });
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
    router.post('/messages/media', kdAuth, async (req, res, next) => {
        const body = req.body || {};
        const media = safeMedia(body.base64, body.mimetype, body.fileName);
        if (!media || typeof body.number !== 'string' || !/^[1-9]\d{7,14}$/.test(body.number) ||
            typeof (body.caption || '') !== 'string' || (body.caption || '').length > 1024) {
            return res.status(400).json({success:false, error:'Archivo, número o texto inválido; use PDF/JPG/PNG/WEBP hasta 10 MiB'});
        }
        return sendAndTrack(body.number, () => evolution.sendMedia({...media,number:body.number,caption:body.caption || ''}),res,next);
    });
    router.get('/incoming', kdAuth, (req, res) => {
        const after = Number(req.query.after || 0), limit = Number(req.query.limit || 30);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
            return res.status(400).json({success:false,error:'Cursor o límite inválido'});
        }
        res.set('Cache-Control','no-store');
        const messages = store.listIncoming(instance,after,limit);
        res.json({success:true,instance,feed_id:store.feedId(instance),messages,
            cursor:messages.length ? messages.at(-1).seq : after});
    });
    router.get('/incoming/:id/media', kdAuth, async (req,res) => {
        res.set('Cache-Control','no-store');
        const record = store.getIncoming(instance,req.params.id);
        if (!record?.media_type) return res.status(404).json({success:false,error:'Adjunto no encontrado'});
        try {
            const data = await evolution.downloadMedia(record.raw);
            const media = safeMedia(data?.base64, data?.mimetype, data?.fileName);
            if (!media) return res.status(422).json({success:false,error:'Solo se admiten PDF/JPG/PNG/WEBP hasta 10 MiB'});
            res.json({success:true,...media});
        } catch { res.status(502).json({success:false,error:'No se pudo recuperar el adjunto desde Evolution'}); }
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
        if (['messages.upsert','MESSAGES_UPSERT'].includes(payload.event)) {
            if (payload.type === 'append' || payload.data?.type === 'append') return res.sendStatus(204);
            const messages = Array.isArray(payload.data) ? payload.data : [payload.data];
            let received = 0;
            for (const item of messages) {
                const record = incoming(item,instance);
                if (record) received += Number(store.incoming(record));
            }
            return res.json({success:true,received});
        }
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
