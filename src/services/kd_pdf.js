const MAX_PDF_BYTES = 10 * 1024 * 1024;

function validateDocument(body) {
    const { number, fileName, caption = '', base64 } = body || {};
    if (typeof number !== 'string' || !/^[1-9]\d{7,14}$/.test(number)) {
        return { status: 400, error: 'Número inválido: use código de país y solo dígitos' };
    }
    if (typeof fileName !== 'string' || fileName.length > 200 ||
        !fileName.trim() || /[\x00-\x1f\x7f/\\]/.test(fileName) || !/\.pdf$/i.test(fileName)) {
        return { status: 400, error: 'fileName debe ser un nombre de archivo PDF, sin rutas (máximo 200 caracteres)' };
    }
    if (typeof caption !== 'string' || caption.length > 1024) {
        return { status: 400, error: 'caption debe ser texto de hasta 1024 caracteres' };
    }
    if (typeof base64 !== 'string' || !base64) {
        return { status: 400, error: 'base64 es requerido: envíe el contenido del PDF en base64' };
    }
    const media = base64.startsWith('data:application/pdf;base64,')
        ? base64.slice('data:application/pdf;base64,'.length) : base64;
    if (media.length > 4 * Math.ceil(MAX_PDF_BYTES / 3)) {
        return { status: 413, error: 'El PDF supera el límite de 10 MiB' };
    }
    if (!media || media.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(media)) {
        return { status: 400, error: 'Contenido base64 inválido' };
    }
    const pdf = Buffer.from(media, 'base64');
    if (pdf.length > MAX_PDF_BYTES) return { status: 413, error: 'El PDF supera el límite de 10 MiB' };
    if (pdf.toString('base64') !== media || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
        return { status: 400, error: 'El contenido debe ser un PDF en base64 válido' };
    }
    return { document: { number, fileName, caption, base64: media } };
}
module.exports = { validateDocument, MAX_PDF_BYTES };
