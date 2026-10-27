# Confirmaciones de WhatsApp

Requiere Node.js 22.13 o superior (SQLite integrado); probado con Node 24.

Los cambios están instalados en este módulo. El webhook se configura con:

```powershell
node configure-webhook.cjs "C:\Program Files\Odoo 19.0.20260425\server\kd_whatsapp_api"
```

Reinicie la API después de modificar .env.

## Uso

Todas las rutas de operación requieren el header x-api-key con KD_API_KEY.

| Método | Ruta | Uso |
|---|---|---|
| POST | /api/v1/whatsapp/instance | Crea la instancia si falta y configura confirmaciones |
| GET | /api/v1/whatsapp/qr | Obtiene QR base64 (campo qr) para vincular |
| GET | /api/v1/whatsapp/connection | Consulta state y connected |

El QR no se guarda y se devuelve con Cache-Control: no-store. Si ya está conectado, qr es null y connected=true; no se cierra la sesión. Si aún no hay QR disponible, responde HTTP 202: vuelva a consultar en unos segundos. No exponga KD_API_KEY ni EVOLUTION_API_KEY en una página pública. La respuesta solo incluye campos de conexión y QR, nunca credenciales del proveedor.

Guía completa para instalar API + Evolution + PostgreSQL + Redis en Ubuntu: [LINUX.md](LINUX.md).

POST /api/v1/messages/text sigue recibiendo number y message con x-api-key. Devuelve provider_message_id, status, delivered y read. Un HTTP 202 solo representa aceptación del envío; delivered=true indica evidencia de entrega.

GET /api/v1/messages/IDENTIFICADOR con x-api-key consulta el estado persistido. Un mensaje desconocido responde 404. Los estados son accepted, PENDING, SERVER_ACK, DELIVERY_ACK, READ, PLAYED y ERROR. ERROR representa un fallo informado por Evolution; un timeout de envío no demuestra que el mensaje haya fallado y no debe reintentarse automáticamente.

POST /api/v1/webhooks/evolution exige x-webhook-secret y la instancia configurada. Acepta MESSAGES_UPDATE/messages.update, datos individuales o listas, estados de texto o numéricos. Usa keyId (ID WhatsApp), nunca messageId interno. Ignora mensajes entrantes y evita retrocesos de estado. Una confirmación recibida antes de la respuesta del envío también queda registrada.

SQLite se guarda por defecto en la carpeta .kd_whatsapp_api del usuario que ejecuta Node. Configure KD_MESSAGES_DB con una ruta absoluta y escribible si usa un servicio u otro usuario. Respalde esa base y sus archivos WAL/SHM con el proceso detenido. Para contenedores, configure una ruta en un volumen persistente. No se guarda el contenido del mensaje.

Los mensajes anteriores a activar el webhook no se importan automáticamente. Sin confirmación el estado permanece pendiente/aceptado; no se convierte en ERROR por tiempo transcurrido. READ puede no llegar si no se informa la lectura. Los envíos rechazados antes de obtener ID devuelven error HTTP y no tienen registro consultable.

## Pruebas

```powershell
npm test
```

Las pruebas usan un proveedor simulado y no envían mensajes reales.
