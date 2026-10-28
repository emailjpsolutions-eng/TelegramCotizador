// Bot Cotizador JP Solutions - Telegram (versión simplificada)
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { jsPDF } = require('jspdf');
const { buildPdf, fmt } = require('./pdfEngine');
const oauth = require('./oauth');

// Configuración del token del bot (fallback al token hardcodeado)
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
if (!BOT_TOKEN) {
  console.error('❌ Falta BOT_TOKEN');
  process.exit(1);
}
console.log(`🔑 Token cargado (Longitud: ${BOT_TOKEN.length}, Inicio: ${BOT_TOKEN.slice(0, 12)}..., Final: ...${BOT_TOKEN.slice(-5)})`);

// Configuración de opciones de Telegram (Soporte para Proxy y servidor alternativo)
const telegramOptions = { timeout: 120000 };

if (process.env.TELEGRAM_API_ROOT) {
  telegramOptions.apiRoot = process.env.TELEGRAM_API_ROOT;
  console.log(`🌐 Usando API Root personalizada para Telegram: ${process.env.TELEGRAM_API_ROOT}`);
}

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    telegramOptions.agent = new HttpsProxyAgent(proxyUrl);
    console.log(`🔒 Usando Proxy HTTPS para Telegram: ${proxyUrl}`);
  } catch (e) {
    console.log('💡 Si deseas usar HTTPS_PROXY en .env, instala la librería: npm i https-proxy-agent');
  }
}

// Instancia de Telegraf con timeout de handler de 24 horas para evitar cancelaciones prematuras
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 86400000, telegram: telegramOptions });

