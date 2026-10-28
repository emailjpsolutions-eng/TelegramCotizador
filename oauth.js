// oauth.js — Flujo OAuth2 con soporte Multi-Usuario y almacenamiento local
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Archivos de almacenamiento local
const TOKEN_FILE = path.join(__dirname, 'gmail_tokens.json'); // Legacy / global
const USER_TOKENS_FILE = path.join(__dirname, 'user_tokens.json'); // Multi-usuario indexado por chatId

// Memoria caché para tokens multi-usuario
let _userTokensCache = null;

function loadAllUserTokens() {
  if (_userTokensCache) return _userTokensCache;
  try {
    if (fs.existsSync(USER_TOKENS_FILE)) {
      _userTokensCache = JSON.parse(fs.readFileSync(USER_TOKENS_FILE, 'utf8'));
      return _userTokensCache;
    }
  } catch (err) {
    console.warn('[OAuth] Error leyendo user_tokens.json:', err.message);
  }
  _userTokensCache = {};
  return _userTokensCache;
}

function saveUserTokens(chatId, tokenData) {
  const all = loadAllUserTokens();
  all[String(chatId)] = {
    ...tokenData,
    updated_at: Date.now()
  };
  try {
    fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(all, null, 2));
    console.log(`[OAuth] Tokens actualizados para usuario ${chatId}`);
  } catch (err) {
    console.warn('[OAuth] Aviso al guardar user_tokens.json en disco:', err.message);
  }
}

// Carga tokens del usuario específico o fallback al token global
function loadUserToken(chatId) {
  if (chatId) {
    const all = loadAllUserTokens();
    const userTok = all[String(chatId)];
    if (userTok && userTok.refresh_token) {
      return userTok;
    }
  }

  // Fallback a gmail_tokens.json (legacy) o variables de entorno
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const fileTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (fileTokens && fileTokens.refresh_token) return fileTokens;
    }
  } catch {}

  if (process.env.GMAIL_REFRESH_TOKEN) {
    return {
      refresh_token: process.env.GMAIL_REFRESH_TOKEN.trim(),
      access_token: process.env.GMAIL_ACCESS_TOKEN ? process.env.GMAIL_ACCESS_TOKEN.trim() : null,
      expires_at: 0,
      isGlobalFallback: true
    };
  }

  return null;
}

// Obtener la URL de redirección dinámicamente según el entorno
function getRedirectUri(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/+$/, '') + '/oauth2callback';
  }
  if (req) {
    const host = req.get('host');
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    return `${proto}://${host}/oauth2callback`;
  }
  return 'http://localhost:3000/oauth2callback';
}

// Generar URL de autorización para un usuario específico (state = chatId)
function getAuthUrl(chatId, redirectUri) {
  const effectiveRedirect = redirectUri || 'http://localhost:3000/oauth2callback';
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: effectiveRedirect,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent'
  });
  if (chatId) {
    params.set('state', String(chatId));
  }
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Intercambiar code por tokens y obtener el correo de la cuenta de Google
async function exchangeCode(code, redirectUri, stateChatId) {
  const effectiveRedirect = redirectUri || 'http://localhost:3000/oauth2callback';
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code.trim(),
      grant_type: 'authorization_code',
      redirect_uri: effectiveRedirect
    })
  });

  if (!res.ok) throw new Error('Token exchange ' + res.status + ': ' + await res.text());
  const data = await res.json();

  let userEmail = null;
  let userName = null;
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    if (infoRes.ok) {
      const info = await infoRes.json();
      userEmail = info.email || null;
      userName = info.name || null;
    }
  } catch (e) {
    console.warn('[OAuth] No se pudo obtener el email del perfil:', e.message);
  }

  const tokens = {
    email: userEmail,
    name: userName,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000)
  };

  if (stateChatId) {
    saveUserTokens(stateChatId, tokens);
  }

  // Guardar también en archivo legacy si es el primer usuario o no hay token global
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (_) {}

  return tokens;
}

