const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const service = require('../src/services/kd_evolution.service');
test('Evolution adapter creates missing instance, configures callback, filters QR data and preserves connected session', async () => {
    let exists = false, connected = false, connections = 0, callback;
    const server = http.createServer(async (req, res) => {
        assert.equal(req.headers.apikey, 'provider-secret');
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/instance/connectionState/')) {
            if (!exists) { res.statusCode = 404; return res.end('{}'); }
            return res.end(JSON.stringify({ instance: { state: connected ? 'open' : 'close' } }));
        }
        if (req.url === '/instance/create') { exists = true; return res.end('{}'); }
        if (req.url.startsWith('/webhook/find/')) return res.end('null');
        if (req.url.startsWith('/webhook/set/')) {
            let body = ''; for await (const chunk of req) body += chunk;
            callback = JSON.parse(body).webhook; return res.end('{}');
        }
        if (req.url.startsWith('/instance/connect/')) {
            connections++; return res.end(JSON.stringify({ base64: 'data:image/png;base64,dGVzdA==', code: 'code', apikey: 'must-not-leak' }));
        }
        res.statusCode = 404; res.end('{}');
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    Object.assign(process.env, { EVOLUTION_URL: `http://127.0.0.1:${server.address().port}`,
        EVOLUTION_API_KEY: 'provider-secret', EVOLUTION_INSTANCE: 'test', KD_WEBHOOK_SECRET: 'hook-secret',
        KD_WEBHOOK_URL: 'http://api:3000/api/v1/webhooks/evolution' });
    try {
        await service.setupInstance();
        assert.equal(callback.headers['x-webhook-secret'], 'hook-secret');
        assert.deepEqual(callback.events, ['MESSAGES_UPDATE', 'MESSAGES_UPSERT']);
        const qr = await service.getQr();
        assert.equal(qr.qr, 'data:image/png;base64,dGVzdA==');
        assert.equal(qr.apikey, undefined);
        connected = true;
        assert.equal((await service.getQr()).connected, true);
        assert.equal(connections, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