// Servidor Web para Render (Health Check) y OAuth2
const express = require('express');
const webApp = express();
oauth.setupOAuthRoutes(webApp, bot);
const PORT = process.env.PORT || 3000;
webApp.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor Web de salud y OAuth activo en puerto ${PORT}`);
});

// Manejo global de errores en Telegraf
bot.catch((err, ctx) => {
  console.error(`❌ Error en Telegraf (Update ${ctx?.update?.update_id}):`, err);
  if (ctx && ctx.reply) {
    ctx.reply('⚠️ Ocurrió un error inesperado al procesar la solicitud. Por favor intenta de nuevo.').catch(() => {});
  }
});

// --- Helpers -----------------------------------------------------------------
function getState(chatId) {
  if (!global._states) global._states = new Map();
  if (!global._states.has(chatId)) global._states.set(chatId, { step: 'start', data: {} });
  return global._states.get(chatId);
}
function resetState(chatId) { getState(chatId).step = 'start'; getState(chatId).data = {}; }

// Función para actualizar el estado del chat acumulando solo datos válidos o reiniciando si es nueva cotización
function mergeStateData(chatId, parsedData) {
  const state = getState(chatId);

  // Reiniciar estado si se detecta inicio de nueva cotización
  if (parsedData.isNewQuote) {
    state.data = {};
  }

  for (const [key, val] of Object.entries(parsedData)) {
    if (key === 'isNewQuote' || key === 'montoGlobal' || key === 'replaceServices' || key === 'servicioDescripcion') continue;
    if (val !== null && val !== undefined) {
      if (key === 'servicios') {
        if (Array.isArray(val) && val.length > 0) {
          // Si el usuario solicitó explícitamente cambiar o reemplazar el servicio, vaciar servicios anteriores
          if (!state.data.servicios || parsedData.replaceServices) {
            state.data.servicios = [];
          }
          val.forEach(newS => {
            const existing = state.data.servicios.find(s => s.id === newS.id || (s.nombre && newS.nombre && s.nombre.toLowerCase() === newS.nombre.toLowerCase()));
            if (existing) {
              if (newS.cantidad !== undefined && newS.cantidad !== null) existing.cantidad = newS.cantidad;
              if (newS.precio !== undefined && newS.precio !== null) existing.precio = newS.precio;
              if (newS.nombre) existing.nombre = newS.nombre;
              if (newS.descripcion) existing.descripcion = newS.descripcion;
              if (newS.isCustom) existing.isCustom = true;
            } else {
              state.data.servicios.push({ ...newS });
            }
          });
        }
      } else {
        state.data[key] = val;
      }
    }
  }

  // Manejar asignación o cambio de descripción si se especificó
  if (parsedData.servicioDescripcion) {
    if (state.data.servicios && state.data.servicios.length > 0) {
      state.data.servicios[state.data.servicios.length - 1].descripcion = parsedData.servicioDescripcion;
    }
  }

  // Manejar asignación o cambio de monto si se especificó
  if (parsedData.montoGlobal !== null && parsedData.montoGlobal !== undefined) {
    if (state.data.servicios && state.data.servicios.length > 0) {
      // Prioridad 1: Asignar al servicio que tenga precio pendiente (null o <= 0)
      const pendingService = state.data.servicios.find(s => s.precio === null || s.precio === undefined || s.precio <= 0);
      if (pendingService) {
        pendingService.precio = parsedData.montoGlobal;
      } else if (!parsedData.servicios || parsedData.servicios.length === 0 || state.data.servicios.length === 1 || parsedData.replaceServices) {
        // Prioridad 2: Si no hay servicios pendientes y es cambio general de monto, asignar al último o único servicio
        state.data.servicios[state.data.servicios.length - 1].precio = parsedData.montoGlobal;
      }
    } else {
      state.data.servicios = [{ id: 'md', nombre: 'Servicio Personalizado', cantidad: 1, precio: parsedData.montoGlobal, isCustom: true, descripcion: parsedData.servicioDescripcion || 'Servicio de desarrollo / consultoría TI' }];
    }
  }

  return state.data;
}

function normalizeAccents(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, 'n');
}

// Normalizador fonético para convertir correos hablados (arroba, punto) a formato limpio
function cleanSpokenText(text) {
  if (!text) return '';
  let cleaned = text
    .replace(/\s*(?:arroba|aroba|\bat\b)\s*/gi, '@')
    .replace(/@\s*jmail/gi, '@gmail')
    .replace(/@\s*g\s*mail/gi, '@gmail')
    .replace(/\s*(?:punto|\bdot\b)\s*/gi, '.')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.');

  // Si Deepgram unió palabra con dominio sin arroba (ej. "Ana Maríagmail.com" o "Ana María gmail.com")
  cleaned = cleaned.replace(/([A-Za-zÁÉÍÓÚáéíóúñÑ0-9._%+-]+)\s*(?:@|\s+)?(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com)/gi, '$1@$2');
  return cleaned;
}

// Extracción inteligente de email (maneja nombres de usuario hablados con espacios y adjuntos al texto)
function extractEmail(text) {
  if (!text) return null;
  const cleaned = cleanSpokenText(text);

  let email = null;
  // 1. Coincidencia con frase hablada previa (ej. "el correo es Ana María@gmail.com")
  const phraseMatch = cleaned.match(/(?:correo|email|mail)(?:\s+es|\s*:)?\s*([a-záéíóúñ0-9._%+-]+(?:[\s._-][a-záéíóúñ0-9._%+-]+)*)@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (phraseMatch) {
    const rawUser = phraseMatch[1].replace(/\s+/g, '');
    const userPart = normalizeAccents(rawUser).toLowerCase();
    const domainPart = phraseMatch[2].toLowerCase();
    email = `${userPart}@${domainPart}`;
  }

  // 2. Coincidencia directa con email estándar
  if (!email) {
    const direct = cleaned.match(/([a-záéíóúñ0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})/i);
    if (direct) {
      email = `${normalizeAccents(direct[1]).replace(/\s+/g, '').toLowerCase()}@${direct[2].toLowerCase()}`;
    }
  }

  // 3. Fallback para dominios conocidos
  if (!email) {
    const domainMatch = cleaned.match(/([a-záéíóúñ0-9._%+-]+)(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com)/i);
    if (domainMatch) {
      email = `${normalizeAccents(domainMatch[1]).replace(/\s+/g, '').toLowerCase()}@${domainMatch[2].toLowerCase()}`;
    }
  }

  if (email) {
    // Si la transcripción unió la frase siguiente sin espacio (ej. "@gmail.com.Vamos")
    email = email.replace(/\.(com|net|org|co|ve|es|io|ai|info|online)\.[a-z0-9]+$/i, '.$1');
    return email.replace(/\.$/, '').toLowerCase();
  }

  return null;
}

// Extractor inteligente de montos y precios modificados o asignados
function extractPriceUpdates(text) {
  if (!text) return null;
  let textClean = text.replace(/04\d{2}[-\s]?\d{7}/g, ''); // evitar teléfonos venezolanos
  textClean = textClean.replace(/tel[^\d]*[\d\s()-]+/gi, ''); // evitar teléfonos con prefijo tel
  textClean = textClean.replace(/\d+\s*(?:%|por\s+ciento|por\s+100)/gi, ''); // evitar descuentos
  textClean = textClean.replace(/descuento[:\s]*[\d,.]+%?/gi, '');

  const explicitMatches = [
    // "cambia el monto de la landing page a $150", "cambia el precio a 150", "modifica el costo a 200"
    /(?:cambia(?:r|lo|la)?|c[aá]mbia(?:r|lo|la)?|modifica(?:r|lo|la)?|modif[ií]ca(?:r|lo|la)?|ajusta(?:r|lo|la)?|aj[uú]sta(?:r|lo|la)?|pon(?:er|le|lo|la)?|asigna(?:r|le|lo|la)?|deja(?:r|le|lo|la)?|d[eé]ja(?:r|le|lo|la)?|coloca(?:r|le|lo|la)?)\s+(?:el\s+)?(?:monto|precio|costo|valor)?(?:\s+de\s+[a-záéíóúñ\s]+)?\s+(?:a|en|por)\s+[:\s]*\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "ponle 150 a la landing", "ponle 150"
    /(?:pon(?:er|le|lo|la)?|asigna(?:r|le|lo|la)?)\s+\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "el monto es de $150", "el precio es 150"
    /(?:el\s+)?(?:monto|precio|costo|valor)\s+(?:es(?:\s+de)?|en|a|de)\s+[:\s]*\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "monto: 150", "precio: $150", "monto 150"
    /(?:monto|precio|costo)\s*[:=\s]\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "déjalo en 150", "ponlo en $150"
    /(?:d[eé]jalo|dejalo|ponlo|d[eé]jala|dejala|ponla)\s+en\s+\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "a $150", "en $150", "por $150"
    /(?:por|a|en)\s+\$\s*(\d+(?:[.,]\d+)?)/i,
    // "$150" (con símbolo de dólar explícito)
    /\$\s*(\d+(?:[.,]\d+)?)/i,
    // "150 usd", "150 dólares", "150 dolares"
    /(\d+(?:[.,]\d+)?)\s*(?:usd|d[oó]lares|dolares)/i
  ];

  for (const regex of explicitMatches) {
    const m = textClean.match(regex);
    if (m) {
      const valStr = m[1].replace(',', '.');
      const num = parseFloat(valStr);
      if (!isNaN(num) && num > 0 && num < 100000) {
        return num;
      }
    }
  }
  return null;
}

// Extractor inteligente de descripción de servicio
function extractServiceDescription(text) {
  if (!text) return null;
  // 1. Explícito: "descripción: ...", "detalle: ...", "cambiar la descripción a: ..."
  const explicit = text.match(/(?:cambiar\s+(?:la\s+)?descripci[oó]n\s+(?:a|por|en|:)?|(?:la\s+)?descripci[oó]n\s*[:=]|detalle\s*[:=])\s*([^;\n]+)/i);
  if (explicit) {
    let d = explicit[1].trim().replace(/^[:\s-]+/, '').trim();
    d = d.replace(/\s*(?:;\s*)?(?:monto|precio|costo|\$)\s*[:=\s]?\s*\$?\d+.*$/i, '').trim();
    return d.replace(/[,;.]$/, '').trim();
  }

  // 2. Lenguaje natural con "para": "quieren un CRM para registrar sus clientes"
  const paraMatch = text.match(/(?:quieren|necesitan|requieren|solicitan|servicio\s+de|servicio:)?\s*(?:un|una|el|la)?\s*([A-Za-z0-9\s]{2,20}?)\s+para\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s,.-]+?)(?=\s+(?:al|el)\s+señor\b|\s+cliente\b|\s+empresa\b|\s+correo\b|\s+email\b|\s+tel\b|\s+monto\b|\s+precio\b|\s+\$|[;.\n]|$)/i);
  if (paraMatch && paraMatch[2]) {
    const purpose = paraMatch[2].trim().replace(/[,;.]$/, '').trim();
    if (!/^(?:el\s+señor|la\s+señora|sr\.?|sra\.?|don|doña|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$)/.test(purpose) && purpose.length >= 4) {
      return purpose.charAt(0).toUpperCase() + purpose.slice(1);
    }
  }

  return null;
}

// Extractor de servicios personalizados fuera del catálogo estándar
function extractCustomServices(text, detectedPrice, detectedDesc) {
  const custom = [];
  const delim = `(?=\\s+para\\s+el\\b|\\s+para\\s+la\\b|\\s+para\\b|\\s+al\\s+señor\\b|\\s+a\\s+la\\s+señora\\b|\\s+al\\s+sr\\.?|\\s+a\\s+la\\s+sra\\.?|\\s+cliente\\b|\\s+empresa\\b|\\s+correo\\b|\\s+email\\b|\\s+tel[eé]fono\\b|\\s+tel\\b|\\s+descuento\\b|\\s+notas\\b|\\s+monto\\b|\\s+precio\\b|\\s+costo\\b|\\s+valor\\b|\\s+descripci[oó]n\\b|\\s+detalle\\b|\\s+por\\s+\\$|\\s+en\\s+\\$|\\s+a\\s+\\$|\\s+\\$\\d|[;,\\.\n]|$)`;

  const activities = 'generaci[oó]n|captaci[oó]n|prospecci[oó]n|marketing|diseño|instalaci[oó]n|mantenimiento|auditor[ií]a|reparaci[oó]n|capacitaci[oó]n|migraci[oó]n|gesti[oó]n|configuraci[oó]n|fotograf[ií]a|publicidad|asesor[ií]a|campa[nñ]as?|optimizaci[oó]n|posicionamiento';

  const patterns = [
    // "cambiar el servicio a X", "cambia servicio por X", "reemplazar servicio por X", "sustituir servicio por X"
    new RegExp(`(?:cambiar|cambia|cambialo|cambiala|modificar|modifica|reemplazar|reemplaza|sustituir|sustituye|actualizar|actualiza)\\s+(?:el\\s+)?(?:nombre\\s+del\\s+)?servicio\\s+(?:a|por|en|:)?\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "servicio: X", "servicio de X", "el servicio es X", "servicio es X", "nuevo servicio: X"
    new RegExp(`(?:(?:el\\s+)?(?:nuevo\\s+)?servicio\\s*(?:es|ser[ií]a|:)?|servicio\\s+de)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "quieren un CRM", "necesitan un software", "solicitan una app", "buscan un CRM"
    new RegExp(`(?:quieren|quiere|necesitan|necesita|requieren|requiere|solicitan|solicita|buscan|busca)\\s+(?:un|una|el|la)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "implementar/configurar/instalar un CRM / sistema"
    new RegExp(`(?:implementar(?:le)?|configurar(?:le)?|instalar(?:le)?|desarrollar(?:le)?)\\s+(?:un|una|el|la)?\\s*([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "realizarle una X", "realizar un X", "hacerle una X", "hacer un X"
    new RegExp(`(?:realizar(?:le)?|hacer(?:le)?|crear(?:le)?)\\s+(?:un|una|el|la)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "agregar/incluir el servicio de X"
    new RegExp(`(?:agregar|incluir)\\s+(?:el\\s+|un\\s+)?servicio\\s+(?:de\\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // "para generación de leads", "para marketing digital", "con captación de clientes"
    new RegExp(`(?:para(?:\\s+la)?|con)\\s+((?:${activities})\\s+de\\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i'),
    // Actividades directas de servicio: "diseño de X", "instalación de X", "generación de leads", etc.
    new RegExp(`((?:${activities})\\s+de\\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s\\-\\.]+?)${delim}`, 'i')
  ];

  const blacklist = [
    'atención al cliente', 'atencion al cliente', 'una cotización', 'cotizacion',
    'un correo', 'una cuenta', 'un descuento', 'la empresa', 'el negocio',
    'la panadería', 'la ferretería', 'el restaurant', 'el señor', 'la señora'
  ];

  const standardTerms = [
    'landing', 'landing page', 'landing pahe', 'página web', 'pagina web',
    'chatbot', 'chatbots', 'agente', 'agentes', 'inteligencia artificial',
    'correo corporativo', 'automatización', 'automatizacion',
    'consultoría', 'consultoria', 'soporte', 'soporte técnico',
    'google business', 'perfil de negocio', 'desarrollo a medida', 'software a medida',
    'crm', 'sistema crm', 'gestion de clientes', 'gestión de clientes'
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      let cand = match[1].trim().replace(/[;,.]$/, '').trim();
      const candLower = cand.toLowerCase();

      const isBlacklisted = blacklist.some(b => candLower.includes(b));
      const isStandard = standardTerms.some(st => candLower.includes(st));

      if (!isBlacklisted && !isStandard && cand.length >= 2) {
        const formattedName = cand.toUpperCase() === cand ? cand : (cand.charAt(0).toUpperCase() + cand.slice(1));
        const serviceId = `custom_${candLower.replace(/[^a-z0-9]/g, '_').slice(0, 15)}`;
        custom.push({
          id: serviceId,
          nombre: formattedName,
          descripcion: detectedDesc || `Servicio especializado: ${formattedName}`,
          precio: (detectedPrice !== null && detectedPrice !== undefined) ? detectedPrice : null,
          cantidad: 1,
          isCustom: true
        });
        break;
      }
    }
  }
  return custom;
}

// Parser ligero. Extrae campos esperados mediante regex inteligente.
async function parseNaturalLanguage(rawText) {
  const text = cleanSpokenText(rawText);
  const result = {
    clienteNombre: null,
    clienteEmpresa: null,
    clienteEmail: null,
    clienteTel: null,
    clienteDir: null,
    servicios: [],
    descuento: 0,
    notas: null,
    montoGlobal: null,
    isNewQuote: false,
    replaceServices: false,
    servicioDescripcion: null
  };

  // Detectar si el mensaje inicia una nueva solicitud de cotización
  if (/(?:vamos a|nueva|hacer|crear|generar|preparar|armar|iniciar|comenzar|montar)\s+(?:enviar\s+)?(?:una\s+)?cotizaci[oó]n|nueva\s+cotizaci[oó]n/i.test(text)) {
    result.isNewQuote = true;
  }

  // Detectar si el usuario pide explícitamente cambiar o definir el servicio
  if (/(?:cambiar|cambia|cambialo|cambiala|modificar|modifica|reemplazar|reemplaza|sustituir|sustituye)\s+(?:el\s+)?(?:nombre\s+del\s+)?servicio|servicio\s*:|(?:el\s+)?servicio\s+(?:es|ser[ií]a)/i.test(text)) {
    result.replaceServices = true;
  }

  // Extraer descripción de servicio si fue especificada
  const descDetected = extractServiceDescription(text);
  if (descDetected) {
    result.servicioDescripcion = descDetected;
  }

  // Normalizar email en el texto
  result.clienteEmail = extractEmail(text);

  // Nombre ('nombre: X', 'atención: X', 'al señor Juan', 'al sr. Juan', 'señor Juan', 'para Juan')
  const nonNameTerms = [
    'atención al cliente', 'atencion al cliente', 'servicio al cliente',
    'un chatbot', 'una landing', 'una pagina', 'página web', 'un desarrollo'
  ];

  let nombreMatch = text.match(/(?:nombre|cliente|contacto|atenci[oó]n\s+a)[:\s]+(?:el\s+señor\s+|la\s+señora\s+|sr\.?\s+|sra\.?\s+|don\s+|doña\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ ]+)/i);
  if (nombreMatch) {
    const cand = nombreMatch[1].trim();
    if (nonNameTerms.some(term => cand.toLowerCase().includes(term))) {
      nombreMatch = null;
    }
  }

  if (!nombreMatch) {
    nombreMatch = text.match(/(?:señor|señora|sr\.?|sra\.?|don|doña)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]+)?)/i);
  }
  if (!nombreMatch) {
    nombreMatch = text.match(/(?:para\s+el\s+señor|para\s+la\s+señora|para\s+el\s+sr\.?|para\s+la\s+sra\.?|enviarlo\s+a\s+la\s+señora|enviarlo\s+a\s+el\s+señor|enviar\s+a\s+la\s+señora|enviar\s+a\s+el\s+señor)\s+([A-ZÁÉÍÓÚáéíóú][a-záéíóúñÑ]+(?:\s+[A-ZÁÉÍÓÚáéíóú][a-záéíóúñÑ]+)?)/i);
  }
  if (!nombreMatch) {
    nombreMatch = text.match(/(?:para)\s+([A-ZÁÉÍÓÚ][a-záéíóúñÑ]+(?:\s+[A-ZÁÉÍÓÚ][a-záéíóúñÑ]+)?)/);
    if (nombreMatch && /cotizaci[oó]n|empresa|cliente|un|una|landing|servicio|desarrollo|software|restaurant|restaurante|negocio|tienda|comercio|cl[ií]nica|taller|ferreter[ií]a|hotel|posada|farmacia/i.test(nombreMatch[1])) {
      nombreMatch = null;
    }
  }
  // Si no se detectó nombre explícito, intentar extraer el nombre desde la frase del correo (ej: "El correo es Ana María@gmail.com")
  if (!nombreMatch) {
    const nameFromEmail = text.match(/(?:correo|email|mail)(?:\s+es|\s*:)?\s*([A-ZÁÉÍÓÚ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚ][a-záéíóúñ]+)?)\s*(?:@|arroba|aroba|gmail|yahoo|hotmail|outlook)/i);
    if (nameFromEmail) {
      nombreMatch = nameFromEmail;
    }
  }
  if (nombreMatch) {
    let cand = nombreMatch[1].trim();
    // Limpiar restos de frases de correo como "arroba", "gmail", etc.
    cand = cand.replace(/\s+(?:arroba|aroba|email|correo|gmail|yahoo|hotmail|outlook).*$/i, '').trim();
    if (cand) result.clienteNombre = cand;
  }

  // Empresa ('empresa: X', 'del Restaurant El Maute', 'de ferretería EPA', 'clínica veterinaria llamada Mis Cachorros')
  const nonCompanyTerms = [
    'atención al cliente', 'atencion al cliente', 'un chatbot', 'una landing',
    'una pagina', 'página web', 'un desarrollo', 'software', 'consultoría',
    'soporte', 'una cotización', 'cotizacion', 'servicio', 'servicios',
    'el señor', 'la señora', 'un correo', 'una cuenta', 'landing', 'landing page',
    'landing pahe', 'chatbot', 'chatbots', 'monto', 'precio', 'costo', 'valor'
  ];

  const companyDelimiters = `(?=\\s+para\\b|\\s+con\\b|\\s+de\\s+una\\b|\\s+hacer\\b|\\.\\s+|$|,|\\s+el\\s+señor\\b|\\s+la\\s+señora\\b|\\s+sr\\.?|\\s+sra\\.?|\\s+don\\b|\\s+doña\\b|\\s+atenci[oó]n\\b|\\s+contacto\\b)`;

  // 1. Patrón "llamada X", "llamado X", "de nombre X", "que se llama X" (ej: "clínica veterinaria llamada Mis Cachorros")
  let llamadaMatch = text.match(new RegExp(`(?:(?:para|de|a)\\s+(?:un|una|el|la)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ\\s]+?)\\s+)?(?:llamada|llamado|de\\s+nombre|que\\s+se\\s+llama)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s.\\-\\/]+?)${companyDelimiters}`, 'i'));
  if (llamadaMatch) {
    const categoria = llamadaMatch[1] ? llamadaMatch[1].trim() : '';
    const nombre = llamadaMatch[2].trim();
    if (categoria && /veterinaria|cl[ií]nica|tienda|panader[ií]a|restaurant|ferreter[ií]a|agencia|empresa/i.test(categoria)) {
      result.clienteEmpresa = `${categoria.charAt(0).toUpperCase() + categoria.slice(1)} ${nombre}`;
    } else {
      result.clienteEmpresa = nombre.charAt(0).toUpperCase() + nombre.slice(1);
    }
  }

  if (!result.clienteEmpresa) {
    const categories = 'veterinaria|cl[ií]nica\\s+veterinaria|cl[ií]nica|restaurant|restaurante|negocio|local|tienda|comercio|taller|compa[nñ][ií]a|empresa|ferreter[ií]a|hotel|posada|farmacia|panader[ií]a|distribuidora|inversiones|corporaci[oó]n|grupo|agencia|estudio|consultora|constructora|laboratorio|market|supermercado|auto\\s*lavado|autolavado';

    let empresaMatch = text.match(new RegExp(`(?:empresa|negocio|marca|compa[nñ][ií]a)[:\\s]+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s.\\-\\/]+?)${companyDelimiters}`, 'i'));

    if (!empresaMatch) {
      empresaMatch = text.match(new RegExp(`(?:del|de\\s+la|de\\s+el|de\\s+un|de\\s+una|para|para\\s+el|para\\s+la|para\\s+un|para\\s+una)\\s+((?:${categories})\\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s.\\-\\/]+?)${companyDelimiters}`, 'i'));
    }

    if (!empresaMatch) {
      empresaMatch = text.match(new RegExp(`(?:de\\s+la\\s+empresa|del\\s+negocio|de\\s+la\\s+tienda|para\\s+la\\s+empresa|para\\s+el\\s+negocio|para\\s+la\\s+tienda|para\\s+el\\s+restaurant|para\\s+el\\s+restaurante)\\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s.\\-\\/]+?)${companyDelimiters}`, 'i'));
    }

    if (!empresaMatch) {
      empresaMatch = text.match(new RegExp(`(?:del|de\\s+la|para\\s+la|de)\\s+(ferreter[ií]a\\s+[A-Za-z0-9]+|[A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóúñÑ0-9\\s.\\-\\/]+?)${companyDelimiters}`));
    }

    if (empresaMatch) {
      let candidate = empresaMatch[1].trim();
      candidate = candidate.replace(/[,.]$/, '').trim();
      const candidateLower = candidate.toLowerCase();
      if (!nonCompanyTerms.some(term => candidateLower.includes(term)) && candidate.length > 2) {
        result.clienteEmpresa = candidate.charAt(0).toUpperCase() + candidate.slice(1);
      }
    }
  }

  // Teléfono
  const telMatch = text.match(/tel[:\s]*([+\d\s()-]+)/i);
  if (telMatch) result.clienteTel = telMatch[1].trim();

  // Dirección
  const dirMatch = text.match(/direcci[oó]n[:\s]*([^,\.\n]+)/i);
  if (dirMatch) result.clienteDir = dirMatch[1].trim();

  // Limpiar email y prefijos de email del texto para evitar que "Correo juan@gmail.com" se interprete como servicio de correo
  let textForServices = text
    .replace(/(?:correo|email|mail)(?:\s+es|\s*:)?\s*[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '');

  // Extracción de precio / monto personalizado
  const detectedPrice = extractPriceUpdates(text);
  if (detectedPrice !== null) {
    result.montoGlobal = detectedPrice;
  }

  // 1. Servicios estándar del catálogo (usando límites de palabra y patrones refinados)
  const serviciosDisponibles = [
    { pat: '\\blanding\\b|landing\\s+page|landing\\s+pahe|p[aá]gina\\s+web', id: 'lp' },
    { pat: '\\bagentes?\\b|\\bchatbots?\\b|\\binteligencia\\s+artificial\\b|\\bIA\\b', id: 'ai' },
    { pat: '\\bautomatizaci[oó]n\\b|\\bcuentas?\\s+(?:corporativa|profesional)(?:s)?\\s+de\\s+correo\\b|\\bcorreos?\\s+(?:de\\s+dominio|corporativos?|profesionales?)\\b|\\bemails?\\s+corporativos?\\b|\\bconfiguraci[oó]n\\s+de\\s+correo\\b', id: 'af' },
    { pat: '\\bconsultor[ií]a\\b', id: 'con' },
    { pat: '\\bsoporte\\b', id: 'sop' },
    { pat: 'google\\s+my\\s+business|google\\s+business|perfil\\s+de\\s+negocio|an[aá]lisis\\s+(?:del\\s+)?perfil|perfil\\s+de\\s+google', id: 'gmb' },
    { pat: '\\bcrm\\b|\\bsistema\\s+crm\\b|\\bgesti[oó]n\\s+de\\s+clientes\\b', id: 'crm' }
  ];

  serviciosDisponibles.forEach(s => {
    if (new RegExp(s.pat, 'i').test(textForServices)) {
      if (!result.servicios.some(x => x.id === s.id)) {
        result.servicios.push({ id: s.id, cantidad: 1, precio: detectedPrice || null, descripcion: descDetected || null });
      }
    }
  });

  // Desarrollo a medida (md): solo si se menciona explícitamente a medida, o si no se detectó ningún otro servicio y menciona desarrollo/software
  const mdExplicit = /\bdesarrollo\s+a\s+medida\b|\bsoftware\s+a\s+medida\b|\bdesarrollo\s+personalizado\b|\bsoftware\s+personalizado\b/i;
  const mdGeneric = /\bdesarrollo\b|\bsoftware\b/i;
  if (mdExplicit.test(textForServices) || (result.servicios.length === 0 && mdGeneric.test(textForServices))) {
    if (!result.servicios.some(x => x.id === 'md')) {
      result.servicios.push({ id: 'md', cantidad: 1, precio: detectedPrice || null, descripcion: descDetected || null });
    }
  }

  // Descuento ('15%', '15 por 100', '15 por ciento', 'descuento: 15%')
  const descMatch = text.match(/(?:descuento[:\s]*([\d,.]+)%?)|(?:([\d,.]+)\s*(?:%|por\s+ciento|por\s+100)\s*(?:de\s+)?descuento)/i);
  if (descMatch) {
    let val = (descMatch[1] || descMatch[2]).replace(',', '.');
    if (val.includes('.')) result.descuento = Math.round(parseFloat(val) * 100);
    else result.descuento = parseInt(val, 10);
  }

  // 2. Detección de servicios personalizados fuera del catálogo
  const customSvcs = extractCustomServices(textForServices, detectedPrice, descDetected);
  customSvcs.forEach(cs => {
    if (!result.servicios.some(x => x.id === cs.id || (x.nombre && x.nombre.toLowerCase() === cs.nombre.toLowerCase()))) {
      result.servicios.push(cs);
    }
  });

  // Notas
  const notasMatch = text.match(/notas[:\s]*([\s\S]*)/i);
  if (notasMatch) result.notas = notasMatch[1].trim();

  return result;
}

