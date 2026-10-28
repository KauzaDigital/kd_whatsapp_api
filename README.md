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


## Enviar documentos PDF

`POST /api/v1/messages/document` requiere `x-api-key: KD_API_KEY` y JSON:

```json
{
  "number": "51999999999",
  "fileName": "acta.pdf",
  "caption": "Adjuntamos su acta de conformidad.",
  "base64": "CONTENIDO_DEL_PDF_EN_BASE64"
}
```

`number`, `fileName` y `base64` son obligatorios. `caption` es opcional, de hasta
1024 caracteres. Solo se aceptan PDF de hasta 10 MiB (10 485 760 bytes), con nombre
terminado en `.pdf`, de hasta 200 caracteres, sin rutas ni caracteres de control.
Base64 debe usar el formato estándar con padding; también se admite el prefijo
`data:application/pdf;base64,`. Se comprueban codificación, tamaño y cabecera
`%PDF-`; esta comprobación no sustituye un análisis completo del documento.
No se reciben rutas locales, URLs ni multipart. Envíe los bytes del archivo.

La ruta admite JSON de hasta 14 MiB para el incremento de tamaño de base64,
autenticando antes de procesarlo. El resto de las rutas mantiene el límite de
100 KiB. Si usa un proxy, ajuste su límite de cuerpo para permitir esta ruta.

Ejemplo en PowerShell (reemplace número y ruta; use un destinatario autorizado):

```powershell
$headers = @{ 'x-api-key' = Read-Host 'Ingresa tu KD_API_KEY' }
$archivo = 'C:\Documentos\acta.pdf'
$body = @{
    number = '51999999999'
    fileName = [IO.Path]::GetFileName($archivo)
    caption = 'Adjuntamos su acta de conformidad.'
    base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archivo))
} | ConvertTo-Json -Compress

$resultado = Invoke-RestMethod -Method Post `
    -Uri 'http://localhost:3000/api/v1/messages/document' `
    -Headers $headers -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body))
$resultado
```

Un HTTP 202 incluye `provider_message_id`, `status`, `delivered` y `read`, igual
que el envío de texto. Consulte `GET /api/v1/messages/IDENTIFICADOR` con la misma
clave para seguir las confirmaciones. Un 202 no demuestra entrega.
400 indica campos o contenido inválidos; 413 indica exceso de tamaño; 401 indica
fallo de autenticación. Un 502 indica un resultado sin confirmar o sin ID:
no reintente automáticamente, porque Evolution podría haber aceptado el PDF.
El envío a Evolution usa `/message/sendMedia/{instance}`, `mediatype=document`,
`mimetype=application/pdf`, `media`, `fileName` y `caption`, con timeout de 60 s.
La API no guarda el PDF en disco ni en SQLite; el proveedor procesa el documento.
Esta ruta no agrega automáticamente adjuntos a las notificaciones de Odoo.

Reinicie Node después de actualizar. Si utiliza el servicio API de Compose,
reconstrúyalo con `docker compose up -d --build api`. No inicie a la vez Node en
Windows y el contenedor API sobre el mismo puerto 3000.

## Bandeja de recepción para Odoo

El webhook autenticado admite `MESSAGES_UPSERT` de mensajes entrantes personales y mantiene los eventos `MESSAGES_UPDATE` de confirmaciones. Se excluyen mensajes propios, grupos e históricos de tipo `append`. La bandeja SQLite deduplica por instancia e ID del proveedor y conserva los mensajes para lectura paginada. Proteja y respalde el archivo SQLite: contiene conversaciones y metadatos del proveedor.

- `GET /api/v1/incoming?after=0&limit=30`: requiere `x-api-key`; devuelve `feed_id`, `instance`, `messages`, `cursor`. Cada mensaje incluye `seq`, `provider_message_id`, `number`, `text`, `quoted_id`, `media_type`, `sent_at`. El consumidor guarda el cursor únicamente después de persistir los mensajes; al cambiar `feed_id`, reinicia la lectura. No expone el mensaje crudo del proveedor.
- `GET /api/v1/incoming/:id/media`: requiere `x-api-key`; recupera por el ID guardado y descarga a través del Evolution configurado. Devuelve `base64`, `mimetype`, `fileName` para PDF/JPG/PNG/WEBP de hasta 10 MiB. No admite descargas arbitrarias por URL ni formatos de visualización única.
- `POST /api/v1/messages/media`: requiere `x-api-key`; recibe `number`, `base64`, `mimetype`, `fileName`, `caption`. Usa el seguimiento habitual de confirmaciones. Un envío aceptado no implica entrega o lectura.

Después de actualizar Node, ejecute `node configure-webhook.cjs .` o **Crear/configurar instancia** desde Odoo para añadir ambos eventos. Conserva los demás eventos existentes y rechaza reemplazar otro webhook activo con URL diferente. `/health` anuncia las capacidades `branch-inbox` y `chat-media` para comprobar el código en ejecución.
