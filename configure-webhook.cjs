const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = process.argv[2];
const dotenv = require(path.join(target, 'node_modules/dotenv'));
const axios = require(path.join(target, 'node_modules/axios'));
async function main() {
    const envPath = path.join(target, '.env');
    const env = dotenv.parse(fs.readFileSync(envPath));
    if (!env.EVOLUTION_URL || !env.EVOLUTION_INSTANCE || !env.EVOLUTION_API_KEY) throw new Error('Configuración Evolution incompleta');
    const secret = env.KD_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
    const url = env.KD_WEBHOOK_URL || `http://host.docker.internal:${env.PORT || 3000}/api/v1/webhooks/evolution`;
    const api = axios.create({ baseURL: env.EVOLUTION_URL, headers: { apikey: env.EVOLUTION_API_KEY }, timeout: 15000 });
    const instance = encodeURIComponent(env.EVOLUTION_INSTANCE);
    const { data: existing } = await api.get('/webhook/find/' + instance);
    if (existing?.enabled && existing.url !== url) throw new Error('Ya existe otro webhook activo; se conserva sin modificar. Revise la configuración.');
    if (!env.KD_WEBHOOK_SECRET) fs.appendFileSync(envPath, '\nKD_WEBHOOK_SECRET=' + secret + '\n');
    await api.post('/webhook/set/' + instance, { webhook: {
        enabled: true, url, byEvents: false, base64: false,
        headers: { 'x-webhook-secret': secret }, events: ['MESSAGES_UPDATE']
    }});
    console.log('Webhook de confirmaciones configurado. Reinicie la API para cargar los cambios.');
}
main().catch(error => { console.error('No se pudo configurar el webhook:', error.message); process.exitCode = 1; });