// Carga dinámica del catálogo de servicios desde servicios.json
function getServiciosCatalog() {
  const serviciosPath = path.join(__dirname, 'servicios.json');
  try {
    if (fs.existsSync(serviciosPath)) {
      return JSON.parse(fs.readFileSync(serviciosPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error leyendo servicios.json:', e);
  }
  return {};
}

// Calcula los montos y totales de los servicios detectados para previsualización
function calculateSummaryTotals(data) {
  const catalog = getServiciosCatalog();
  const lineas = (data.servicios || []).map(s => {
    const item = catalog[s.id] || {};
    const name = s.nombre || item.nombre || 'Servicio Personalizado';
    const desc = s.descripcion || item.descripcion || 'Servicio acordado con el cliente';
    const p = (s.precio !== undefined && s.precio !== null && s.precio > 0) ? s.precio : (s.isCustom ? null : (item.precio !== undefined ? item.precio : 500));
    const qty = s.cantidad || 1;
    const total = p !== null ? p * qty : null;
    return {
      id: s.id,
      name,
      desc,
      p,
      qty,
      total,
      isCustom: s.isCustom || !catalog[s.id]
    };
  });

  const validLines = lineas.filter(l => l.total !== null);
  const subtotal = validLines.reduce((acc, l) => acc + l.total, 0);
  const descPercent = data.descuento || 0;
  const descAmount = subtotal * (descPercent / 100);
  const total = subtotal - descAmount;
  const hasPendingPrice = lineas.some(l => l.p === null || l.p === undefined);

  return { lineas, subtotal, descPercent, descAmount, total, hasPendingPrice };
}

// Genera un mensaje de resumen amigable para Telegram solicitando siempre el correo o monto si falta
function buildSummaryMessage(data) {
  let msg = '📋 *DATOS DE LA COTIZACIÓN*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += `👤 *Cliente:* ${data.clienteNombre || '⚠️ _No especificado_'}\n`;
  msg += `🏢 *Empresa:* ${data.clienteEmpresa || '⚠️ _No especificada_'}\n`;
  if (data.clienteEmail) {
    msg += `✉️ *Email:* \`${data.clienteEmail}\`\n`;
  } else {
    msg += `✉️ *Email:* ❌ *No detectado* _(requerido para Gmail)_\n`;
  }
  if (data.clienteTel) msg += `☎️ *Teléfono:* ${data.clienteTel}\n`;
  if (data.clienteDir) msg += `📍 *Dirección:* ${data.clienteDir}\n`;

  const { lineas, subtotal, descPercent, descAmount, total, hasPendingPrice } = calculateSummaryTotals(data);

  msg += '\n💼 *Servicios Detectados:*\n';
  if (lineas.length > 0) {
    lineas.forEach((l, idx) => {
      if (l.p !== null && l.p !== undefined && l.p > 0) {
        msg += `  ${idx + 1}. *${l.name}* (x${l.qty}) — ${fmt(l.total)}\n`;
      } else {
        msg += `  ${idx + 1}. *${l.name}* (x${l.qty}) — ⚠️ *Monto pendiente*\n`;
      }
      if (l.desc) {
        msg += `     📝 _${l.desc}_\n`;
      }
    });
    msg += '─────────────────────\n';
    if (!hasPendingPrice) {
      msg += `• *Subtotal:* ${fmt(subtotal)}\n`;
      if (descPercent > 0) {
        msg += `• *Descuento (${descPercent}%):* -${fmt(descAmount)}\n`;
      }
      msg += `💰 *TOTAL ESTIMADO:* *${fmt(total)} USD*\n`;
    } else {
      msg += `💰 *TOTAL ESTIMADO:* ⚠️ _Pendiente por definir monto de servicio(s)_\n`;
    }
  } else {
    msg += '  ⚠️ _No se detectaron servicios._\n';
  }

  if (data.notas) {
    msg += `\n📝 *Notas:* _${data.notas}_\n`;
  }

  msg += '━━━━━━━━━━━━━━━━━━━━━\n';

  const hasClientOrCompany = !!(data.clienteNombre || data.clienteEmpresa);
  const hasServices = lineas.length > 0;

  if (hasPendingPrice) {
    const pendingNames = lineas.filter(l => l.p === null || l.p === undefined || l.p <= 0).map(l => `*${l.name}*`).join(', ');
    msg += `\n⚠️ *Acción requerida:* Por favor indícame el monto o precio para ${pendingNames} (ej: "el monto es $150" o simplemente "$150").`;
  } else if (!hasClientOrCompany) {
    msg += '\n⚠️ *Falta especificar el cliente o la empresa.*';
  } else if (!hasServices) {
    msg += '\n⚠️ *Falta especificar los servicios solicitados.*';
  } else {
    msg += '\n👉 *Por favor confirma si los datos son correctos:*';
  }

  return msg;
}

// Teclado interactivo para confirmación de datos
function buildConfirmationKeyboard(data) {
  const { lineas, hasPendingPrice } = calculateSummaryTotals(data);
  const hasClientOrCompany = !!(data.clienteNombre || data.clienteEmpresa);
  const hasServices = lineas.length > 0;

  // Si hay algún servicio con monto pendiente, permitir indicar monto, cambiar servicio o descripción
  if (hasPendingPrice) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('💰 Indicar Monto', 'ask_price'),
        Markup.button.callback('🔄 Cambiar Servicio', 'ask_service')
      ],
      [
        Markup.button.callback('➕ Agregar Servicio', 'add_service'),
        Markup.button.callback('📝 Cambiar Descripción', 'ask_desc')
      ],
      [
        Markup.button.callback('❌ Descartar', 'cancel_quote')
      ]
    ]);
  }

  if (hasClientOrCompany && hasServices) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirmar Datos', 'confirm_quote'),
        Markup.button.callback('🔄 Cambiar Servicio', 'ask_service')
      ],
      [
        Markup.button.callback('➕ Agregar Servicio', 'add_service'),
        Markup.button.callback('📝 Cambiar Descripción', 'ask_desc')
      ],
      [
        Markup.button.callback('✏️ Más Opciones', 'edit_quote'),
        Markup.button.callback('❌ Descartar', 'cancel_quote')
      ]
    ]);
  } else {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Agregar más datos', 'edit_quote'),
        Markup.button.callback('❌ Descartar', 'cancel_quote')
      ]
    ]);
  }
}

