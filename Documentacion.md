# Documentación de Despliegue - Bot Telegram Cotizador JP Solutions

## 📋 Resumen del Proyecto

Bot de Telegram para generar cotizaciones profesionales con:
- Generación de PDF idéntico al cotizador web
- Envío de borradores a Gmail (API Gmail)
- Transcripción de notas de voz (Groq Whisper)
- Procesamiento de lenguaje natural (Groq LLM)
- OAuth2 persistente con refresh token

---

## 📁 Estructura de Archivos

```
TelegramCotizador/
├── bot.js                 # Bot principal (lógica completa)
├── pdfEngine.js           # Generación PDF idéntico a web
├── oauth.js               # Flujo OAuth Gmail (servidor local + tokens)
├── package.json           # Dependencias y metadatos
├── package-lock.json      # Lock de versiones exactas
├── .env                   # Variables de entorno (NO commitear)
├── auth_helper.html       # Portal HTML para autorización OAuth
└── assets/
    └── pdfAssets.js       # Base64 de fuente Arial + logo circular PNG
```

---

## ⚙️ Variables de Entorno (.env)

```bash
# Obligatorias
BOT_TOKEN=8288038263:AAFiL72xX-YVQMS6EfhRA8XBOn1yEMHzFSA
GROQ_API_KEY=gsk_...
GOOGLE_CLIENT_ID=749173451248-37a47jm3vm64vgl6u6al8pjd00063p1k.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=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

# Opcionales (tienen defaults en código)
JP_EMAIL=email.jpsolutions@gmail.com
# JP_TEL=+58-xxx-xxxxxxx
```

> **⚠️ IMPORTANTE**: El archivo `.env` NO debe commitearse al repositorio. Copiar manualmente al servidor.

---

## 📦 Dependencias (package.json)

```json
{
  "name": "jp-cotizador-bot",
  "version": "1.0.0",
  "description": "Bot Telegram para cotizaciones JP Solutions",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js",
    "dev": "node bot.js"
  },
  "dependencies": {
    "telegraf": "^4.16.3",
    "openai": "^4.52.7",
    "jspdf": "^2.5.2",
    "dotenv": "^16.4.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## 🔧 Configuración Google Cloud Console

### 1. Cliente OAuth 2.0
```
Tipo: Aplicación web
Client ID: 749173451248-37a47jm3vm64vgl6u6al8pjd00063p1k.apps.googleusercontent.com
Client Secret: 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
```

### 2. URIs de redirección autorizados (OBLIGATORIOS)
```
http://localhost:3000/oauth2callback
http://TU_DOMINIO_O_IP:3000/oauth2callback
```

### 3. Pantalla de consentimiento OAuth
- Tipo: Externa
- Scopes: `https://www.googleapis.com/auth/gmail.compose`
- Usuarios de prueba: `email.jpsolutions@gmail.com`

---

## 🚀 Despliegue en Servidor (Linux/Ubuntu)

### 1. Preparar servidor
```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar versiones
node --version  # v18.x.x
npm --version   # 9.x.x

# Instalar PM2 globalmente
sudo npm install -g pm2
```

### 2. Desplegar aplicación
```bash
# Clonar o copiar proyecto
cd /opt
sudo mkdir -p TelegramCotizador
sudo chown $USER:$USER TelegramCotizador
cd TelegramCotizador

# Copiar archivos (desde tu máquina local)
# scp -r TelegramCotizador/ usuario@servidor:/opt/

# O clonar desde git si tienes repo privado
# git clone <repo-privado> .

# Instalar dependencias exactas
npm ci
```

### 3. Configurar variables de entorno
```bash
# Crear .env en /opt/TelegramCotizador/
cat > .env << 'EOF'
BOT_TOKEN=8710333497:AAGyBPJ0p8WMYirR19KMqTtxeiDLU9bP3FQ
GROQ_API_KEY=gsk_...
GOOGLE_CLIENT_ID=749173451248-37a47jm3vm64vgl6u6al8pjd00063p1k.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=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
JP_EMAIL=email.jpsolutions@gmail.com
JP_TEL=0414-3325600
EOF

# Verificar
cat .env
```

