require("dotenv").config();

const express = require("express");
const createRouter = require("./routes/kd_whatsapp.routes");
const path = require('node:path');
const os = require('node:os');
const { MessageStore } = require('./services/kd_message_store');
const evolution = require('./services/kd_evolution.service');
const store = new MessageStore(process.env.KD_MESSAGES_DB || path.join(os.homedir(), '.kd_whatsapp_api', 'messages.sqlite'));

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "KD WhatsApp API",
        author: "Kauza Digital",
        version: "1.0.0"
    });
});

app.use("/api/v1", createRouter({ store, evolution,
    instance: process.env.EVOLUTION_INSTANCE,
    webhookSecret: process.env.KD_WEBHOOK_SECRET }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400) {
        return res.status(400).json({
            success: false,
            error: "JSON inválido"
        });
    }
    console.error(err);
    res.status(500).json({
        success: false,
        error: "Error interno"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`KD WhatsApp API en puerto ${PORT}`);
});