// Teclado de acciones disponibles tras confirmar
function buildActionKeyboard(hasEmail) {
  const rows = [
    [Markup.button.callback('📄 Generar y Enviar PDF', 'action_pdf')]
  ];
  if (hasEmail) {
    rows.push([Markup.button.callback('📧 Guardar Borrador en Gmail', 'action_draft')]);
  }
  rows.push([Markup.button.callback('🔄 Iniciar Nueva Cotización', 'cancel_quote')]);
  return Markup.inlineKeyboard(rows);
}

// Transcripción ultra rápida vía Deepgram Nova-2 API (Compatible en Venezuela sin VPN)
async function transcribeAudio(oggPath) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('No se encontró la variable DEEPGRAM_API_KEY en el archivo .env');
  }
  const fetch = (await import('node-fetch')).default;
  const audioBuffer = fs.readFileSync(oggPath);

  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'audio/ogg'
    },
    body: audioBuffer
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error en Deepgram API (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const transcript = data.results?.channels[0]?.alternatives[0]?.transcript;
  return transcript || '';
}

// --- Bot Handlers ------------------------------------------------------------
bot.start(ctx => {
  resetState(ctx.chat.id);
  ctx.reply('👋 Bienvenido al Cotizador JP Solutions. Envíame datos en texto o nota de voz para generar una cotización.');
});

