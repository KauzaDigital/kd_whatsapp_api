const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const createRouter = require('../src/routes/kd_whatsapp.routes');
const { MessageStore } = require('../src/services/kd_message_store');
const { validateDocument, MAX_PDF_BYTES } = require('../src/services/kd_pdf');
const evolution = require('../src/services/kd_evolution.service');
const base64 = Buffer.from('%PDF-1.4\nPDF fixture\n%%EOF').toString('base64');
const document = { number: '51918592638', fileName: 'acta.pdf', base64, caption: 'Su acta' };

test('PDF validation rejects malformed, non-PDF, invalid fields and oversized files', () => {
    for (const change of [{ number: '+51' }, { fileName: '../acta.pdf' }, { fileName: 'acta.exe' },
        { caption: 'a'.repeat(1025) }, { base64: 'not base64' }, { base64: 'aGVsbG8=' },
        { base64: '' }, { base64: 'data:text/plain;base64,' + base64 }]) {
        assert.equal(validateDocument({ ...document, ...change }).status, 400);
    }
    assert.equal(validateDocument({ ...document, base64: 'a'.repeat(4 * Math.ceil(MAX_PDF_BYTES / 3) + 4) }).status, 413);
    const exact = Buffer.alloc(MAX_PDF_BYTES, 32); exact.write('%PDF-1.4');
    assert.ok(validateDocument({ ...document, base64: exact.toString('base64') }).document);
    const over = Buffer.concat([exact, Buffer.from(' ')]);
    assert.equal(validateDocument({ ...document, base64: over.toString('base64') }).status, 413);
    assert.equal(validateDocument({ ...document, base64: 'data:application/pdf;base64,' + base64 }).document.base64, base64);
});

test('authenticated PDF route accepts large documents and tracks receipts, failures and invalid requests', async () => {
    process.env.KD_API_KEY = 'test-api';
    const store = new MessageStore(':memory:');
    let calls = 0, mode = 'ok', received;
    const app = express();
    app.use('/api/v1', createRouter({ store, instance: 'test', webhookSecret: 'hook', evolution: {
        async sendDocument(value) {
            calls++; received = value;
            if (mode === 'timeout') throw new Error('secret payload must not leak');
            if (mode === 'missing') return {};
            store.update('pdf-id', 'DELIVERY_ACK');
            return { key: { id: 'pdf-id' }, status: 'PENDING' };
        }
    } }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1`;
    const post = (body, headers = { 'x-api-key': 'test-api' }) => fetch(url + '/messages/document', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
        assert.equal((await post(document, {})).status, 401);
        assert.equal((await post({ ...document, base64: 'invalid' })).status, 400);
        assert.equal(calls, 0);
        const large = Buffer.from('%PDF-1.4\n' + ' '.repeat(150000)).toString('base64');
        const response = await post({ ...document, base64: large });
        assert.equal(response.status, 202);
        const data = await response.json();
        assert.equal(data.provider_message_id, 'pdf-id');
        assert.equal(data.delivered, true);
        assert.equal(data.base64, undefined);
        assert.equal(received.base64, large);
        await fetch(url + '/webhooks/evolution', { method: 'POST', headers: {
            'Content-Type': 'application/json', 'x-webhook-secret': 'hook' }, body: JSON.stringify({
            instance: 'test', event: 'MESSAGES_UPDATE', data: { keyId: 'pdf-id', fromMe: true, status: 'READ' } }) });
        const receipt = await fetch(url + '/messages/pdf-id', { headers: { 'x-api-key': 'test-api' } });
        assert.equal((await receipt.json()).read, true);
        mode = 'timeout';
        const failure = await post(document);
        assert.equal(failure.status, 502);
        assert.ok(!(await failure.text()).includes('secret'));
        mode = 'missing'; assert.equal((await post(document)).status, 502);
        const before = calls;
        assert.equal((await post({ ...document, base64: 'x'.repeat(14 * 1024 * 1024) })).status, 413);
        assert.equal(calls, before);
    } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('Evolution PDF adapter sends the expected document payload and API key', async () => {
    let received;
    const server = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        received = { path: req.url, key: req.headers.apikey, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ key: { id: 'provider-pdf' }, status: 'PENDING' }));
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    Object.assign(process.env, { EVOLUTION_URL: `http://127.0.0.1:${server.address().port}`,
        EVOLUTION_INSTANCE: 'test instance', EVOLUTION_API_KEY: 'provider-key' });
    try {
        assert.equal((await evolution.sendDocument(document)).key.id, 'provider-pdf');
        assert.equal(received.path, '/message/sendMedia/test%20instance');
        assert.equal(received.key, 'provider-key');
        assert.deepEqual(received.body, { number: document.number, mediatype: 'document',
            mimetype: 'application/pdf', media: base64, fileName: 'acta.pdf', caption: 'Su acta' });
    } finally { await new Promise(resolve => server.close(resolve)); }
});
