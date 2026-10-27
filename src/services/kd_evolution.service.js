const axios = require("axios");

async function sendText(number, message) {
    const baseUrl = process.env.EVOLUTION_URL;
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!baseUrl || !instance || !apiKey) {
        throw new Error(
            "ConfiguraciÃ³n de Evolution API incompleta"
        );
    }

    const url =
        `${baseUrl.replace(/\/$/, "")}` +
        `/message/sendText/${encodeURIComponent(instance)}`;

    const response = await axios.post(
        url,
        {
            number,
            text: message
        },
        {
            headers: {
                apikey: apiKey,
                "Content-Type": "application/json"
            },
            timeout: 15000
        }
    );

    return response.data;
}

function client() {
    if (!process.env.EVOLUTION_URL || !process.env.EVOLUTION_API_KEY || !process.env.EVOLUTION_INSTANCE) {
        throw new Error('ConfiguraciÃ³n de Evolution API incompleta');
    }
    return axios.create({ baseURL: process.env.EVOLUTION_URL.replace(/\/$/, ''),
        headers: { apikey: process.env.EVOLUTION_API_KEY }, timeout: 15000 });
}
const instancePath = () => encodeURIComponent(process.env.EVOLUTION_INSTANCE);
async function connectionState() {
    const { data } = await client().get('/instance/connectionState/' + instancePath());
    const state = data?.instance?.state;
    if (!['open', 'close', 'connecting', 'refused'].includes(state)) throw new Error('Estado de conexiÃ³n desconocido');
    return { instance: process.env.EVOLUTION_INSTANCE, state, connected: state === 'open' };
}
async function getQr() {
    const connection = await connectionState();
    if (connection.connected) return { ...connection, qr: null };
    const { data } = await client().get('/instance/connect/' + instancePath());
    return { ...connection, qr: typeof data?.base64 === 'string' ? data.base64 : null,
        code: typeof data?.code === 'string' ? data.code : null };
}
async function setupInstance() {
    if (!process.env.KD_WEBHOOK_SECRET) throw new Error('KD_WEBHOOK_SECRET requerida');
    const api = client();
    try { await connectionState(); }
    catch (error) {
        if (error.response?.status !== 404) throw error;
        await api.post('/instance/create', { instanceName: process.env.EVOLUTION_INSTANCE,
            integration: 'WHATSAPP-BAILEYS', qrcode: false });
    }
    const url = process.env.KD_WEBHOOK_URL || `http://host.docker.internal:${process.env.PORT || 3000}/api/v1/webhooks/evolution`;
    const { data: existing } = await api.get('/webhook/find/' + instancePath());
    if (existing?.enabled && existing.url !== url) throw new Error('Existe otro webhook activo; revise su URL antes de continuar');
    await api.post('/webhook/set/' + instancePath(), { webhook: { enabled: true, url,
        byEvents: false, base64: false, headers: { 'x-webhook-secret': process.env.KD_WEBHOOK_SECRET },
        events: ['MESSAGES_UPDATE'] } });
    return connectionState();
}
async function sendDocument({ number, base64, fileName, caption = '' }) {
    const { data } = await client().post('/message/sendMedia/' + instancePath(), {
        number, mediatype: 'document', mimetype: 'application/pdf',
        media: base64, fileName, caption
    }, { timeout: 60000 });
    return data;
}
module.exports = { sendDocument, sendText, connectionState, getQr, setupInstance };