bot.on('text', async (ctx, next) => {
  // Ignorar comandos para no intentar procesarlos como texto de cotización ni borrar el estado
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    return next();
  }

  const state = getState(ctx.chat.id);
  const userText = ctx.message.text;

  // --- Manejo de acción pendiente (flujo guiado por botón) ---
  if (state.pending_action) {
    const action = state.pending_action;
    delete state.pending_action;

    if (action === 'awaiting_desc') {
      // El usuario envió la descripción directamente — asignarla al último servicio
      const desc = userText.trim();
      if (state.data.servicios && state.data.servicios.length > 0) {
        state.data.servicios[state.data.servicios.length - 1].descripcion = desc;
      }
      await ctx.reply(buildSummaryMessage(state.data), {
        parse_mode: 'Markdown',
        ...buildConfirmationKeyboard(state.data)
      });
      return;
    }

    if (action === 'awaiting_service') {
      // Usar el texto LITERALMENTE como nombre — sin mapear al catálogo
      // Extraer precio si el usuario lo incluyó (ej: "Chatbot $300" o "Chatbot ;monto 300")
      const newPrice = extractPriceUpdates(userText);
      // Preservar precio del primer servicio existente si no se especificó uno nuevo
      const existingPrice = (state.data.servicios && state.data.servicios.length > 0)
        ? state.data.servicios[0].precio
        : null;
      const finalPrice = (newPrice !== null) ? newPrice : existingPrice;
      // Limpiar el nombre: quitar precio/monto si fue incluido en el texto
      const svcNameRaw = userText
        .replace(/\s*;?\s*(?:monto|precio|costo)\s*\$?\s*[\d.,]+/gi, '')
        .replace(/\s*\$\s*[\d.,]+/g, '')
        .trim().replace(/[;,.]$/, '').trim();
      const formattedName = svcNameRaw.charAt(0).toUpperCase() + svcNameRaw.slice(1);
      // Reemplazar TODOS los servicios con el nuevo (literal)
      state.data.servicios = [{
        id: `custom_${svcNameRaw.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 15)}`,
        nombre: formattedName,
        descripcion: state.data.servicios && state.data.servicios.length > 0
          ? (state.data.servicios[0].descripcion || `Servicio: ${formattedName}`)
          : `Servicio: ${formattedName}`,
        precio: finalPrice,
        cantidad: 1,
        isCustom: true
      }];
      await ctx.reply(buildSummaryMessage(state.data), {
        parse_mode: 'Markdown',
        ...buildConfirmationKeyboard(state.data)
      });
      return;
    }

    if (action === 'awaiting_add_service') {
      // Agregar servicio con nombre LITERAL sin borrar los existentes
      const newPrice = extractPriceUpdates(userText);
      const svcNameRaw = userText
        .replace(/\s*;?\s*(?:monto|precio|costo)\s*\$?\s*[\d.,]+/gi, '')
        .replace(/\s*\$\s*[\d.,]+/g, '')
        .trim().replace(/[;,.]$/, '').trim();
      const formattedName = svcNameRaw.charAt(0).toUpperCase() + svcNameRaw.slice(1);
      const newSvc = {
        id: `custom_${svcNameRaw.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 15)}`,
        nombre: formattedName,
        descripcion: `Servicio: ${formattedName}`,
        precio: newPrice,
        cantidad: 1,
        isCustom: true
      };
      if (!state.data.servicios) state.data.servicios = [];
      // Evitar duplicados por nombre
      const dupIdx = state.data.servicios.findIndex(s => s.nombre && s.nombre.toLowerCase() === formattedName.toLowerCase());
      if (dupIdx >= 0) {
        state.data.servicios[dupIdx] = newSvc;
      } else {
        state.data.servicios.push(newSvc);
      }
      await ctx.reply(buildSummaryMessage(state.data), {
        parse_mode: 'Markdown',
        ...buildConfirmationKeyboard(state.data)
      });
      return;
    }

    if (action === 'awaiting_price') {
      // El usuario envió el precio — extraerlo y asignarlo
      const parsed = await parseNaturalLanguage(userText);
      const currentData = mergeStateData(ctx.chat.id, parsed);
      await ctx.reply(buildSummaryMessage(currentData), {
        parse_mode: 'Markdown',
        ...buildConfirmationKeyboard(currentData)
      });
      return;
    }
  }

  // --- Flujo normal ---
  const parsed = await parseNaturalLanguage(userText);
  const currentData = mergeStateData(ctx.chat.id, parsed);
  await ctx.reply(buildSummaryMessage(currentData), {
    parse_mode: 'Markdown',
    ...buildConfirmationKeyboard(currentData)
  });
});

