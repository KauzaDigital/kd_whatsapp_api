# Instalación en Linux (Ubuntu 24.04 LTS)

El Compose incluye la API Node 24, Evolution API, PostgreSQL 15 y Redis 7. No necesita instalar Node, PostgreSQL ni Redis en el host. Use un servidor con Docker y conexión saliente a Internet. Como punto de partida práctico, reserve 2 CPU y 4 GB RAM; ajuste según carga. Estos valores son una orientación, no un mínimo garantizado.

## 1. Instalar Docker en un Ubuntu nuevo

Conéctese por SSH. Ejecute estos comandos en el servidor (no en PowerShell):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

Si ya administra Docker en ese servidor, conserve su instalación existente. Referencia: https://docs.docker.com/engine/install/ubuntu/

## 2. Subir el proyecto

En PowerShell de su PC, sustituya USUARIO y SERVIDOR:

```powershell
tar --exclude=node_modules --exclude=.env --exclude=.git --exclude='*.sqlite*' -czf "$env:USERPROFILE\kd-whatsapp-api.tar.gz" -C 'C:\Program Files\Odoo 19.0.20260425\server\kd_whatsapp_api' .
scp "$env:USERPROFILE\kd-whatsapp-api.tar.gz" USUARIO@SERVIDOR:~/
```

En Linux:

```bash
mkdir -p ~/kd_whatsapp_api
tar -xzf ~/kd-whatsapp-api.tar.gz -C ~/kd_whatsapp_api
cd ~/kd_whatsapp_api
umask 077
if [ ! -e .env ]; then
 {
  printf 'KD_API_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'KD_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'EVOLUTION_API_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'EVOLUTION_INSTANCE=kd_whatsapp_local\n'
 } > .env
fi
chmod 600 .env
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=60 evolution
curl --fail http://127.0.0.1:3000/health
```

IMPORTANTE: genere .env solo en una instalación nueva. Si ya existe, NO vuelva a ejecutar el bloque de generación; conserve especialmente POSTGRES_PASSWORD para que coincida con la base persistente. Espere a que Evolution termine sus migraciones antes del siguiente paso. Los servicios se reinician automáticamente al arrancar Docker.

## 3. Crear instancia, generar QR y conectar

Desde la carpeta del proyecto en Linux:

```bash
set -a
. ./.env
set +a
curl --fail-with-body -X POST http://127.0.0.1:3000/api/v1/whatsapp/instance -H "x-api-key: $KD_API_KEY"
curl --fail-with-body http://127.0.0.1:3000/api/v1/whatsapp/qr -H "x-api-key: $KD_API_KEY" -o qr.json
python3 - <<'PY'
import json, base64
from pathlib import Path
data = json.loads(Path('qr.json').read_text())
if data.get('qr'):
    Path('qr.png').write_bytes(base64.b64decode(data['qr'].split(',')[-1]))
    print('QR guardado en qr.png')
else:
    print('Conexión:', data.get('state'), '- Si está conectando, repita la consulta en unos segundos.')
PY
```

Descargue qr.png con WinSCP o, desde PowerShell:

```powershell
scp USUARIO@SERVIDOR:~/kd_whatsapp_api/qr.png "$env:USERPROFILE\Downloads\whatsapp-qr.png"
```

Abra la imagen y escanéela desde el teléfono emisor: WhatsApp > Dispositivos vinculados > Vincular dispositivo. El QR caduca: repita la consulta si es necesario. No comparta la imagen ni la API key.

Compruebe desde Linux:

```bash
curl --fail-with-body http://127.0.0.1:3000/api/v1/whatsapp/connection -H "x-api-key: $KD_API_KEY"
```

connected=true y state=open indican conexión activa. La creación configura también el webhook interno http://api:3000/api/v1/webhooks/evolution. Para los estados de entrega consulte README.md.

## 4. Acceso desde Odoo

Si Odoo corre directamente en el mismo servidor, use http://127.0.0.1:3000 y el header x-api-key. Si corre en otro contenedor, localhost apunta a ese contenedor: configure una red Docker compartida y acceso por nombre de servicio, o use un proxy HTTPS accesible por Odoo.

Para Odoo remoto, publique la API mediante un proxy con HTTPS. Evolution, PostgreSQL y Redis no publican puertos del host. Ejemplo con Nginx en el host y un dominio que apunte a la IP del servidor:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/kd-whatsapp
```

Contenido (sustituya api.sudominio.com):

```nginx
server {
    listen 80;
    server_name api.sudominio.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 40s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/kd-whatsapp /etc/nginx/sites-enabled/kd-whatsapp
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.sudominio.com
```

Permita TCP 80/443 en el firewall del proveedor y del host, conservando SSH. Use https://api.sudominio.com en Odoo. El puerto 3000 permanece accesible solo desde el servidor. No exponga la clave de API en JavaScript público.

## Datos, copias y migración

Los volúmenes messages, instances, postgres_data y redis_data conservan los datos entre reinicios. No use docker compose down -v salvo que quiera eliminar todos esos datos.

Para una copia consistente, detenga los servicios con sudo docker compose stop, respalde .env y TODOS los volúmenes con su herramienta de backup Docker, y arranque con sudo docker compose start. Pruebe una restauración antes de depender del respaldo.

La instalación nueva NO mueve automáticamente la sesión WhatsApp ni los estados de Windows. Puede vincular el servidor nuevamente por QR, o planificar una migración de los volúmenes Evolution/PostgreSQL y de messages.sqlite con ambos servicios detenidos. No ejecute dos servidores con la misma sesión copiada.

## Actualizar

Respalde primero. Suba el código nuevo, revise la versión de Evolution y ejecute sudo docker compose up -d --build. Cambiar versiones de Evolution puede modificar su base de datos: pruebe la actualización antes de aplicarla a producción.