### 4. Configurar Google Cloud para producción
En **Google Cloud Console → APIs y servicios → Pantalla de consentimiento OAuth → URIs de redirección autorizados**:

```
# Desarrollo
http://localhost:3000/oauth2callback

# Producción (AGREGAR ESTAS)
http://TU_DOMINIO_O_IP:3000/oauth2callback
https://TU_DOMINIO:3000/oauth2callback
```

### 5. Ejecutar con PM2 (Producción)
```bash
# Iniciar con PM2
pm2 start bot.js --name "jp-cotizador-bot" --time

# Guardar configuración PM2
pm2 save
pm2 startup

# Verificar estado
pm2 list
pm2 logs jp-cotizador-bot
```

### 6. Configurar Nginx Reverse Proxy (Recomendado)
```nginx
# /etc/nginx/sites-available/jp-cotizador
server {
    listen 80;
    server_name TU_DOMINIO.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# Habilitar sitio
sudo ln -s /etc/nginx/sites-available/jp-cotizador /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7. SSL con Let's Encrypt
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d TU_DOMINIO.com
```

---

## 🔐 Consideraciones de Red (CRÍTICO)

### VPN Obligatoria en Venezuela
- **Telegram API**: `api.telegram.org` - Bloqueado en VE
- **Groq API**: `api.groq.com` - Bloqueado en VE (403 Forbidden)
- **Google OAuth**: `accounts.google.com` - Funciona, pero mejor con VPN

### Configuración VPN en Servidor
```bash
# Opción A: OpenVPN / WireGuard en servidor
# Opción B: Proxy SOCKS5 + proxychains
# Opción C: VPN comercial con "Full Tunnel" / "Kill Switch"

# Verificar conectividad
curl -s https://ipinfo.io  # Debe mostrar IP fuera de Venezuela
curl -s https://api.telegram.org/bot<TOKEN>/getMe  # Debe responder JSON
curl -s -H "Authorization: Bearer <GROQ_KEY>" https://api.groq.com/openai/v1/models  # Debe responder JSON
```

---

## 📊 Monitoreo y Logs

```bash
# Ver logs en tiempo real
pm2 logs jp-cotizador-bot --lines 100

# Ver métricas
pm2 monit

# Reiniciar bot
pm2 restart jp-cotizador-bot

# Ver estado
pm2 status
```

---

## 🔄 Actualizaciones

```bash
cd /opt/TelegramCotizador

# Actualizar código (git pull o copiar archivos)
# git pull origin main

# Reinstalar dependencias si cambió package.json
npm ci

# Reiniciar con PM2
pm2 restart jp-cotizador-bot
```

---

## 🆘 Troubleshooting Común

| Error | Causa | Solución |
|-------|-------|----------|
| `ENOTFOUND api.telegram.org` | Sin VPN / DNS bloqueado | Activar VPN en servidor |
| `403 Forbidden Groq` | IP venezolana detectada | VPN con IP fuera de VE |
| `403 Forbidden Google OAuth` | URI no autorizada | Agregar URI en Google Cloud |
| `Invalid To header` Gmail | Email cliente inválido | Validar email antes de enviar |
| `EADDRINUSE :3000` | Puerto ocupado | `lsof -i :3000` → matar proceso |
| `TimeoutError 90000ms` | Handler bloqueado | No usar `await` en handlers largos |

---

## 📂 Archivos Generados en Runtime

```
/opt/TelegramCotizador/
├── gmail_tokens.json          # Refresh/access tokens Gmail (auto-generado)
├── voice_<chatId>_<timestamp>.ogg  # Temporales de voz (auto-limpiados)
└── logs/                      # Si configuras logging a archivo
```

---

## 📞 Contacto y Soporte

- **Empresa**: JP Solutions
- **Email**: email.jpsolutions@gmail.com
- **Tel**: 0414-3325600
- **Web**: https://www.jpsolutions.online

---

## 📝 Changelog

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0.0 | 2026-07-23 | Versión inicial completa: PDF, Gmail OAuth, Voz, LLM |

---

**Última actualización**: 2026-07-23  
**Versión documento**: 1.0  
**Autor**: JP Solutions Team