bot.on('voice', async ctx => {
  await ctx.reply('⏳ Transcribiendo nota de voz...');
  let oggPath = null;
  try {
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const resp = await (await import('node-fetch')).default(url);
    const buffer = Buffer.from(await resp.arrayBuffer());
    oggPath = path.join(__dirname, `voice_${Date.now()}.ogg`);
    fs.writeFileSync(oggPath, buffer);

    const rawText = await transcribeAudio(oggPath);
    const cleanText = cleanSpokenText(rawText);

    await ctx.reply(`🗒️ *Transcripción:*\n_${cleanText}_`, { parse_mode: 'Markdown' });

    const state = getState(ctx.chat.id);

    // --- Manejo de acción pendiente (flujo guiado por botón) ---
    if (state.pending_action) {
      const action = state.pending_action;
      delete state.pending_action;

      if (action === 'awaiting_desc') {
        const desc = cleanText.trim();
        if (state.data.servicios && state.data.servicios.length > 0) {
          state.data.servicios[state.data.servicios.length - 1].descripcion = desc;
        }
        await ctx.reply(buildSummaryMessage(state.data), {
          parse_mode: 'Markdown',
          ...buildConfirmationKeyboard(state.data)
        });
        return;
      }

      if (action === 'awaiting_service') {
        // Usar el texto LITERALMENTE como nombre — sin mapear al catálogo
        const newPrice = extractPriceUpdates(cleanText);
        const existingPrice = (state.data.servicios && state.data.servicios.length > 0)
          ? state.data.servicios[0].precio
          : null;
        const finalPrice = (newPrice !== null) ? newPrice : existingPrice;
        const svcNameRaw = cleanText
          .replace(/\s*;?\s*(?:monto|precio|costo)\s*\$?\s*[\d.,]+/gi, '')
          .replace(/\s*\$\s*[\d.,]+/g, '')
          .trim().replace(/[;,.]$/, '').trim();
        const formattedName = svcNameRaw.charAt(0).toUpperCase() + svcNameRaw.slice(1);
        state.data.servicios = [{
          id: `custom_${svcNameRaw.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 15)}`,
          nombre: formattedName,
          descripcion: state.data.servicios && state.data.servicios.length > 0
            ? (state.data.servicios[0].descripcion || `Servicio: ${formattedName}`)
            : `Servicio: ${formattedName}`,
          precio: finalPrice,
          cantidad: 1,
          isCustom: true
        }];
        await ctx.reply(buildSummaryMessage(state.data), {
          parse_mode: 'Markdown',
          ...buildConfirmationKeyboard(state.data)
        });
        return;
      }

      if (action === 'awaiting_add_service') {
        const newPrice = extractPriceUpdates(cleanText);
        const svcNameRaw = cleanText
          .replace(/\s*;?\s*(?:monto|precio|costo)\s*\$?\s*[\d.,]+/gi, '')
          .replace(/\s*\$\s*[\d.,]+/g, '')
          .trim().replace(/[;,.]$/, '').trim();
        const formattedName = svcNameRaw.charAt(0).toUpperCase() + svcNameRaw.slice(1);
        const newSvc = {
          id: `custom_${svcNameRaw.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 15)}`,
          nombre: formattedName,
          descripcion: `Servicio: ${formattedName}`,
          precio: newPrice,
          cantidad: 1,
          isCustom: true
        };
        if (!state.data.servicios) state.data.servicios = [];
        const dupIdx = state.data.servicios.findIndex(s => s.nombre && s.nombre.toLowerCase() === formattedName.toLowerCase());
        if (dupIdx >= 0) {
          state.data.servicios[dupIdx] = newSvc;
        } else {
          state.data.servicios.push(newSvc);
        }
        await ctx.reply(buildSummaryMessage(state.data), {
          parse_mode: 'Markdown',
          ...buildConfirmationKeyboard(state.data)
        });
        return;
      }

      if (action === 'awaiting_price') {
        const parsed = await parseNaturalLanguage(cleanText);
        const currentData = mergeStateData(ctx.chat.id, parsed);
        await ctx.reply(buildSummaryMessage(currentData), {
          parse_mode: 'Markdown',
          ...buildConfirmationKeyboard(currentData)
        });
        return;
      }
    }

    // --- Flujo normal ---
    const parsed = await parseNaturalLanguage(cleanText);
    const currentData = mergeStateData(ctx.chat.id, parsed);
    await ctx.reply(buildSummaryMessage(currentData), {
      parse_mode: 'Markdown',
      ...buildConfirmationKeyboard(currentData)
    });
  } catch (e) {
    console.error('Error procesando nota de voz:', e);
    await ctx.reply('❌ Error al procesar la nota de voz. Por favor intenta de nuevo.').catch(() => {});
  } finally {
    if (oggPath && fs.existsSync(oggPath)) {
      try { fs.unlinkSync(oggPath); } catch (_) {}
    }
  }
});

