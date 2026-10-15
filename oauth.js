// oauth.js — Flujo OAuth2 con portal HTML en localhost:3000
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const SCOPES = 'https://www.googleapis.com/auth/gmail.compose';
const TOKEN_FILE = path.join(__dirname, 'gmail_tokens.json');

function loadTokens() {
  try {
    const fileTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (fileTokens && fileTokens.refresh_token) return fileTokens;
  } catch {}
  if (process.env.GMAIL_REFRESH_TOKEN) {
    return {
      refresh_token: process.env.GMAIL_REFRESH_TOKEN.trim(),
      access_token: process.env.GMAIL_ACCESS_TOKEN ? process.env.GMAIL_ACCESS_TOKEN.trim() : null,
      expires_at: 0
    };
  }
  return null;
}
function saveTokens(t) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
    console.log('[OAuth] Tokens guardados en', TOKEN_FILE);
  } catch (err) {
    console.warn('[OAuth] Aviso al guardar tokens en disco (normal en entornos efímeros):', err.message);
  }
}

// Generar URL de autorización (la misma de siempre, sin cambios)
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Intercambiar code por tokens
async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code.trim(),
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    })
  });
  if (!res.ok) throw new Error('Token exchange ' + res.status + ': ' + await res.text());
  const data = await res.json();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000)
  };
  saveTokens(tokens);
  return tokens;
}

async function getValidAccessToken() {
  let t = loadTokens();
  if (!t || !t.refresh_token) throw new Error('No hay sesión de Gmail activa. Ejecuta el comando /auth en Telegram para vincular tu cuenta.');
  if (t.expires_at && Date.now() < t.expires_at - 60000) return t.access_token;
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
      try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      throw new Error('La sesión de Gmail expiró o fue revocada. Ejecuta el comando /auth en Telegram para volver a vincular tu cuenta.');
    }
    throw new Error('Refresh ' + res.status + ': ' + errText);
  }
  const data = await res.json();
  t.access_token = data.access_token;
  t.expires_at = Date.now() + (data.expires_in * 1000);
  saveTokens(t);
  return t.access_token;
}

function setupOAuthRoutes(app) {
  const authHelperPath = path.join(__dirname, 'auth_helper.html');
  let html = fs.existsSync(authHelperPath) ? fs.readFileSync(authHelperPath, 'utf8') : '';
  if (html) html = html.replace('__CLIENT_ID__', CLIENT_ID || '');

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()), service: 'TelegramCotizador' });
  });

  app.get('/', (req, res) => {
    res.type('html').send(html || '<h1>JP Solutions</h1><p>Bot de Cotizaciones Online 24/7</p>');
  });

  app.get('/status', (req, res) => {
    const tokens = loadTokens();
    res.json({ authorized: !!(tokens && tokens.refresh_token) });
  });

  app.get('/auth', (req, res) => {
    res.redirect(getAuthUrl());
  });

  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    if (error) {
      return res.status(400).type('html').send('<h1>Error: ' + error + '</h1><p>Vuelve a /auth e inténtalo de nuevo.</p>');
    }
    if (!code) {
      return res.status(400).send('No code');
    }
    try {
      await exchangeCode(code);
      res.type('html').send('<h1>✅ Autorizado</h1><p>Ya puedes cerrar esta pestaña y volver al chat de Telegram.</p>');
    } catch (e) {
      res.status(500).type('html').send('<h1>Error al intercambiar código</h1><pre>' + e.message + '</pre>');
    }
  });
}

// Servidor local de respaldo si no se usa Express
function startOAuthServer() {
  return new Promise((resolve) => {
    console.log('[OAuth] Servidor activo en las rutas de la app principal.');
    resolve(loadTokens());
  });
}

module.exports = { getAuthUrl, getValidAccessToken, startOAuthServer, exchangeCode, loadTokens, setupOAuthRoutes };