// Obtener token válido para un usuario de chat específico
async function getValidAccessToken(chatId) {
  let t = loadUserToken(chatId);
  if (!t || !t.refresh_token) {
    throw new Error('⚠️ Tu cuenta de Gmail no está vinculada.\n\nEscribe el comando /auth en este chat para vincular tu correo de Google.');
  }

  // Si el access token aún es válido (con margen de 60 segundos), reutilizarlo
  if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60000) {
    return { token: t.access_token, email: t.email, name: t.name };
  }

  // Renovar access token usando refresh token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes('invalid_grant') || res.status === 400) {
      if (chatId) {
        const all = loadAllUserTokens();
        delete all[String(chatId)];
        try { fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(all, null, 2)); } catch (_) {}
      }
      throw new Error('⚠️ La sesión de tu cuenta de Gmail expiró o fue revocada. Ejecuta el comando /auth en Telegram para volver a vincular tu cuenta.');
    }
    throw new Error('Refresh ' + res.status + ': ' + errText);
  }

  const data = await res.json();
  t.access_token = data.access_token;
  t.expires_at = Date.now() + (data.expires_in * 1000);

  if (chatId) {
    saveUserTokens(chatId, t);
  }

  return { token: t.access_token, email: t.email, name: t.name };
}

function setupOAuthRoutes(app, botInstance) {
  const authHelperPath = path.join(__dirname, 'auth_helper.html');
  let htmlTemplate = fs.existsSync(authHelperPath) ? fs.readFileSync(authHelperPath, 'utf8') : '';

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()), service: 'TelegramCotizador' });
  });

  app.get('/', (req, res) => {
    res.type('html').send('<h1>JP Solutions</h1><p>Bot de Cotizaciones Online 24/7 (Multi-Usuario)</p>');
  });

  app.get('/status', (req, res) => {
    const chatId = req.query.chatId;
    const tokens = loadUserToken(chatId);
    res.json({
      authorized: !!(tokens && tokens.refresh_token),
      email: tokens ? tokens.email : null
    });
  });

  app.get('/auth', (req, res) => {
    const chatId = req.query.chatId;
    const redirectUri = getRedirectUri(req);
    res.redirect(getAuthUrl(chatId, redirectUri));
  });

  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    const stateChatId = req.query.state;
    const redirectUri = getRedirectUri(req);

    if (error) {
      return res.status(400).type('html').send(`
        <div style="font-family: Arial; padding: 30px; text-align: center;">
          <h1 style="color: #ef4444;">❌ Error de Autorización</h1>
          <p>${error}</p>
          <p>Regresa a Telegram y vuelve a escribir <code>/auth</code>.</p>
        </div>
      `);
    }

    if (!code) {
      return res.status(400).send('No code');
    }

    try {
      const tokens = await exchangeCode(code, redirectUri, stateChatId);

      // Notificar proactivamente al usuario por Telegram si conocemos su chatId
      if (stateChatId && botInstance) {
        const emailMsg = tokens.email ? ` (*${tokens.email}*)` : '';
        botInstance.telegram.sendMessage(
          stateChatId,
          `✅ *¡Cuenta de Gmail vinculada con éxito!*${emailMsg}\n\nAhora cuando generes cotizaciones, los borradores se guardarán directamente en tu cuenta de correo.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      res.type('html').send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Autorización Exitosa — JP Solutions</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); text-align: center; max-width: 440px; }
            h1 { color: #22c55e; margin-bottom: 12px; }
            p { color: #94a3b8; font-size: 15px; line-height: 1.5; }
            .email { color: #60a5fa; font-weight: bold; background: #0f172a; padding: 6px 12px; border-radius: 6px; display: inline-block; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✅ ¡Cuenta Autorizada!</h1>
            ${tokens.email ? `<div class="email">${tokens.email}</div>` : ''}
            <p>Tu cuenta de Gmail ha quedado vinculada exitosamente al Bot Cotizador de JP Solutions.</p>
            <p>Ya puedes cerrar esta ventana y regresar a Telegram.</p>
          </div>
        </body>
        </html>
      `);
    } catch (e) {
      res.status(500).type('html').send(`
        <div style="font-family: Arial; padding: 30px; text-align: center;">
          <h1 style="color: #ef4444;">Error al intercambiar código</h1>
          <pre>${e.message}</pre>
        </div>
      `);
    }
  });
}

function startOAuthServer() {
  return Promise.resolve(loadUserToken());
}

module.exports = {
  getAuthUrl,
  getValidAccessToken,
  startOAuthServer,
  exchangeCode,
  loadUserToken,
  saveUserTokens,
  setupOAuthRoutes
};