// Helper para construir la estructura completa de datos requerida por pdfEngine
function preparePdfData(stateData) {
  const catalog = getServiciosCatalog();
  const lineas = (stateData.servicios || []).map((s, idx) => {
    const item = catalog[s.id] || {};
    const name = s.nombre || item.nombre || 'Servicio Tecnológico';
    const desc = s.descripcion || item.descripcion || 'Servicio de desarrollo / consultoría TI';
    const p = (s.precio !== undefined && s.precio !== null) ? s.precio : (item.precio !== undefined ? item.precio : 500);

    return {
      n: idx + 1,
      name,
      desc,
      p,
      total: p * (s.cantidad || 1),
      custom: s.isCustom || !catalog[s.id]
    };
  });

  if (lineas.length === 0) {
    lineas.push({ n: 1, name: 'Servicio Personalizado', desc: 'Desarrollo de soluciones tecnológicas acordadas', p: 500, total: 500 });
  }

  if (!stateData.cotNum) {
    stateData.cotNum = `JP-${Math.floor(100 + Math.random() * 900)}`;
  }
  if (!stateData.cotFecha) {
    stateData.cotFecha = new Date().toISOString().slice(0, 10);
  }

  return {
    cotNum: stateData.cotNum,
    cotFecha: stateData.cotFecha,
    emisor: {
      email: process.env.JP_EMAIL || 'info@jpsolutions.online',
      tel: process.env.JP_TEL || '',
      web: 'www.jpsolutions.online',
      ciudad: 'Caracas, Venezuela'
    },
    cliente: {
      nombre: stateData.clienteNombre || '',
      empresa: stateData.clienteEmpresa || '',
      email: stateData.clienteEmail || '',
      tel: stateData.clienteTel || '',
      dir: stateData.clienteDir || ''
    },
    lineas,
    descuento: stateData.descuento || 0,
    notas: stateData.notas || 'Cotización generada automáticamente por el asistente virtual de JPS'
  };
}

// Codificador de cabeceras MIME según RFC 2047 (UTF-8 Base64) para evitar caracteres garabateados en Asunto y archivos
function encodeMimeHeader(text) {
  if (!text) return '';
  return '=?UTF-8?B?' + Buffer.from(text, 'utf-8').toString('base64') + '?=';
}

// Construye un correo en formato MIME multipart/mixed con cuerpo HTML y adjunto PDF
function createMimeDraft({ to, subject, bodyHtml, filename, pdfBuffer }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  let mime = '';
  mime += `From: me\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${encodeMimeHeader(subject)}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

  // Cuerpo HTML
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/html; charset=UTF-8\r\n`;
  mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
  mime += `${Buffer.from(bodyHtml, 'utf-8').toString('base64')}\r\n\r\n`;

  // Adjunto PDF
  if (pdfBuffer && filename) {
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: application/pdf; name="${encodeMimeHeader(filename)}"\r\n`;
    mime += `Content-Description: ${encodeMimeHeader(filename)}\r\n`;
    mime += `Content-Disposition: attachment; filename="${encodeMimeHeader(filename)}"\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    mime += `${pdfBuffer.toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n\r\n`;
  }

  mime += `--${boundary}--\r\n`;
  return Buffer.from(mime).toString('base64url');
}

// Genera y envía el PDF al chat de Telegram
async function generateAndSendPdf(ctx, chatId) {
  const state = getState(chatId);
  if (!state.data.clienteNombre && !state.data.clienteEmpresa) {
    return ctx.reply('⚠️ Faltan el nombre o la empresa del cliente para generar la cotización.');
  }

  try {
    const pdfData = preparePdfData(state.data);
    const pdfResult = buildPdf(pdfData);

    await ctx.replyWithDocument(
      { source: pdfResult.buffer, filename: `Cotizacion_JPSolutions_${pdfData.cotNum}.pdf` },
      { caption: `📄 *Cotización N° ${pdfData.cotNum}*\n💰 *Total:* ${fmt(pdfResult.total)}`, parse_mode: 'Markdown' }
    );
    resetState(chatId);
  } catch (err) {
    console.error('Error generando PDF:', err);
    await ctx.reply('❌ Error al generar el PDF: ' + err.message);
  }
}

