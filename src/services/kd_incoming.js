const phoneJid = /^(\d{8,15})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/;

function incoming(item, instance) {
    if (!item || item.key?.fromMe !== false || typeof item.key.id !== 'string' ||
        !item.key.id || item.key.id.length > 200) return null;
    const jid = item.key.remoteJid;
    if (typeof jid !== 'string' || /@(g\.us|broadcast|newsletter)$/.test(jid)) return null;
    const match = phoneJid.exec(jid) || phoneJid.exec(item.key.remoteJidAlt || '');
    let message = item.message || {};
    // Respect view-once media: do not turn it into a persistent attachment.
    if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) {
        message = { conversation: '[Archivo de visualización única: consulte WhatsApp]' };
    } else {
        message = message.ephemeralMessage?.message || message;
        message = message.documentWithCaptionMessage?.message || message;
    }
    const media = message.imageMessage || message.documentMessage;
    const context = message.extendedTextMessage?.contextInfo || media?.contextInfo || {};
    const text = message.conversation || message.extendedTextMessage?.text || media?.caption ||
        (message.audioMessage ? '[Audio recibido: consulte WhatsApp]' :
            message.videoMessage ? '[Vídeo recibido: consulte WhatsApp]' : '');
    if (!text && !media) return null; // reactions, receipts and protocol traffic are not chat messages
    const stamp = Number(item.messageTimestamp?.low ?? item.messageTimestamp);
    if (!Number.isFinite(stamp) || stamp < 1 || stamp > Date.now() / 1000 + 300) return null;
    return { instance, provider_message_id: item.key.id, number: match?.[1] || null,
        text: String(text).slice(0, 4096), quoted_id: String(context.stanzaId || '').slice(0, 200),
        media_type: message.imageMessage ? 'image' : message.documentMessage ? 'document' : null,
        sent_at: new Date(stamp * 1000).toISOString(), raw: JSON.stringify(item) };
}

function safeMedia(base64, mime, fileName = '') {
    if (typeof base64 !== 'string' || !base64 || base64.length > 14 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return null;
    const signatures = {
        'application/pdf': bytes.subarray(0, 5).toString() === '%PDF-',
        'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
        'image/png': bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
        'image/webp': bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
    };
    mime = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
    if (!signatures[mime]) return null;
    const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
    const stem = String(fileName).split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
        .replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 100) || 'archivo';
    return { base64, mimetype: mime, fileName: `${stem}.${extension}` };
}
module.exports = { incoming, safeMedia };
