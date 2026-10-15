// pdfEngine.js — Genera el PDF IDÉNTICO al del cotizador web (Web_JPS/cotizador.html)
const { jsPDF } = require('jspdf');
const crypto = require('crypto');
const { ARIAL_B64, LOGO } = require('./assets/pdfAssets.js');

const SYM = '$', LOC = 'en-US';
const SECRET_SALT = 'JP$olutions#2026::CTZ::7bV9x!';

function fmt(n) {
  try { return SYM + new Intl.NumberFormat(LOC, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); }
  catch (e) { return SYM + Number(n).toFixed(2); }
}

// Código de seguridad de 20 dígitos (SHA-256 + sal), igual concepto que la web
function genSecurityCode(cotNum) {
  const raw = SECRET_SALT + '|' + (cotNum || '?') + '|' + Date.now() + '|' + Math.random();
  const hex = crypto.createHash('sha256').update(raw).digest('hex');
  const dec = BigInt('0x' + hex).toString(10);
  return dec.slice(-20).padStart(20, '0');
}

// Gradiente (idéntico a la web)
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
function drawGradient(doc, x, y, w, h, c1, c2) {
  const A = hex(c1), B = hex(c2), steps = Math.max(1, Math.round(w));
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    doc.setFillColor(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
    doc.rect(x + i * sw, y, sw + 0.2, h, 'F');
  }
}

/**
 * data = {
 *   cotNum, cotFecha,
 *   emisor: { email, tel, web, ciudad },
 *   cliente: { nombre, empresa, email, tel, dir },
 *   lineas: [{ n, name, desc, p, total, custom }],
 *   descuento (0-100),
 *   notas (string con líneas separadas por \n)
 * }
 * Devuelve { buffer, total, code }
 */