// Genera la cotización y guarda un borrador en Gmail
async function createAndSendDraft(ctx, chatId) {
  const state = getState(chatId);
  const email = state.data.clienteEmail;
  if (!email) {
    return ctx.reply('⚠️ No se ha detectado un correo electrónico del cliente para guardar el borrador en Gmail.');
  }

  try {
    const authResult = await oauth.getValidAccessToken(chatId);
    const token = authResult.token;
    const emisorNombre = authResult.name || 'Asesor Comercial';
    const emisorEmail = authResult.email || process.env.JP_EMAIL || 'info@jpsolutions.online';

    const pdfData = preparePdfData(state.data);
    // Asignar el correo del emisor autenticado en el PDF si está disponible
    if (authResult.email) {
      pdfData.emisor.email = authResult.email;
    }

    const pdfResult = buildPdf(pdfData);
    const filename = `Cotizacion_JPSolutions_${pdfData.cotNum}.pdf`;

    const bodyHtml = `
      <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; line-height: 1.6;">
        <h2 style="color: #3b82f6; margin-bottom: 12px;">Cotización Formal — JP Solutions</h2>
        <p>Estimado/a <strong>${pdfData.cliente.nombre || pdfData.cliente.empresa}</strong>,</p>
        <p>Es un placer saludarte. Adjunto a este correo encontrarás la propuesta formal de cotización N° <strong>${pdfData.cotNum}</strong>.</p>
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6;">
          <p style="margin: 0 0 8px 0;"><strong>Resumen de la Propuesta:</strong></p>
          <ul style="margin: 0; padding-left: 20px;">
            ${pdfData.lineas.map(l => `<li>${l.name}: <strong>${fmt(l.total)} USD</strong></li>`).join('')}
          </ul>
          <p style="margin: 12px 0 0 0; font-size: 16px;"><strong>Monto Total: ${fmt(pdfResult.total)}</strong></p>
        </div>
        <p>Quedo atento/a a cualquier duda o comentario sobre la propuesta.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;" />
        <div style="font-size: 13px; color: #475569;">
          <p style="margin: 0 0 4px 0; font-weight: bold; font-size: 15px; color: #1e293b;">${emisorNombre}</p>
          <p style="margin: 0 0 6px 0; color: #64748b;">Asesor Comercial — <strong>JP Solutions</strong></p>
          <p style="margin: 0; font-size: 12px; color: #64748b;">
            ✉ <a href="mailto:${emisorEmail}" style="color: #3b82f6; text-decoration: none;">${emisorEmail}</a>${pdfData.emisor.tel ? ` | ☎ ${pdfData.emisor.tel}` : ''} | 🌐 <a href="https://${pdfData.emisor.web}" style="color: #3b82f6; text-decoration: none;">${pdfData.emisor.web}</a>
          </p>
        </div>
      </div>
    `;

    const rawMime = createMimeDraft({
      to: email,
      subject: `Propuesta de Cotización N° ${pdfData.cotNum} — ${pdfData.cliente.empresa || pdfData.cliente.nombre}`,
      bodyHtml,
      filename,
      pdfBuffer: pdfResult.buffer
    });

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: rawMime } })
    });

    if (!res.ok) {
      const errText = await res.text();
      return ctx.reply(`❌ Error al crear borrador en Gmail: ${errText}`);
    }

    await ctx.reply(
      `✅ *¡Borrador guardado en Gmail con éxito!*\n\n` +
      `👤 *Cuenta emisora:* \`${emisorEmail}\`\n` +
      `📧 *Destinatario:* \`${email}\`\n` +
      `📄 *Adjunto:* \`${filename}\`\n` +
      `💰 *Monto:* ${fmt(pdfResult.total)}`,
      { parse_mode: 'Markdown' }
    );
    resetState(chatId);
  } catch (e) {
    console.error('Error en draft:', e);
    await ctx.reply(`⚠️ ${e.message}`);
  }
}

// --- Comandos Directos ---
bot.command('cotizar', async ctx => {
  await generateAndSendPdf(ctx, ctx.chat.id);
});

bot.command('draft', async ctx => {
  await createAndSendDraft(ctx, ctx.chat.id);
});

bot.command('auth', async ctx => {
  try {
    const userTok = oauth.loadUserToken(ctx.chat.id);
    let extraInfo = '';
    if (userTok && userTok.email) {
      extraInfo = `\n\n📌 *Cuenta actualmente vinculada:* \`${userTok.email}\`\nSi deseas cambiarla o renovar el acceso, vuelve a hacer clic en el enlace.`;
    }

    // Usar la URL de producción configurada o fallback
    const baseUrl = process.env.APP_BASE_URL || 'https://telegramcotizador-2n0r.onrender.com';
    const redirectUri = `${baseUrl.replace(/\/+$/, '')}/oauth2callback`;
    const url = oauth.getAuthUrl(ctx.chat.id, redirectUri);

    await ctx.reply(
      `🔗 *Vincular cuenta de Gmail*\n\nHaz clic en el siguiente enlace para iniciar sesión con tu cuenta de Google y autorizar la creación de borradores:${extraInfo}\n\n👉 [Autorizar mi Gmail con Google OAuth](${url})`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (e) {
    ctx.reply('❌ Error iniciando autorización: ' + e.message);
  }
});

// --- Acciones de Botones Interactivos (Inline Keyboard) ---
bot.action('confirm_quote', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.chat.id);
  const data = state.data;

  if (!data.clienteNombre && !data.clienteEmpresa) {
    return ctx.reply('⚠️ Faltan el nombre o la empresa del cliente para poder emitir la cotización.');
  }

  const hasEmail = !!data.clienteEmail;
  let confirmMsg = '✅ *¡Datos de cotización confirmados!*\n\nElige la acción que deseas realizar:';
  if (!hasEmail) {
    confirmMsg += '\n\n💡 _Nota: Si deseas enviarlo a Gmail, proporciona primero el correo del cliente._';
  }

  await ctx.reply(confirmMsg, {
    parse_mode: 'Markdown',
    ...buildActionKeyboard(hasEmail)
  });
});

bot.action('ask_price', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.chat.id);
  const { lineas } = calculateSummaryTotals(state.data);
  const pending = lineas.find(l => l.p === null || l.p === undefined || l.p <= 0);
  const sName = pending ? pending.name : 'servicio';
  state.pending_action = 'awaiting_price';
  await ctx.reply(`💰 ¿Cuál es el precio para el servicio *"${sName}"*?\n\nEnvíame el monto (ej: _"$150"_ o _"el precio es 200"_).`, { parse_mode: 'Markdown' });
});

bot.action('ask_service', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.chat.id);
  const { lineas } = calculateSummaryTotals(state.data);
  const currentSvc = lineas.length > 0 ? lineas.map(l => `*${l.name}*`).join(', ') : 'el actual';
  state.pending_action = 'awaiting_service';
  await ctx.reply(`🔄 *Cambiar Servicio*\n\nServicio actual: ${currentSvc}\n\n¿Por cuál lo reemplazas? Escríbelo o dímelo por voz:\n_(ej: "Chatbot", "Landing Page", "Auditoría de Sistemas $400")_\n\n⚠️ _Esto reemplazará el servicio existente._`, { parse_mode: 'Markdown' });
});

bot.action('add_service', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.chat.id);
  state.pending_action = 'awaiting_add_service';
  await ctx.reply('➕ *Agregar Servicio*\n\n¿Qué servicio deseas agregar? Escríbelo o dímelo por voz:\n_(ej: "Chatbot", "Landing Page $200", "Consultoría")_\n\n✅ _Los servicios actuales se mantendrán._', { parse_mode: 'Markdown' });
});

bot.action('ask_desc', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.chat.id);
  state.pending_action = 'awaiting_desc';
  const { lineas } = calculateSummaryTotals(state.data);
  const svcName = lineas.length > 0 ? lineas[lineas.length - 1].name : 'el servicio';
  await ctx.reply(`📝 ¿Cuál es la descripción para *"${svcName}"*?\n\nEscríbela o dímela por voz directamente (no necesitas prefijo).`, { parse_mode: 'Markdown' });
});

bot.action('edit_quote', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('✍️ Puedes enviarme otra nota de voz o mensaje de texto indicando lo que deseas corregir o agregar (ejemplos:\n• "cambiar el monto a $150"\n• "descripción: Sistema para control de citas"\n• "el correo es cliente@empresa.com"\n• "descuento del 10%").');
});

bot.action('cancel_quote', async ctx => {
  await ctx.answerCbQuery();
  resetState(ctx.chat.id);
  await ctx.reply('🗑️ Cotización descartada. Puedes iniciar una nueva en cualquier momento enviándome un mensaje o nota de voz.');
});

bot.action('action_pdf', async ctx => {
  await ctx.answerCbQuery('Generando PDF...');
  await generateAndSendPdf(ctx, ctx.chat.id);
});

bot.action('action_draft', async ctx => {
  await ctx.answerCbQuery('Guardando borrador en Gmail...');
  await createAndSendDraft(ctx, ctx.chat.id);
});

async function startBot() {
  let connected = false;
  let attempts = 0;
  while (!connected) {
    attempts++;
    try {
      console.log(`📡 Conectando con Telegram API (intento ${attempts})...`);
      await bot.launch();
      console.log('🤖 ¡Bot iniciado con éxito en Telegram!');
      connected = true;
    } catch (err) {
      console.error(`⚠️ Error al iniciar el bot (${err.message}). Reintentando en 5 segundos...`);
      console.error('💡 Nota: Si estás en Venezuela, asegúrate de tener activa una VPN o Proxy para conectarte a Telegram.');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
