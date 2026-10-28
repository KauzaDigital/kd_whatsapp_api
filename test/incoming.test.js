const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {MessageStore} = require('../src/services/kd_message_store');
const {incoming,safeMedia} = require('../src/services/kd_incoming');
const createRouter = require('../src/routes/kd_whatsapp.routes');
const message = (id='in-1') => ({key:{id,fromMe:false,remoteJid:'51918592638@s.whatsapp.net'},
    messageTimestamp:Math.floor(Date.now()/1000),message:{extendedTextMessage:{text:'Necesito mantenimiento',contextInfo:{stanzaId:'out-1'}}}});

test('incoming normalization rejects outgoing, groups, unknown timestamps and respects view-once',()=>{
    const normalized=incoming(message(),'test');
    assert.equal(normalized.number,'51918592638');assert.equal(normalized.quoted_id,'out-1');
    assert.equal(incoming({...message(),key:{...message().key,fromMe:true}},'test'),null);
    assert.equal(incoming({...message(),key:{...message().key,remoteJid:'123@g.us'}},'test'),null);
    assert.equal(incoming({...message(),messageTimestamp:'invalid'},'test'),null);
    const lid=incoming({...message(),key:{...message().key,remoteJid:'123@lid'}},'test');
    assert.equal(lid.number,null);
    const once=incoming({...message(),message:{viewOnceMessage:{message:{imageMessage:{caption:'private'}}}}},'test');
    assert.equal(once.media_type,null);assert.ok(once.text.includes('única'));
    assert.equal(safeMedia(Buffer.from('<html>x</html>').toString('base64'),'application/pdf','bad.pdf'),null);
});

test('durable incoming feed deduplicates provider IDs and keeps stable pagination and instance separation',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kd-inbox-'));const file=path.join(dir,'inbox.sqlite');
    let store=new MessageStore(file);
    try{
        const feed=store.feedId('test');
        assert.equal(Number(store.incoming(incoming(message(),'test'))),1);
        assert.equal(Number(store.incoming(incoming(message(),'test'))),0);
        store.incoming(incoming(message('other'),'second'));
        const first=store.listIncoming('test',0,1);assert.equal(first.length,1);assert.equal(first[0].provider_message_id,'in-1');
        assert.equal(first[0].raw,undefined);
        store.close();store=new MessageStore(file);assert.equal(store.feedId('test'),feed);
        assert.equal(store.listIncoming('test',first[0].seq,30).length,0);
    }finally{store.close();fs.rmSync(dir,{recursive:true});}
});

test('authenticated inbound feed, media retrieval, webhook replay and manual media send',async()=>{
    process.env.KD_API_KEY='test-inbox';const store=new MessageStore(':memory:');
    const pdf=Buffer.from('%PDF-1.4\nfixture\n%%EOF').toString('base64');let downloaded=0,sent=0;
    const app=express();app.use('/api/v1',createRouter({store,instance:'test',webhookSecret:'hook',evolution:{
        async downloadMedia(raw){downloaded++;assert.equal(JSON.parse(raw).key.id,'image');return{base64:pdf,mimetype:'application/pdf',fileName:'report.pdf'};},
        async sendMedia(){sent++;return{key:{id:'media-out'},status:'PENDING'};},
    }}));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/api/v1`;
    const call=(url,body,key='test-inbox')=>fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-api-key':key,'x-webhook-secret':key==='hook'?'hook':''},body:body?JSON.stringify(body):undefined});
    try{
        const event={instance:'test',event:'messages.upsert',data:message()};
        assert.equal((await call('/incoming',null,'wrong')).status,401);
        assert.equal((await call('/webhooks/evolution',event,'wrong')).status,401);
        assert.equal((await (await call('/webhooks/evolution',event,'hook')).json()).received,1);
        assert.equal((await (await call('/webhooks/evolution',event,'hook')).json()).received,0);
        const feed=await (await call('/incoming')).json();assert.equal(feed.messages.length,1);assert.ok(feed.feed_id.endsWith(':test'));
        assert.equal((await call('/incoming?after=-1')).status,400);
        const mediaEvent={...event,data:{...message('image'),message:{documentMessage:{mimetype:'application/pdf',fileName:'report.pdf'}}}};
        await call('/webhooks/evolution',mediaEvent,'hook');
        assert.equal((await call('/incoming/image/media',null,'wrong')).status,401);assert.equal(downloaded,0);
        const media=await (await call('/incoming/image/media')).json();assert.equal(media.base64,pdf);assert.equal(downloaded,1);
        assert.equal((await call('/messages/media',{number:'51918592638',base64:pdf,mimetype:'application/pdf',fileName:'a.pdf',caption:'Prueba'})).status,202);
        assert.equal(sent,1);
        assert.equal((await call('/messages/media',{number:'51918592638',base64:pdf,mimetype:'text/html',fileName:'a.html'})).status,400);assert.equal(sent,1);
    }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
