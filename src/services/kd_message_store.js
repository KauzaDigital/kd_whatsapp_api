const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const ranks = { accepted: -1, ERROR: -1, PENDING: 0, SERVER_ACK: 1, DELIVERY_ACK: 2, READ: 3, PLAYED: 4 };
const numeric = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];
function normalize(value) {
    const status = typeof value === 'number' ? numeric[value] : value;
    return Object.hasOwn(ranks, status) ? status : null;
}
class MessageStore {
    constructor(filename) {
        if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, number TEXT, status TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    }
    get(id) { return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id); }
    update(id, status, number = null) {
        status = normalize(status);
        if (!status) return null;
        const old = this.get(id);
        if (old && ((status === 'ERROR' && ranks[old.status] >= 2) ||
            (status !== 'ERROR' && ranks[old.status] > ranks[status]) ||
            (old.status === 'ERROR' && ['accepted', 'PENDING', 'SERVER_ACK'].includes(status)))) status = old.status;
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET number = COALESCE(excluded.number, messages.number),
            status = excluded.status, updated_at = excluded.updated_at`).run(id, number, status, now, now);
        return this.get(id);
    }
    close() { this.db.close(); }
}
function present(record) {
    const { id, ...rest } = record;
    return { provider_message_id: id, ...rest,
        delivered: ['DELIVERY_ACK', 'READ', 'PLAYED'].includes(record.status),
        read: ['READ', 'PLAYED'].includes(record.status) };
}
module.exports = { MessageStore, normalize, present };
