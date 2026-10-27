const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { MessageStore, normalize } = require('../src/services/kd_message_store');
const createRouter = require('../src/routes/kd_whatsapp.routes');
test('persists receipts across restarts and preserves delivery evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-messages-'));
    const file = path.join(dir, 'messages.sqlite');
    let store = new MessageStore(file);
    try {
        store.update('a', 'READ');
        store.update('a', 'accepted', '51918592638');
        store.update('a', 'SERVER_ACK');
        store.update('a', 'ERROR');
        assert.equal(store.get('a').status, 'READ');
        assert.equal(store.get('a').number, '51918592638');
        store.update('b', 'PENDING');
        store.update('b', 'ERROR');
        assert.equal(store.get('b').status, 'ERROR');
        store.close(); store = new MessageStore(file);
        assert.equal(store.get('a').status, 'READ');
        assert.equal(normalize(3), 'DELIVERY_ACK');
        assert.equal(normalize('BOGUS'), null);
    } finally { store.close(); fs.rmSync(dir, { recursive: true }); }
});
test('HTTP send, authenticated receipts, races, batch, validation and lookup', async () => {
    process.env.KD_API_KEY = 'test-api';
    const store = new MessageStore(':memory:');
    const app = express(); app.use(express.json());
    app.use('/api/v1', createRouter({ store, instance: 'test', webhookSecret: 'test-hook', evolution: {
        async sendText() { store.update('wa-id', 'DELIVERY_ACK'); return { key: { id: 'wa-id' }, status: 'PENDING' }; },
        async setupInstance() { return { instance: 'test', state: 'close', connected: false }; },
        async connectionState() { return { instance: 'test', state: 'open', connected: true }; },
        async getQr() { return { instance: 'test', state: 'connecting', connected: false, qr: 'data:image/png;base64,dGVzdA==' }; }
    }}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const request = (url, body, headers = {}) => fetch(base + url, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const auth = { 'x-api-key': 'test-api' }, hook = { 'x-webhook-secret': 'test-hook' };
    const receipt = { event: 'messages.update', instance: 'test', data: { keyId: 'wa-id', messageId: 'internal-id', fromMe: true, status: 'READ' } };
    try {
        assert.equal((await request('/messages/wa-id')).status, 401);
        assert.equal((await request('/whatsapp/qr')).status, 401);
        assert.equal((await request('/whatsapp/instance', {})).status, 401);
        assert.equal((await request('/whatsapp/instance', {}, auth)).status, 200);
        const qr = await request('/whatsapp/qr', null, auth);
        assert.equal(qr.headers.get('cache-control'), 'no-store');
        assert.equal((await qr.json()).qr, 'data:image/png;base64,dGVzdA==');
        assert.equal((await (await request('/whatsapp/connection', null, auth)).json()).connected, true);
        assert.equal((await request('/messages/missing', null, auth)).status, 404);
        assert.equal((await request('/messages/text', { number: '+51', message: '' }, auth)).status, 400);
        const sent = await request('/messages/text', { number: '51918592638', message: 'Test' }, auth);
        assert.equal(sent.status, 202); assert.equal((await sent.json()).status, 'DELIVERY_ACK');
        assert.equal((await request('/webhooks/evolution', receipt)).status, 401);
        assert.equal((await request('/webhooks/evolution', { ...receipt, instance: 'other' }, hook)).status, 400);
        assert.equal((await request('/webhooks/evolution', { ...receipt, data: {} }, hook)).status, 400);
        assert.equal((await request('/webhooks/evolution', receipt, hook)).status, 200);
        const batch = { ...receipt, data: [{ keyId: 'wa-id', fromMe: true, status: 2 }, { keyId: 'incoming', fromMe: false, status: 'READ' }] };
        await request('/webhooks/evolution', batch, hook);
        await request('/webhooks/evolution', receipt, hook);
        const result = await (await request('/messages/wa-id', null, auth)).json();
        assert.equal(result.status, 'READ'); assert.equal(result.delivered, true); assert.equal(result.read, true);
        assert.equal(store.get('internal-id'), undefined); assert.equal(store.get('incoming'), undefined);
    } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