function buildPdf(data) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS('arial.ttf', ARIAL_B64);
  doc.addFont('arial.ttf', 'arial', 'normal');
  doc.addFont('arial.ttf', 'arial', 'bold');

  const W = 210, H = 297, M = 14, CW = W - 2 * M, R = M + CW;
  const cotNum = data.cotNum || 'JP-000';
  const code = genSecurityCode(cotNum);
  const lines = data.lineas || [];
  const sub = lines.reduce((a, l) => a + (l.total || 0), 0);
  const d = data.descuento || 0;
  const descAmt = sub * d / 100, total = sub - descAmt;

  let y = 0;
  function stampFooter() {
    const by = 270, bh = 14;
    doc.setFillColor(124, 58, 237); doc.rect(M, by, CW, bh, 'F');
    if (LOGO) doc.addImage(LOGO, 'PNG', M + 4, by + 2, 10, 10);
    doc.setFont('arial', 'bold'); doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text('Soluciones TI con enfoque en resultados', M + 18, by + 9);
    doc.setFont('arial', 'normal'); doc.setFontSize(7.5); doc.setTextColor(255, 255, 255);
    doc.text('Código de seguridad: ' + code, R - 4, by + 9, { align: 'right' });
  }
  function ensure(n) {
    if (y + n > 260) {
      doc.addPage(); doc.setFont('arial', 'italic'); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
      doc.text('JP Solutions — Cotización ' + cotNum + ' (continuación)', M, 12);
      doc.setDrawColor(226, 232, 240); doc.line(M, 15, R, 15); stampFooter(); y = 20;
    }
  }

  // ---- Cabecera ----
  doc.addImage(LOGO, 'PNG', M, 11, 18, 18);
  doc.setFont('arial', 'bold'); doc.setFontSize(17); doc.setTextColor(17, 24, 39);
  doc.text('JP SOLUTIONS', M + 36, 18);
  doc.setFont('arial', 'normal'); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139);
  doc.text('Automatización e Inteligencia Artificial', M + 36, 24);
  const emi = data.emisor || {};
  const em = emi.email || '', tel = emi.tel || '', web = emi.web || '', city = emi.ciudad || '';
  doc.setFontSize(8.5); doc.setTextColor(71, 85, 105);
  doc.text(doc.splitTextToSize((em ? ('✉ ' + em + '\n') : '') + (tel ? ('☎ ' + tel + '\n') : '') + (web ? ('🌐 ' + web + '\n') : '') + (city ? ('📍 ' + city) : ''), 80), R, 14, { align: 'right' });
  drawGradient(doc, M, 30, CW, 3, '#3b82f6', '#8b5cf6');

  // ---- Título + meta ----
  y = 44;
  doc.setFont('arial', 'bold'); doc.setFontSize(20); doc.setTextColor(17, 24, 39);
  doc.text('COTIZACIÓN', M, y);
  doc.setFont('arial', 'normal'); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139);
  doc.text('N°: ' + cotNum, R, 40, { align: 'right' });
  doc.text('Fecha: ' + (data.cotFecha || new Date().toISOString().slice(0, 10)), R, 45, { align: 'right' });
  doc.text('Validez: 7 días', R, 50, { align: 'right' });

  // ---- Bloque cliente ----
  y = 60;
  doc.setFillColor(245, 246, 250); doc.roundedRect(M, y - 4, CW, 32, 2, 2, 'F');
  doc.setFont('arial', 'bold'); doc.setFontSize(10); doc.setTextColor(59, 130, 246);
  doc.text('COTIZADO PARA:', M + 4, y);
  doc.setFont('arial', 'normal'); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
  const cl = data.cliente || {};
  const cn = cl.nombre || '—', ce = cl.empresa || '', cle = cl.email || '', clt = cl.tel || '', cld = cl.dir || '';
  let cy = y + 6;
  let clientHeader = (ce && cn && ce.trim().toLowerCase() !== cn.trim().toLowerCase()) ? `${ce}  ·  ${cn}` : (ce || cn || '—');
  doc.text(clientHeader, M + 4, cy); cy += 5.5;
  if (cle) { doc.text('✉ ' + cle, M + 4, cy); cy += 5.5; }
  if (clt) { doc.text('☎ ' + clt, M + 4, cy); cy += 5.5; }
  if (cld) { doc.text('📍 ' + cld, M + 4, cy); }
  y += 34;

  // ---- Tabla ----
  const cols = { n: M, name: M + 10, p: R - 45, t: R };
  doc.setFillColor(30, 41, 59); doc.rect(M, y - 4, CW, 7, 'F');
  doc.setFont('arial', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
  doc.text('#', cols.n, y); doc.text('DESCRIPCIÓN', cols.name, y);
  doc.text('MONTO (USD)', cols.p, y, { align: 'right' });
  doc.text('TOTAL (USD)', cols.t, y, { align: 'right' });
  y += 7;
  if (lines.length === 0) {
    doc.setFont('arial', 'italic'); doc.setFontSize(10); doc.setTextColor(148, 163, 184);
    doc.text('No se seleccionó ningún servicio.', M, y + 2); y += 8;
  }
  lines.forEach((l, i) => {
    doc.setFont('arial', 'normal');
    doc.setFontSize(9.5);
    const label = l.custom ? l.desc : (l.name + ' — ' + l.desc);
    // Limitar el ancho de la descripción a 95 mm (~35-40 caracteres) para que continúe en una segunda línea sin solapar el monto
    const descLines = doc.splitTextToSize(label, 95);
    const rowH = Math.max(9, 4.5 * descLines.length + 2);

    if (i % 2 === 1) { doc.setFillColor(248, 249, 252); doc.rect(M, y - 4, CW, rowH, 'F'); }
    doc.setFont('arial', 'bold'); doc.setFontSize(9.5); doc.setTextColor(30, 41, 59); doc.text(String(l.n), cols.n, y);
    doc.setFont('arial', 'normal');
    doc.text(descLines, cols.name, y);
    doc.setFontSize(9.5);
    doc.text(fmt(l.p), cols.p, y, { align: 'right' });
    doc.text(fmt(l.total), cols.t, y, { align: 'right' });
    y += rowH;
  });

  // ---- Totales ----
  y += 4;
  const tbW = 80, tbX = R - tbW;
  doc.setFillColor(248, 249, 252); doc.roundedRect(tbX, y - 4, tbW, 26, 2, 2, 'F');
  doc.setFont('arial', 'normal'); doc.setFontSize(9.5);
  doc.setTextColor(71, 85, 105); doc.text('Subtotal', tbX + 4, y); doc.setTextColor(30, 41, 59); doc.text(fmt(sub), R - 4, y, { align: 'right' }); y += 6;
  doc.setTextColor(71, 85, 105); doc.text('Descuento (' + d + '%)', tbX + 4, y); doc.setTextColor(30, 41, 59); doc.text('- ' + fmt(descAmt), R - 4, y, { align: 'right' }); y += 8;
  drawGradient(doc, tbX, y - 5, tbW, 7, '#3b82f6', '#8b5cf6');
  doc.setFont('arial', 'bold'); doc.setFontSize(12); doc.setTextColor(255, 255, 255);
  doc.text('TOTAL', tbX + 4, y); doc.text(fmt(total), R - 4, y, { align: 'right' });

  // ---- Notas ----
  y += 14;
  doc.setFont('arial', 'bold'); doc.setFontSize(10); doc.setTextColor(59, 130, 246);
  doc.text('NOTAS Y CONDICIONES', M, y); y += 5;
  doc.setFont('arial', 'normal'); doc.setFontSize(8.8); doc.setTextColor(71, 85, 105);
  (data.notas || '').split('\n').filter(Boolean).forEach(n => { ensure(5); doc.text(doc.splitTextToSize('• ' + n, CW), M, y); y += 4.6; });

  // ---- Cláusula legal fija (Impuestos + USD + BCV + 7 días) ----
  y += 4;
  ensure(22);
  doc.setDrawColor(226, 232, 240); doc.line(M, y - 3, R, y - 3); y += 3;
  doc.setFont('arial', 'bold'); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
  doc.text('CONDICIONES DE LA COTIZACIÓN', M, y); y += 4.6;
  doc.setFont('arial', 'normal'); doc.setFontSize(8.6); doc.setTextColor(71, 85, 105);
  const legal = [
    '• Los servicios cotizados no incluyen ningún tipo de impuestos.',
    '• La presente cotización está expresada en Dólares Americanos (USD).',
    '• La tasa de cambio aplicable será la publicada por el Banco Central de Venezuela (BCV) a la fecha de pago.',
    '• Validez de esta cotización: siete (7) días hábiles a partir de su emisión.'
  ];
  legal.forEach(t => { ensure(5); doc.text(doc.splitTextToSize(t, CW), M, y); y += 4.6; });

  stampFooter();

  const buffer = Buffer.from(doc.output('arraybuffer'));
  return { buffer, total, code };
}

module.exports = { buildPdf, fmt, genSecurityCode };
