/**
 * Handler de Utilidade — Piroquinhas Bot
 * Comandos: !qrcode, !encurtar, !cep, !tiktok, !audio, !som, !perfil, !menu,
 *           !save, !saverec, !clima, !moeda, !calcular, !dado, !piada, !fato,
 *           !traduzir, !morse, !codigomorse, !demorse, !decodificarmorse
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const { fetchBuffer, fetchJson } = require('../fetchurl');
const { convertVideoToSticker } = require('../sticker');

let logger = { level: 'silent' };
let REMOVEBG_KEY = process.env.REMOVEBG_KEY || '';
let _cachedYtDlpPath = null;
let _cachedFfmpegPath = null;

const MORSE_TABLE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', ':': '---...', ';': '-.-.-.', "'": '.----.', '"': '.-..-.', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '@': '.--.-.',
};
const MORSE_REVERSE = Object.entries(MORSE_TABLE).reduce((acc, [key, value]) => { acc[value] = key; return acc; }, {});

function encodeMorse(text) {
  return text.toUpperCase().split('').map((char) => {
    if (char === ' ') return '/';
    return MORSE_TABLE[char] || '?';
  }).join(' ');
}

function decodeMorse(code) {
  return code.trim().split(/\s+/).map((token) => {
    if (token === '/') return ' ';
    return MORSE_REVERSE[token] || '?';
  }).join('').replace(/ {2,}/g, ' ');
}

// ═══════════════════════════════════════════════════════════════
// ─── EXPANSÃO DE URLS ENCURTADAS ────────────────────────────
// ═══════════════════════════════════════════════════════════════

/**
 * Expande URLs encurtadas (vt.tiktok.com, pin.it, etc)
 * Segue redirecionamentos até obter a URL final completa
 * @param {string} urlEncurtada - URL encurtada
 * @returns {Promise<string>} URL expandida ou original se falhar
 */
async function expandirUrl(urlEncurtada) {
  try {
    const response = await axios.head(urlEncurtada, {
      maxRedirects: 5,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.request.res.responseUrl || urlEncurtada;
  } catch (error) {
    try {
      // Fallback: tentar com GET ao invés de HEAD
      const response = await axios.get(urlEncurtada, {
        maxRedirects: 5,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response.request.res.responseUrl || urlEncurtada;
    } catch {
      return urlEncurtada; // Se falhar completamente, retorna original
    }
  }
}

function setLogger(newLogger) {
  logger = newLogger;
}

function setRemoveBgKey(key) {
  REMOVEBG_KEY = key;
}

// ═══════════════════════════════════════════════════════════════
// ─── HELPERS: ffmpeg / ffprobe / yt-dlp ──────────────────────
// ═══════════════════════════════════════════════════════════════

function getFfmpegPath() {
  if (_cachedFfmpegPath && fs.existsSync(_cachedFfmpegPath)) return _cachedFfmpegPath;

  // Melhor forma: require('ffmpeg-static') já retorna o caminho correto
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      _cachedFfmpegPath = ffmpegStatic;
      return ffmpegStatic;
    }
  } catch {}

  // Fallbacks manuais
  const candidates = process.platform === 'win32' ? [
    path.resolve(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),
    path.resolve(__dirname, '../node_modules/.bin/ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ] : [
    path.resolve(__dirname, '../node_modules/ffmpeg-static/ffmpeg'),
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      _cachedFfmpegPath = c;
      return c;
    }
  }

  return 'ffmpeg'; // fallback para PATH do sistema
}

function getFfprobePath() {
  try {
    const ffprobeStatic = require('ffprobe-static');
    if (ffprobeStatic?.path && fs.existsSync(ffprobeStatic.path)) return ffprobeStatic.path;
  } catch {}

  const candidates = process.platform === 'win32' ? [
    path.resolve(__dirname, '../node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe'),
  ] : [
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return 'ffprobe';
}

function getYtDlpArgs() {
  const args = [];

  const ffmpegPath = getFfmpegPath();
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    args.push('--ffmpeg-location', path.dirname(ffmpegPath));
  }

  try {
    const { execSync } = require('child_process');
    const nodeExe = execSync(
      process.platform === 'win32' ? 'where node' : 'which node',
      { timeout: 3000 }
    ).toString().trim().split('\n')[0].trim();
    if (nodeExe) args.push('--js-runtimes', `node:${nodeExe}`);
  } catch {}

  return args;
}

function chunkLongText(text, limit = 4000) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current.trim());
      current = `${line}\n`;
    } else {
      current += `${line}\n`;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getYtDlpPath() {
  if (_cachedYtDlpPath && fs.existsSync(_cachedYtDlpPath)) return _cachedYtDlpPath;

  const { execSync } = require('child_process');
  const https = require('https');

  try {
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    const p = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0].trim();
    if (p) { _cachedYtDlpPath = p; return p; }
  } catch {}

  const candidates = process.platform === 'win32' ? [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    'C:\\Python312\\Scripts\\yt-dlp.exe',
    path.resolve(__dirname, '../yt-dlp.exe'),
    path.resolve(__dirname, 'yt-dlp.exe'),
  ] : [
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.resolve(__dirname, '../yt-dlp'),
    path.resolve(__dirname, 'yt-dlp'),
  ];

  for (const c of candidates) {
    try { if (fs.existsSync(c)) { _cachedYtDlpPath = c; return c; } } catch {}
  }

  if (process.platform === 'win32') {
    const downloadPath = path.resolve(__dirname, '../yt-dlp.exe');
    if (!fs.existsSync(downloadPath)) {
      console.log('yt-dlp não encontrado. Baixando automaticamente...');
      try {
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(downloadPath);
          https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', (err) => { try { fs.unlinkSync(downloadPath); } catch {} reject(err); });
        });
        console.log('✅ yt-dlp.exe baixado em', downloadPath);
      } catch (e) {
        console.warn('Não foi possível baixar yt-dlp.exe:', e.message);
      }
    }
    if (fs.existsSync(downloadPath)) { _cachedYtDlpPath = downloadPath; return downloadPath; }
  }

  return 'yt-dlp';
}

// ═══════════════════════════════════════════════════════════════
// ─── !menu ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function handleMenu(sock, msg, jid, caption, getPrefix, author) {
  const P = getPrefix(jid);
  const now = new Date();
  const hour = now.getHours();
  const minute = String(now.getMinutes()).padStart(2, '0');
  let greeting = 'Olá';
  if (hour < 12) greeting = 'Bom dia';
  else if (hour < 18) greeting = 'Boa tarde';
  else greeting = 'Boa noite';
  const timeStr = `${hour}:${minute}`;
  const userMention = author ? `@${author}` : '';

  const menu = `╭━━━━ ◦ ❖ ◦ ━━━━━╮
       PIROQUINHAS
╰━━━━ ◦ ❖ ◦ ━━━━━╯

- 🌇 ${greeting} ${userMention}, são ${timeStr}

🎨 FIGURINHAS & LOGOS
▸ ${P}menufig
▸ ${P}menuefeitos

📥 DOWNLOADS
▸ ${P}menubaixar

🛡️ ADMINISTRAÇÃO & SEGURANÇA
▸ ${P}menuadm
▸ ${P}reportar (marque a msg)

🎮 DIVERSÃO & ENTRETENIMENTO
▸ ${P}menujogos
▸ ${P}menuperfil
▸ ${P}menurelacionamento
▸ ${P}menuaniversario
▸ ${P}menubrincadeiras
▸ ${P}alteradores

🔧 UTILIDADES
▸ ${P}menuutil
╰━━━━━━━⊰ ✧ ⊱━━━━━━━╯`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
  console.log('📋 Menu enviado');
}

// ─── !menuutil ────────────────────────────────────────────────
async function handleMenuUtil(sock, msg, jid, getPrefix) {
  const P = getPrefix(jid);
  const menu = `╭━━━━━━━━━━━━━━━━━━╮
│  🔧 *MENU UTILIDADES* 🔧
│
│ 📍 ${P}cep _(número)_
│ 🔗 ${P}encurtar _(link)_
│ 🔳 ${P}qrcode _(texto)_
│ 🌤️ ${P}clima _(cidade)_
│ 💱 ${P}moeda _(valor) (de) (para)_
│ 🧮 ${P}calcular _(expressão)_
│ 🎲 ${P}dado _(lados)_
│ 😂 ${P}piada
│ 🤓 ${P}fato
│ 🌐 ${P}traduzir _(idioma) (texto)_
│ 📡 ${P}codigomorse _(texto)_
│ 📡 ${P}morse _(texto)_
│ 📡 ${P}decodificarmorse _(código)_
│ 📡 ${P}demorse _(código)_
│
╰━━━━━━━⊰ ✧ ⊱━━━━━━━╯`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
}

// ─── !menujogos ──────────────────────────────────────────────
async function handleMenuJogos(sock, msg, jid, getPrefix) {
  const P = getPrefix(jid);
  const menu = `╭━━━━━━━━━━━━━━━━━━╮
│  🎮 *MENU JOGOS & DIVERSÃO* 🎮
│
│ ▸ ${P}brincadeiras
│ ▸ ${P}sistemgold
│ ▸ ${P}sistempet
│ ▸ ${P}menugold
│ ▸ ${P}menupet
│ ▸ ${P}iniciar_forca
│ ▸ ${P}jogodavelha _(@)_
│ ▸ ${P}ppt _(pedra/papel/tesoura)_
│ ▸ ${P}eununca
│ ▸ ${P}levelon
│ ▸ ${P}ranklevel
│ ▸ ${P}level
│ ▸ ${P}morte
│ ▸ ${P}roletarussa
│ ▸ ${P}roletarussa2
│ ▸ ${P}roletarussa3
│ ▸ ${P}tiro
│ ▸ ${P}falta
│ ▸ ${P}baterfalta
│ ▸ ${P}quiz
│ ▸ ${P}pontos
│ ▸ ${P}rankjogos
│ ▸ ${P}anagrama
│
╰━━━━━━━⊰ ✧ ⊱━━━━━━━╯`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
  console.log('🎮 Menu jogos enviado');
}

// ─── !alteradores ────────────────────────────────────────────
async function handleAlteradores(sock, msg, jid) {
  const menu = `🎛️ ALTERADORES 🎛️

🎬 Vídeos:
 ▸ .videolento
 ▸ .videorapido
 ▸ .videocontrario
 ▸ .reversevideo

🎵 Áudios:
 ▸ .audiolento
 ▸ .audiorapido
 ▸ .grave
 ▸ .esquilo
 ▸ .bass
 ▸ .vozmenino
 ▸ .vozgrossa
 ▸ .vozmulher
 ▸ .audioreverse

🎭 Voz:
 ▸ .vozrobo
 ▸ .vozalien
 ▸ .vozvelho
 ▸ .vozcrianca
 ▸ .vozdemonio

🔊 Ambiente:
 ▸ .eco
 ▸ .caverna
 ▸ .telefone
 ▸ .radio
 ▸ .megafone
 ▸ .underwater`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
  console.log('🎛️ Menu alteradores enviado');
}

// ─── !menurelacionamento ─────────────────────────────────────
async function handleMenuRelacionamento(sock, msg, jid, getPrefix) {
  const P = getPrefix(jid);
  const menu = `❤️ *MENU DE RELACIONAMENTO* ❤️

💑 *COMANDOS DE CASAMENTO:*
💍 ${P}casar @pessoa — Pedir em casamento
✅ ${P}euaceito — Aceitar pedido
❌ ${P}eurecuso — Recusar pedido
🚫 ${P}cancelarpedido — Cancelar seu pedido
💔 ${P}cancelarcasamento — Divórcio _(bloqueia por 7 dias)_

💐 *COMANDOS DIÁRIOS (1x/dia cada):*
🌹 ${P}flores — Enviar flores _(+5 XP)_
🍬 ${P}doces — Enviar doces _(+5 XP)_
💌 ${P}carta — Enviar carta _(+5 XP)_
🎁 ${P}mimo — Fazer mimo _(+5 XP)_
💋 ${P}beijo — Dar beijo _(+5 XP)_

📊 *INFORMAÇÕES:*
🏆 ${P}rankcasais — Ver ranking dos casais

_"O amor cresce com dedicação diária"_ 💕`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
  console.log('❤️ Menu relacionamento enviado');
}

// ─── !menubaixar ─────────────────────────────────────────────
async function handleMenuBaixar(sock, msg, jid, getPrefix) {
  const P = getPrefix ? getPrefix(jid) : '!';
  const menu = `╭━━━━━━━━━━━━━━━━━━╮
│  📥 *MENU DOWNLOADS* 📥
│
│ ▸ ${P}som _(nome da música)_
│ ▸ ${P}audio _(link)_
│ ▸ ${P}tiktok _(link)_
│ ▸ ${P}save _(link)_
│ ▸ ${P}saverec _(link)_ _(recorta 10s p/ sticker)_
│ ▸ ${P}pinterest _(nome ou link)_
│
╰━━━━━━━━⊰ ✧ ⊱━━━━━━━╯`;
  await sock.sendMessage(jid, { text: menu }, { quoted: msg });
  console.log('📥 Menu downloads enviado');
}

// ═══════════════════════════════════════════════════════════════
// ─── UTILIDADES BÁSICAS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ─── !qrcode ─────────────────────────────────────────────────
async function handleQrcode(sock, msg, jid, caption) {
  const texto = caption.replace(/^[!.,\/]qrcode\s*/i, '').trim();
  if (!texto) {
    await sock.sendMessage(jid, { text: '⚠️ Digite o texto ou link.\nExemplo: *!qrcode https://google.com*' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  const QRCodeLib = require('qrcode');
  const qrBuffer = await QRCodeLib.toBuffer(texto, { type: 'png', width: 512, margin: 2 });
  await sock.sendMessage(jid, { image: qrBuffer, caption: `🔳 QR Code gerado!\n\n_${texto.slice(0, 60)}_` }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
}

// ─── !encurtar ───────────────────────────────────────────────
async function handleEncurtar(sock, msg, jid, caption) {
  const link = caption.replace(/^[!.,\/]encurtar\s*/i, '').trim();
  if (!link || !link.startsWith('http')) {
    await sock.sendMessage(jid, { text: '⚠️ Envie um link válido.' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    const respBuf = await fetchBuffer(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(link)}`);
    const encurtado = respBuf.toString('utf8').trim();
    if (!encurtado.startsWith('http')) throw new Error('Resposta inválida');
    await sock.sendMessage(jid, { text: `🔗 *Link encurtado:*\n\n${encurtado}` }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch {
    await sock.sendMessage(jid, { text: '❌ Não consegui encurtar o link.' }, { quoted: msg });
  }
}

// ─── !cep ────────────────────────────────────────────────────
async function handleCep(sock, msg, jid, caption) {
  const cep = caption.replace(/^[!.,\/]cep\s*/i, '').trim().replace(/\D/g, '');
  if (!cep || cep.length !== 8) {
    await sock.sendMessage(jid, { text: '⚠️ Digite um CEP válido (8 dígitos).' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    const respBuf = await fetchBuffer(`https://viacep.com.br/ws/${cep}/json/`);
    const data = JSON.parse(respBuf.toString('utf8'));
    if (data.erro) {
      await sock.sendMessage(jid, { text: `❌ CEP *${cep}* não encontrado.` }, { quoted: msg });
      return;
    }
    const texto = `📮 *CEP ${data.cep}*\n\n🏠 *Logradouro:* ${data.logradouro || '—'}\n🏘️ *Bairro:* ${data.bairro || '—'}\n🏙️ *Cidade:* ${data.localidade} — ${data.uf}\n📡 *DDD:* ${data.ddd || '—'}`;
    await sock.sendMessage(jid, { text: texto }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch {
    await sock.sendMessage(jid, { text: '❌ Não consegui consultar o CEP.' }, { quoted: msg });
  }
}

// ─── !clima ──────────────────────────────────────────────────
async function handleClima(sock, msg, jid, caption) {
  const cidade = caption.replace(/^[!.,\/]clima\s*/i, '').trim();
  if (!cidade) {
    await sock.sendMessage(jid, { text: '⚠️ Digite o nome da cidade.\nExemplo: *!clima São Paulo*' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    // API pública wttr.in (sem key)
    const url = `https://wttr.in/${encodeURIComponent(cidade)}?format=j1`;
    const data = await fetchJson(url);
    const cur = data.current_condition?.[0];
    if (!cur) throw new Error('Sem dados');
    const desc = cur.weatherDesc?.[0]?.value || '—';
    const temp = cur.temp_C;
    const sens = cur.FeelsLikeC;
    const umid = cur.humidity;
    const vento = cur.windspeedKmph;
    const area = data.nearest_area?.[0];
    const local = area ? `${area.areaName?.[0]?.value || ''}, ${area.country?.[0]?.value || ''}` : cidade;

    const emoji = Number(temp) >= 30 ? '🥵' : Number(temp) >= 20 ? '☀️' : Number(temp) >= 10 ? '🌤️' : '🥶';

    const texto = `${emoji} *Clima em ${local}*\n\n🌡️ *Temperatura:* ${temp}°C\n🤔 *Sensação:* ${sens}°C\n💧 *Umidade:* ${umid}%\n💨 *Vento:* ${vento} km/h\n📋 *Condição:* ${desc}`;
    await sock.sendMessage(jid, { text: texto }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Não consegui obter o clima de *${cidade}*.\nVerifique o nome da cidade.` }, { quoted: msg });
  }
}

// ─── !moeda ──────────────────────────────────────────────────
async function handleMoeda(sock, msg, jid, caption) {
  // uso: !moeda 100 USD BRL
  const parts = caption.replace(/^[!.,\/]moeda\s*/i, '').trim().split(/\s+/);
  if (parts.length < 3) {
    await sock.sendMessage(jid, { text: '⚠️ Uso: *!moeda [valor] [de] [para]*\nExemplo: *!moeda 100 USD BRL*' }, { quoted: msg });
    return;
  }
  const valor = parseFloat(parts[0]);
  const de = parts[1].toUpperCase();
  const para = parts[2].toUpperCase();
  if (isNaN(valor)) {
    await sock.sendMessage(jid, { text: '⚠️ Valor inválido. Exemplo: *!moeda 100 USD BRL*' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    const url = `https://api.exchangerate-api.com/v4/latest/${de}`;
    const data = await fetchJson(url);
    const taxa = data.rates?.[para];
    if (!taxa) throw new Error('Par de moeda inválido');
    const resultado = (valor * taxa).toFixed(2);
    const texto = `💱 *Conversão de Moeda*\n\n💵 ${valor} ${de} = *${resultado} ${para}*\n\n📊 Taxa: 1 ${de} = ${taxa.toFixed(4)} ${para}\n\n_Fonte: exchangerate-api.com_`;
    await sock.sendMessage(jid, { text: texto }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch {
    await sock.sendMessage(jid, { text: `❌ Não consegui converter *${de}* para *${para}*.\nVerifique os códigos de moeda (ex: USD, BRL, EUR).` }, { quoted: msg });
  }
}

// ─── !calcular ───────────────────────────────────────────────
async function handleCalcular(sock, msg, jid, caption) {
  const expr = caption.replace(/^[!.,\/]calcular\s*/i, '').trim();
  if (!expr) {
    await sock.sendMessage(jid, { text: '⚠️ Digite uma expressão.\nExemplo: *!calcular 15 * 3 + 2*' }, { quoted: msg });
    return;
  }
  try {
    // Segurança: só permite números, operadores e parênteses
    if (!/^[\d\s\+\-\*\/\.\(\)\%\^]+$/.test(expr)) {
      await sock.sendMessage(jid, { text: '⚠️ Expressão inválida. Use apenas números e operadores (+, -, *, /, %, ^).' }, { quoted: msg });
      return;
    }
    // Substitui ^ por ** para potência
    const safeExpr = expr.replace(/\^/g, '**');
    // eslint-disable-next-line no-new-func
    const resultado = Function(`'use strict'; return (${safeExpr})`)();
    await sock.sendMessage(jid, { text: `🧮 *Calculadora*\n\n📝 Expressão: \`${expr}\`\n✅ Resultado: *${resultado}*` }, { quoted: msg });
  } catch {
    await sock.sendMessage(jid, { text: '❌ Expressão inválida ou erro de cálculo.' }, { quoted: msg });
  }
}

// ─── !dado ───────────────────────────────────────────────────
async function handleDado(sock, msg, jid, caption) {
  const arg = caption.replace(/^[!.,\/]dado\s*/i, '').trim();
  const lados = parseInt(arg) || 6;
  if (lados < 2 || lados > 1000) {
    await sock.sendMessage(jid, { text: '⚠️ Número de lados deve ser entre 2 e 1000.' }, { quoted: msg });
    return;
  }
  const resultado = Math.floor(Math.random() * lados) + 1;
  await sock.sendMessage(jid, { text: `🎲 *Dado de ${lados} lados*\n\nResultado: *${resultado}*` }, { quoted: msg });
}

// ─── !piada ──────────────────────────────────────────────────
async function handlePiada(sock, msg, jid) {
  const piadas = [
    'Por que o livro de matemática foi ao psicólogo?\nPorque tinha muitos problemas! 😂',
    'O que o zero disse para o oito?\nQue cinto bonito! 😆',
    'Por que o computador foi ao médico?\nPorque estava com vírus! 🤣',
    'O que o pato disse para a pata?\nPato-cê é linda! 🦆',
    'Por que o fantasma não mente?\nPorque ele é trans-pa-rente! 👻',
    'O que é um elefante na árvore?\nUm galho de elefante! 🐘',
    'Por que o espantalho ganhou um prêmio?\nPorque era o melhor do campo! 🌾',
    'Qual o animal mais antigo?\nA zebra. Porque ainda está em preto e branco! 🦓',
    'Por que o vampiro virou vegetariano?\nPorque o Drácula ficou enjoado! 🧛',
    'O que o oceano disse para a praia?\nNada, apenas deu uma onda! 🌊',
  ];
  const piada = piadas[Math.floor(Math.random() * piadas.length)];
  await sock.sendMessage(jid, { text: `😂 *Piada do Dia*\n\n${piada}` }, { quoted: msg });
}

// ─── !fato ───────────────────────────────────────────────────
async function handleFato(sock, msg, jid) {
  const fatos = [
    '🤓 Os polvos têm três corações e sangue azul.',
    '🤓 Uma colher de sopa de estrela de nêutrons pesaria cerca de um bilhão de toneladas.',
    '🤓 Mel não estraga nunca. Arqueólogos encontraram mel com 3.000 anos e ainda comestível.',
    '🤓 O cérebro humano produz energia suficiente para acender uma pequena lâmpada.',
    '🤓 As abelhas podem reconhecer rostos humanos como os humanos reconhecem.',
    '🤓 A maioria dos astronautas fica alguns centímetros mais alta no espaço.',
    '🤓 O coração de uma baleia azul bate apenas 2 vezes por minuto.',
    '🤓 As digitais dos koalas são quase idênticas às dos humanos.',
    '🤓 O WiFi e o Bluetooth foram inventados pelo mesmo australiano.',
    '🤓 Existe um lago na Austrália naturalmente cor-de-rosa chamado Hillier.',
    '🤓 A língua portuguesa tem mais de 250 milhões de falantes nativos no mundo.',
    '🤓 O Brasil é o 5º maior país do mundo em território.',
  ];
  const fato = fatos[Math.floor(Math.random() * fatos.length)];
  await sock.sendMessage(jid, { text: `📚 *Fato Incrível*\n\n${fato}` }, { quoted: msg });
}

// ─── !traduzir ───────────────────────────────────────────────
async function handleTraduzir(sock, msg, jid, caption) {
  // uso: !traduzir en Olá como vai você
  const raw = caption.replace(/^[!.,\/]traduzir\s*/i, '').trim();
  const parts = raw.split(/\s+/);
  // Se primeiro argumento parece código de idioma (2-3 letras), usa como destino
  let idioma = 'en';
  let texto = raw;
  if (parts.length >= 2 && /^[a-z]{2,3}$/i.test(parts[0])) {
    idioma = parts[0].toLowerCase();
    texto = parts.slice(1).join(' ');
  }
  if (!texto) {
    await sock.sendMessage(jid, { text: '⚠️ Use: *!traduzir [idioma] [texto]*\nExemplo: *!traduzir en Olá mundo*\nIdiomas: en (inglês), es (espanhol), fr (francês), de (alemão), pt (português)...' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  try {
    // MyMemory API (gratuita, sem key)
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}&langpair=pt|${idioma}`;
    const data = await fetchJson(url);
    const traduzido = data?.responseData?.translatedText;
    if (!traduzido || traduzido === texto) throw new Error('Sem tradução');
    const nomesIdioma = { en: 'Inglês', es: 'Espanhol', fr: 'Francês', de: 'Alemão', it: 'Italiano', ja: 'Japonês', zh: 'Chinês', ru: 'Russo', ar: 'Árabe', pt: 'Português' };
    const nomeIdioma = nomesIdioma[idioma] || idioma.toUpperCase();
    await sock.sendMessage(jid, { text: `🌐 *Tradução para ${nomeIdioma}*\n\n📝 Original: _${texto}_\n\n✅ Traduzido: *${traduzido}*` }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  } catch {
    await sock.sendMessage(jid, { text: '❌ Não consegui traduzir o texto. Tente novamente.' }, { quoted: msg });
  }
}

async function handleCodigoMorse(sock, msg, jid, caption) {
  const texto = caption.replace(/^[!.,\/]?(codigomorse|morse)\s*/i, '').trim();
  if (!texto) {
    await sock.sendMessage(jid, { text: '⚠️ Use: *!morse texto* ou *!codigomorse texto*' }, { quoted: msg });
    return;
  }

  const morse = encodeMorse(texto);
  await sock.sendMessage(jid, { text: `📡 *Morse*\n\n${morse}` }, { quoted: msg });
}

async function handleDecodificarMorse(sock, msg, jid, caption) {
  const texto = caption.replace(/^[!.,\/]?(decodificarmorse|demorse)\s*/i, '').trim();
  if (!texto) {
    await sock.sendMessage(jid, { text: '⚠️ Use: *!demorse código* ou *!decodificarmorse código*' }, { quoted: msg });
    return;
  }

  const decoded = decodeMorse(texto);
  await sock.sendMessage(jid, { text: `📡 *Texto*\n\n${decoded}` }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════
// ─── DOWNLOADS ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ─── !save ───────────────────────────────────────────────────
async function handleSave(sock, msg, jid, caption) {
  let link = caption.replace(/^[!.,\/]save\s*/i, '').trim();
  if (!link || !link.startsWith('http')) {
    await sock.sendMessage(jid, { text: '⚠️ Envie um link válido para baixar. Exemplo: *!save https://...*' }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  // Expandir links encurtados
  const isShortened = /vt\.tiktok\.com|vm\.tiktok\.com|pin\.it|t\.co|bit\.ly|tinyurl\.com/i.test(link);
  if (isShortened) {
    try {
      const expandedLink = await expandirUrl(link);
      if (expandedLink && expandedLink !== link) {
        console.log(`🔗 Link expandido: ${link} → ${expandedLink}`);
        link = expandedLink;
      }
    } catch (e) {
      console.log(`⚠️ Não consegui expandir o link: ${e.message}`);
      // Continua com o link original mesmo assim
    }
  }

  const ytdlp = await getYtDlpPath();
  let meta = null;
  setImmediate(() => {
    try {
      const { execFile } = require('child_process');
      const args = [...getYtDlpArgs(), '--no-playlist', '--skip-download', '--print-json', '-o', 'dummy', link];
      execFile(ytdlp, args, { timeout: 10000 }, (err, stdout) => {
        if (!err && stdout) { try { meta = JSON.parse(stdout.trim()); } catch {} }
      });
    } catch {}
  });

  const { execFile } = require('child_process');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  const tmpId = randomUUID();
  const outTemplate = path.join(tmpdir(), `${tmpId}_raw.%(ext)s`);

  const dlOk = await new Promise((resolve) => {
    const baseArgs = [...getYtDlpArgs(), '--no-playlist', '--max-filesize', '200m'];
    if (link.includes('pinterest') || link.includes('pin.it')) {
      baseArgs.push('--referer', 'https://www.pinterest.com', '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    }
    baseArgs.push('-o', outTemplate, link);
    execFile(ytdlp, baseArgs, { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) { console.log('yt-dlp save err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!dlOk) { await sock.sendMessage(jid, { text: '❌ Não consegui baixar o conteúdo.' }, { quoted: msg }); return; }

  const base = outTemplate.replace('.%(ext)s', '');
  const exts = ['.mp4', '.mkv', '.webm', '.mov', '.mp3', '.m4a', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.opus', '.ogg', '.pdf', '.zip', '.txt'];
  let filePath = null;
  for (const e of exts) { const p = base + e; if (fs.existsSync(p)) { filePath = p; break; } }

  if (!filePath) { await sock.sendMessage(jid, { text: '❌ Arquivo baixado não encontrado.' }, { quoted: msg }); return; }

  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch { await sock.sendMessage(jid, { text: '❌ Erro ao ler o arquivo baixado.' }, { quoted: msg }); return; }
  if (buffer.length < 1000) { await sock.sendMessage(jid, { text: '❌ Conteúdo baixado está vazio ou muito pequeno.' }, { quoted: msg }); return; }
  try { fs.unlinkSync(filePath); } catch {}

  const sizeLimit = 64 * 1024 * 1024;
  let name = path.basename(filePath);
  let lower = filePath.toLowerCase();

  const videoExt = lower.match(/\.(mp4|mov|webm|mkv)$/);
  if (videoExt) {
    try {
      const ffmpegBin = getFfmpegPath();
      const inPath = path.join(tmpdir(), `save_in_${Date.now()}${videoExt[0]}`);
      const outPath = path.join(tmpdir(), `save_out_${Date.now()}.mp4`);
      fs.writeFileSync(inPath, buffer);
      const convertOk = await new Promise((resolve) => {
        execFile(ffmpegBin, [
          '-y', '-i', inPath,
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-r', '30',
          '-profile:v', 'baseline', '-level', '3.0',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath
        ], { timeout: 120000, maxBuffer: 1024 * 1024 * 50 }, (err, _stdout, stderr) => {
          if (err) { console.log('ffmpeg convert err:', stderr?.slice(-400) || err.message); resolve(false); } else resolve(true);
        });
      });
      if (convertOk && fs.existsSync(outPath)) {
        const converted = fs.readFileSync(outPath);
        if (converted.length > 1000) { buffer = converted; lower = outPath.toLowerCase(); name = name.replace(videoExt[0], '.mp4'); }
        try { fs.unlinkSync(outPath); } catch {}
      }
      try { fs.unlinkSync(inPath); } catch {}
    } catch (e) { console.log('Erro na conversão de vídeo:', e.message); }
  }

  let infoText = '';
  if (meta) {
    const title = meta.title || '';
    const uploader = meta.uploader || meta.channel || '';
    const durSec = meta.duration || 0;
    const duration = durSec ? `${Math.floor(durSec/60)}:${String(durSec%60).padStart(2,'0')}` : '';
    const views = meta.view_count ? Number(meta.view_count).toLocaleString('pt-BR') : '';
    if (title) infoText += `📌 *Título:* ${title}\n`;
    if (uploader) infoText += `👤 *Canal:* ${uploader}\n`;
    if (duration) infoText += `⏱️ *Duração:* ${duration}\n`;
    if (views) infoText += `👁️ *Visualizações:* ${views}\n`;
    if (infoText) infoText += '\n';
  }
  const makeCaption = (text) => infoText ? infoText + text : text;

  if (buffer.length > sizeLimit) {
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption: makeCaption('📄 Arquivo muito grande — enviado como documento.') }, { quoted: msg });
  } else if (lower.match(/\.(jpg|jpeg|png|webp|gif)$/)) {
    await sock.sendMessage(jid, { image: buffer, caption: makeCaption('🖼️ Aqui está a imagem') }, { quoted: msg });
  } else if (lower.match(/\.(mp4|mov)$/)) {
    try {
      await sock.sendMessage(jid, { video: buffer, mimetype: 'video/mp4', caption: makeCaption('🎬 Aqui está o vídeo') }, { quoted: msg });
    } catch (e) {
      await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption: makeCaption('📄 Arquivo de vídeo enviado como documento.') }, { quoted: msg });
    }
  } else if (lower.match(/\.(webm|mkv)$/)) {
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption: makeCaption('📄 Vídeo enviado como documento.') }, { quoted: msg });
  } else if (lower.match(/\.(mp3|m4a|opus|ogg)$/)) {
    if (infoText) await sock.sendMessage(jid, { text: infoText }, { quoted: msg });
    await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption: makeCaption('📄 Aqui está o arquivo') }, { quoted: msg });
  }

  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
}

// ─── !saverec ────────────────────────────────────────────────
async function handleSaveRec(sock, msg, jid, caption) {
  let link = caption.replace(/^[!.,\/]saverec\s*/i, '').trim();
  if (!link || !link.startsWith('http')) {
    await sock.sendMessage(jid, { text: '⚠️ Envie um link válido. Exemplo: *!saverec https://...*' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  // Expandir links encurtados
  const isShortened = /vt\.tiktok\.com|vm\.tiktok\.com|pin\.it|t\.co|bit\.ly|tinyurl\.com/i.test(link);
  if (isShortened) {
    try {
      const expandedLink = await expandirUrl(link);
      if (expandedLink && expandedLink !== link) {
        console.log(`🔗 Link expandido: ${link} → ${expandedLink}`);
        link = expandedLink;
      }
    } catch (e) {
      console.log(`⚠️ Não consegui expandir o link: ${e.message}`);
    }
  }

  const ytdlp = await getYtDlpPath();
  const { execFile } = require('child_process');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  const tmpId = randomUUID();
  const outTemplate = path.join(tmpdir(), `${tmpId}_raw.%(ext)s`);

  const dlOk = await new Promise((resolve) => {
    const args = [...getYtDlpArgs(), '--no-playlist', '--max-filesize', '200m'];
    if (link.includes('pinterest') || link.includes('pin.it')) {
      args.push('--referer', 'https://www.pinterest.com', '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    }
    args.push('-o', outTemplate, link);
    execFile(ytdlp, args, { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) { console.log('yt-dlp saverec err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!dlOk) { await sock.sendMessage(jid, { text: '❌ Não consegui baixar o conteúdo.' }, { quoted: msg }); return; }

  const base = outTemplate.replace('.%(ext)s', '');
  let filePath = null;
  for (const e of ['.mp4', '.mkv', '.webm', '.mov']) { const p = base + e; if (fs.existsSync(p)) { filePath = p; break; } }
  if (!filePath) { await sock.sendMessage(jid, { text: '❌ Arquivo baixado não encontrado.' }, { quoted: msg }); return; }

  const ffmpegBin = getFfmpegPath();
  const tmpOut = path.join(tmpdir(), `${tmpId}_rec.mp4`);
  try {
    await new Promise((resolve) => {
      execFile(ffmpegBin, ['-y', '-i', filePath, '-t', '10', '-vf', 'scale=512:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', tmpOut], { timeout: 120000 }, (err) => {
        if (!err && fs.existsSync(tmpOut)) filePath = tmpOut;
        resolve();
      });
    });
  } catch (e) { console.log('ffmpeg saverec err:', e.message); }

  const buffer = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  if (buffer.length > 64 * 1024 * 1024) {
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: name, caption: '📄 Vídeo muito grande — enviado como documento.' }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, { video: buffer, mimetype: 'video/mp4', caption: '🎬 Aqui está o vídeo recortado!' }, { quoted: msg });
  }

  try {
    const stickerBuffer = await convertVideoToSticker(buffer);
    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
  } catch (e) { console.log('sticker conversion err:', e.message); }

  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
}

// ─── !tiktok ─────────────────────────────────────────────────
async function handleTiktok(sock, msg, jid, caption, getPrefix) {
  const P = getPrefix(jid);
  let link = caption.replace(/^[!.,\/]tiktok2?\s*/i, '').trim();
  if (!link || !link.startsWith('http')) {
    await sock.sendMessage(jid, { text: `⚠️ Envie o link do vídeo.\nExemplo: *${P}tiktok https://vm.tiktok.com/xxx*` }, { quoted: msg });
    return;
  }

  // Expandir links encurtados (vt.tiktok.com, vm.tiktok.com, etc)
  const isShortened = /vt\.tiktok\.com|vm\.tiktok\.com/i.test(link);
  if (isShortened) {
    try {
      const expandedLink = await expandirUrl(link);
      if (expandedLink && expandedLink !== link) {
        console.log(`🔗 Link TikTok expandido: ${link} → ${expandedLink}`);
        link = expandedLink;
      }
    } catch (e) {
      console.log(`⚠️ Não consegui expandir link TikTok: ${e.message}`);
    }
  }

  const ytdlp = await getYtDlpPath();
  let meta = null;
  const { tmpdir } = require('os');
  const tiktokCookiesEnv = process.env.TIKTOK_COOKIES?.trim();
  let cookieFilePath = null;
  let cookieTempFile = null;
  
  // Debug: Verificar se cookies estão disponíveis
  if (tiktokCookiesEnv) {
    console.log(`✅ TIKTOK_COOKIES encontrado em process.env (${tiktokCookiesEnv.length} bytes)`);
    cookieTempFile = path.join(tmpdir(), `tiktok_cookies_${require('crypto').randomUUID()}.txt`);
    try { 
      fs.writeFileSync(cookieTempFile, tiktokCookiesEnv, 'utf8'); 
      console.log(`✅ Arquivo de cookies criado: ${cookieTempFile}`);
    } catch (e) { 
      console.log('❌ Erro ao gravar cookie TikTok em temp:', e.message); 
    }
    cookieFilePath = cookieTempFile;
  } else {
    console.log('⚠️ TIKTOK_COOKIES não encontrado em process.env');
    const localCookies = path.join(__dirname, '../../tiktok_cookies.txt');
    if (fs.existsSync(localCookies)) {
      console.log(`✅ Usando arquivo local de cookies: ${localCookies}`);
      cookieFilePath = localCookies;
    } else {
      console.log(`⚠️ Nenhum arquivo de cookies encontrado em: ${localCookies}`);
    }
  }
  
  if (!cookieFilePath) {
    console.log('⚠️ AVISO: Bot vai tentar download SEM cookies (pode falhar)');
  }

  const cleanupCookieFile = () => {
    if (cookieTempFile) {
      try { fs.unlinkSync(cookieTempFile); } catch {}
      cookieTempFile = null;
    }
  };

  try {
    meta = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      let args = [...getYtDlpArgs(), '--no-playlist', '--skip-download', '--print-json', '-o', 'dummy', link];
      if (cookieFilePath) args.push('--cookies', cookieFilePath);
      execFile(ytdlp, args, { timeout: 30000 }, (err, stdout) => {
        if (!err && stdout) { try { resolve(JSON.parse(stdout.trim())); } catch {} }
        resolve(null);
      });
    });
  } catch {}

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  console.log(`🎵 tiktok: baixando ${link}`);

  const { execFile } = require('child_process');
  const { randomUUID } = require('crypto');
  const ffmpegBin = getFfmpegPath();
  const tmpId = randomUUID();
  const rawPath = path.join(tmpdir(), `${tmpId}_raw.mp4`);
  const outPath = path.join(tmpdir(), `${tmpId}_out.mp4`);

  let dlStderr = '';
  const dlOk = await new Promise((resolve) => {
    const args = [...getYtDlpArgs(), '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4'];
    if (cookieFilePath) {
      args.push('--cookies', cookieFilePath);
      console.log(`🍪 Usando cookies no download TikTok: ${cookieFilePath}`);
    } else {
      console.log(`⚠️ Download TikTok SEM cookies - pode dar erro 403`);
    }
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
    args.push('--referer', 'https://www.tiktok.com/');
    args.push('-o', rawPath, link);
    console.log(`🎬 Iniciando download: ${link}`);
    execFile(ytdlp, args, { timeout: 60000 }, (err, _stdout, stderr) => {
      dlStderr = stderr || '';
      if (err) { console.log('yt-dlp tiktok err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!dlOk) {
    const isPhoto = /\/photo\//i.test(dlStderr) || /photo/i.test(dlStderr);
    if (isPhoto) {
      await sock.sendMessage(jid, { text: '⚠️ Esse link é um *post de foto* do TikTok, não um vídeo!' }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, { text: '❌ Não consegui baixar o vídeo.\nVerifique se o link é válido.' }, { quoted: msg });
    }
    cleanupCookieFile();
    return;
  }

  if (!fs.existsSync(rawPath)) { await sock.sendMessage(jid, { text: '❌ Não consegui baixar o vídeo.' }, { quoted: msg }); cleanupCookieFile(); return; }

  const encOk = await new Promise((resolve) => {
    const child = execFile(ffmpegBin, [
      '-y', '-i', rawPath,
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1',
      '-preset', 'fast', '-crf', '28',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', outPath,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 * 50 }, (err) => {
      if (err) { console.log('ffmpeg tiktok err:', err.message?.slice(-400)); resolve(false); } else resolve(true);
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 120000);
  });

  try { fs.unlinkSync(rawPath); } catch {}
  if (!encOk || !fs.existsSync(outPath)) { await sock.sendMessage(jid, { text: '❌ Falha ao processar o vídeo.' }, { quoted: msg }); return; }

  const videoBuffer = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch {}
  if (videoBuffer.length > 64 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ Vídeo muito grande (máx 64MB).' }, { quoted: msg }); return; }

  let infoText = '';
  if (meta) {
    const title = meta.title || '';
    const uploader = meta.uploader || meta.channel || '';
    const durSec = meta.duration || 0;
    const duration = durSec ? `${Math.floor(durSec/60)}:${String(durSec%60).padStart(2,'0')}` : '';
    const views = meta.view_count ? Number(meta.view_count).toLocaleString('pt-BR') : '';
    if (title) infoText += `📌 *Título:* ${title}\n`;
    if (uploader) infoText += `👤 *Canal:* ${uploader}\n`;
    if (duration) infoText += `⏱️ *Duração:* ${duration}\n`;
    if (views) infoText += `👁️ *Visualizações:* ${views}\n`;
    if (infoText) infoText += '\n';
  }
  const finalCaption = infoText ? infoText + '🎵 Aqui está o vídeo!' : '🎵 Aqui está o vídeo!';

  await sock.sendMessage(jid, { video: videoBuffer, mimetype: 'video/mp4', caption: finalCaption }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  cleanupCookieFile();
  cleanupCookieFile();
  cleanupCookieFile();
  console.log('✅ Vídeo TikTok enviado!');
}

// ─── !audio ──────────────────────────────────────────────────
async function handleAudioDownload(sock, msg, jid, caption) {
  const link = caption.replace(/^[!.,\/]audio\s*/i, '').trim();
  if (!link || !link.startsWith('http')) {
    await sock.sendMessage(jid, { text: '⚠️ Envie o link do vídeo.\nExemplo: *!audio https://youtu.be/xxx*' }, { quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  const ytdlp = await getYtDlpPath();
  const { execFile } = require('child_process');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  const ffmpegBin = getFfmpegPath();
  const tmpId = randomUUID();
  const rawTemplate = path.join(tmpdir(), `${tmpId}_raw.%(ext)s`);
  const outPath = path.join(tmpdir(), `${tmpId}_out.mp3`);

  const dlOk = await new Promise((resolve) => {
    const args = [...getYtDlpArgs(), '--no-playlist', '-x', '--audio-format', 'best', '--audio-quality', '0', '--max-filesize', '100m', '-o', rawTemplate, link];
    execFile(ytdlp, args, { timeout: 90000 }, (err, _stdout, stderr) => {
      if (err) { console.log('yt-dlp audio err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!dlOk) { await sock.sendMessage(jid, { text: '❌ Não consegui baixar o áudio.' }, { quoted: msg }); return; }

  let rawPath = null;
  const base = rawTemplate.replace('.%(ext)s', '');
  for (const ext of ['.mp3', '.m4a', '.opus', '.ogg', '.webm', '.aac', '.flac', '.wav']) {
    const p = base + ext;
    if (fs.existsSync(p)) { rawPath = p; break; }
  }

  if (!rawPath) { await sock.sendMessage(jid, { text: '❌ Arquivo de áudio não encontrado.' }, { quoted: msg }); return; }

  const encOk = await new Promise((resolve) => {
    execFile(ffmpegBin, ['-y', '-i', rawPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', outPath], { timeout: 120000 }, (err) => { if (err) resolve(false); else resolve(true); });
  });

  try { fs.unlinkSync(rawPath); } catch {}
  if (!encOk || !fs.existsSync(outPath)) { await sock.sendMessage(jid, { text: '❌ Falha ao processar o áudio.' }, { quoted: msg }); return; }

  const audioBuffer = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch {}
  if (audioBuffer.length > 64 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ Áudio muito grande (máx 64MB).' }, { quoted: msg }); return; }

  await sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  console.log('✅ Áudio MP3 enviado!');
}

// ─── !som ────────────────────────────────────────────────────
async function handleSom(sock, msg, jid, caption, getPrefix, pendingMusic) {
  const P = getPrefix(jid);
  // CORREÇÃO: regex aceita prefixos !  .  ,  /
  const nome = caption.replace(/^[!.,\/]som\s*/i, '').trim();
  if (!nome) {
    await sock.sendMessage(jid, { text: `⚠️ Digite o nome da música.\nExemplo: *${P}som Ela Deixou um Bilhete*` }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  const ytdlp = await getYtDlpPath();
  const { execFile } = require('child_process');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  const tmpId = randomUUID();
  const outTemplate = path.join(tmpdir(), `${tmpId}.%(ext)s`);

  let meta = null;
  setImmediate(() => {
    try {
      const args = [...getYtDlpArgs(), '--no-playlist', '--skip-download', '--print-json', '--match-filter', '!is_live', '-o', path.join(tmpdir(), `${tmpId}_dummy`), `ytsearch1:${nome} official audio`];
      execFile(ytdlp, args, { timeout: 10000 }, (err, stdout) => {
        if (!err && stdout.trim()) { try { meta = JSON.parse(stdout.trim()); } catch {} }
      });
    } catch {}
  });

  const downloadOk = await new Promise((resolve) => {
    const args = [...getYtDlpArgs(), '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--match-filter', '!is_live', '--max-filesize', '50m', '-o', outTemplate, `ytsearch1:${nome} official audio`];
    execFile(ytdlp, args, { timeout: 90000 }, (err, _stdout, stderr) => {
      if (err) { console.log('yt-dlp som err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!downloadOk) { await sock.sendMessage(jid, { text: `❌ Não encontrei a música *"${nome}"*.` }, { quoted: msg }); return; }

  let finalPath = null;
  const base = outTemplate.replace('.%(ext)s', '');
  for (const ext of ['.mp3', '.m4a', '.opus', '.ogg', '.webm']) {
    const p = base + ext;
    if (fs.existsSync(p)) { finalPath = p; break; }
  }

  if (!finalPath) { await sock.sendMessage(jid, { text: `❌ Não encontrei a música *"${nome}"*.` }, { quoted: msg }); return; }

  const audioBuffer = fs.readFileSync(finalPath);
  fs.unlinkSync(finalPath);

  if (audioBuffer.length > 64 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ Arquivo muito grande (máx 64MB).' }, { quoted: msg }); return; }

  let thumbBuffer = null;
  const thumbUrl = meta?.thumbnail || (meta?.thumbnails?.length ? meta.thumbnails[meta.thumbnails.length - 1]?.url : null);
  if (thumbUrl) { try { thumbBuffer = await fetchBuffer(thumbUrl); } catch {} }

  let cardBuffer = null;
  try {
    let baseImage;
    if (thumbBuffer) {
      baseImage = await sharp(thumbBuffer).resize(800, 450, { fit: 'cover', position: 'centre' }).jpeg({ quality: 85 }).toBuffer();
    } else {
      baseImage = await sharp(Buffer.from(`<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#0f3460"/></svg>`)).jpeg({ quality: 90 }).toBuffer();
    }
    const overlay = Buffer.from(`<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="50%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="0.82"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/></svg>`);
    cardBuffer = await sharp(baseImage).composite([{ input: overlay, blend: 'over' }]).jpeg({ quality: 88 }).toBuffer();
  } catch {}

  const titulo = meta?.title || nome;
  const durSec = meta?.duration || 0;
  const durStr = durSec ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}` : '—';
  const uploader = meta?.uploader || meta?.channel || null;
  const views = meta?.view_count ? Number(meta.view_count).toLocaleString('pt-BR') : null;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  pendingMusic.set(senderJid, { audioBuffer, titulo, meta, nome });
  setTimeout(() => pendingMusic.delete(senderJid), 10 * 60 * 1000);

  let texto = `━━━ [ 🎧 *Piroquinhas* 🎧 ] ━━━\n\n`;
  texto += `• 🔎 *Pesquisa:* _${nome}_\n\n`;
  texto += `• 🎵 *Título:* _${titulo}_\n\n`;
  texto += `• ⏱️ *Duração:* ${durStr}\n`;
  if (uploader) texto += `• 👤 *Canal:* _${uploader}_\n`;
  if (views)    texto += `• 👁️ *Views:* ${views}\n`;
  texto += `\n━━━ [ 📱 *MAIS OPÇÕES* 📱 ] ━━━\n`;
  texto += `🎬 *${P}playmp4* - _Baixa como vídeo_\n`;
  texto += `📄 *${P}playdoc* - _Baixa como documento_`;

  if (cardBuffer) {
    await sock.sendMessage(jid, { image: cardBuffer, caption: texto }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, { text: texto }, { quoted: msg });
  }

  await sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
  console.log(`✅ Música "${titulo}" enviada!`);
}

// ─── !playmp4 ────────────────────────────────────────────────
async function handlePlayMp4(sock, msg, jid, getPrefix, pendingMusic) {
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const pending = pendingMusic.get(senderJid);
  const P = getPrefix(jid);
  if (!pending) { await sock.sendMessage(jid, { text: `⚠️ Nenhuma música recente. Use *${P}som <música>* primeiro.` }, { quoted: msg }); return; }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  const { execFile } = require('child_process');
  const ffmpegBin = getFfmpegPath();
  const tmpId = require('crypto').randomUUID();
  const rawPath = path.join(require('os').tmpdir(), `${tmpId}_raw.mp4`);
  const outPath = path.join(require('os').tmpdir(), `${tmpId}_out.mp4`);
  const target = pending.meta?.webpage_url || `ytsearch1:${pending.nome} official video`;
  const ytdlp = await getYtDlpPath();

  const dlOk = await new Promise((resolve) => {
    const args = [...getYtDlpArgs(), '--no-playlist', '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--max-filesize', '120m', '-o', rawPath, target];
    execFile(ytdlp, args, { timeout: 180000 }, (err, _stdout, stderr) => {
      if (err) { console.log('yt-dlp mp4 err:', stderr?.slice(-400)); resolve(false); } else resolve(true);
    });
  });

  if (!dlOk || !fs.existsSync(rawPath)) { await sock.sendMessage(jid, { text: '❌ Não consegui baixar o vídeo.' }, { quoted: msg }); return; }

  const encOk = await new Promise((resolve) => {
    execFile(ffmpegBin, ['-y', '-i', rawPath, '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-preset', 'fast', '-crf', '28', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-max_muxing_queue_size', '1024', outPath], { timeout: 180000 }, (err) => { if (err) resolve(false); else resolve(true); });
  });

  try { fs.unlinkSync(rawPath); } catch {}
  if (!encOk || !fs.existsSync(outPath)) { await sock.sendMessage(jid, { text: '❌ Falha ao processar o vídeo.' }, { quoted: msg }); return; }

  const videoBuffer = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch {}
  if (videoBuffer.length > 64 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ Vídeo muito grande (máx 64MB).' }, { quoted: msg }); return; }

  await sock.sendMessage(jid, { video: videoBuffer, mimetype: 'video/mp4', caption: `🎬 *${pending.titulo}*` }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
}

// ─── !playdoc ────────────────────────────────────────────────
async function handlePlayDoc(sock, msg, jid, getPrefix, pendingMusic) {
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const pending = pendingMusic.get(senderJid);
  const P = getPrefix(jid);
  if (!pending) { await sock.sendMessage(jid, { text: `⚠️ Nenhuma música recente. Use *${P}som <música>* primeiro.` }, { quoted: msg }); return; }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });
  const safeName = (pending.titulo || 'musica').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').slice(0, 60);
  await sock.sendMessage(jid, { document: pending.audioBuffer, mimetype: 'audio/mpeg', fileName: `${safeName}.mp3`, caption: `📄 *${pending.titulo}*\n_Enviado como documento_` }, { quoted: msg });
  await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
}

// ═══════════════════════════════════════════════════════════════
// ─── PERFIL ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function handlePerfil(sock, msg, content, jid, contactNames, msgCount, cmdCount, stickerCount, relacionamentos) {
  const contextInfo = content.extendedTextMessage?.contextInfo;
  const mentions = contextInfo?.mentionedJid || [];
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const alvoJid = mentions[0] || contextInfo?.participant || senderJid;
  const nome = contactNames[alvoJid] || alvoJid.split('@')[0];

  let groupName = '';
  if (jid.endsWith('@g.us')) {
    try { const meta = await sock.groupMetadata(jid); groupName = meta.subject || ''; } catch {}
  }

  const number = alvoJid.split('@')[0];
  let isAdmin = false;
  if (jid.endsWith('@g.us')) {
    try { const grupoHandler = require('./grupo'); isAdmin = await grupoHandler.isAdmin(sock, jid, alvoJid); } catch {}
  }

  const msgsRec = (msgCount.get(alvoJid)?.count) || 0;
  const cmdsRec = cmdCount.get(alvoJid) || 0;
  const sticks = stickerCount.get(alvoJid) || 0;
  const interactions = msgsRec + cmdsRec + sticks;
  let activityLabel = '📉 CALMO';
  if (interactions > 1000) activityLabel = '🔥 HIPERATIVO';
  else if (interactions > 500) activityLabel = '⚡ ATIVO';

  let rankText = '';
  try {
    const ranks = [...msgCount.entries()].sort((a,b)=> (b[1]?.count||0) - (a[1]?.count||0));
    const idx = ranks.findIndex(([k])=>k === alvoJid);
    if (idx >= 0) rankText = ` (#${idx+1})`;
  } catch {}

  let relStatus = 'Solteiro(a)';
  if (relacionamentos) {
    for (const [k,v] of relacionamentos) {
      if (k.includes(alvoJid.split('@')[0])) {
        const partner = v.nomeA === nome ? v.nomeB : v.nomeA;
        relStatus = v.tipo === 'casamento' ? `Casado(a) com ${partner}` : `Namorando com ${partner}`;
        break;
      }
    }
  }

  let picBuffer = null;
  try {
    const url = await sock.profilePictureUrl(alvoJid, 'image');
    if (url) picBuffer = await fetchBuffer(url);
  } catch {}

  const lines = [];
  lines.push(`╭─[ 📊 ATIVIDADE DO MEMBRO 📊 ]─`);
  lines.push(`👤 Usuário: ${nome}`);
  if (groupName) lines.push(`🏠 Grupo: ${groupName}`);
  lines.push(`📞 Número: +${number}`);
  if (jid.endsWith('@g.us')) lines.push(`👑 Admin: ${isAdmin ? 'Sim' : 'Não'}`);
  lines.push(`────────────────────────`);
  lines.push(`📝 Mensagens: ${msgsRec}${rankText}`);
  lines.push(`🤖 Comandos: ${cmdsRec}`);
  lines.push(`😄 Figurinhas: ${sticks}`);
  lines.push(`────────────────────────`);
  lines.push(`📈 Total de Interações: ${interactions}`);
  lines.push(activityLabel);
  lines.push(`────────────────────────`);
  lines.push(`[💑 RELACIONAMENTO]`);
  lines.push(`💔 Status: ${relStatus}`);
  lines.push(`────────────────────────`);
  lines.push(`[🤖 Piroquinhas]`);

  const texto = lines.join('\n');
  if (picBuffer) {
    await sock.sendMessage(jid, { image: picBuffer, caption: texto }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, { text: texto }, { quoted: msg });
  }
}

async function tryFetchLyricsFromRandomApi(tema) {
  const queries = [
    tema,
    tema.replace(/[’‘]/g, "'"),
    tema.replace(/[’‘']/g, ''),
    tema.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean);

  const tried = new Set();
  for (const q of queries) {
    const normalized = q.trim();
    if (!normalized || tried.has(normalized)) continue;
    tried.add(normalized);

    try {
      const result = await fetchJson(`https://some-random-api.ml/lyrics?title=${encodeURIComponent(normalized)}`);
      const lyrics = result?.lyrics?.trim();
      if (lyrics) return { source: 'random', result, query: normalized };
    } catch (e) {
      continue;
    }
  }

  return null;
}

async function tryFetchLyricsFromOvh(tema) {
  const separator = tema.includes(' - ') ? ' - ' : tema.includes(' – ') ? ' – ' : null;
  if (!separator) return null;
  const [artist, title] = tema.split(separator).map(s => s.trim());
  if (!artist || !title) return null;

  try {
    const result = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    const lyrics = result?.lyrics?.trim();
    if (lyrics) return { source: 'ovh', result: { lyrics, title, author: artist }, query: tema };
  } catch (e) {
    return null;
  }

  return null;
}

async function handleLetra(sock, msg, jid, caption) {
  const tema = caption.replace(/^[!.,\/]letra\s*/i, '').trim();
  if (!tema) {
    await sock.sendMessage(jid, { text: '⚠️ Especifique o nome da música. Exemplo: *!letra bohemian rhapsody*' }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

  try {
    const lyricsSource = await tryFetchLyricsFromOvh(tema) || await tryFetchLyricsFromRandomApi(tema);
    if (!lyricsSource) throw new Error('Não encontrei a letra.');

    const result = lyricsSource.result;
    const title = result.title || tema;
    const author = result.author || result.artist || '';
    const genius = result.links?.genius || '';
    const lyrics = result.lyrics?.trim();

    const infoLines = [`🎵 *${title}*`];
    if (author) infoLines.push(`👤 *Artista:* ${author}`);
    if (genius) infoLines.push(`🔗 *Link:* ${genius}`);

    const fullText = `${infoLines.join('\n')}\n\n${lyrics}`;
    const chunks = chunkLongText(fullText);

    for (let i = 0; i < chunks.length; i++) {
      await sock.sendMessage(jid, { text: chunks[i] }, i === 0 ? { quoted: msg } : {});
    }
  } catch (err) {
    console.log(`⚠️ Letra não encontrada para "${tema}":`, err.message);
    await sock.sendMessage(jid, {
      text: '❌ Não foi possível obter a letra. Tente usar o formato: *!letra artista - música*',
    }, { quoted: msg });
  }
}


// ═══════════════════════════════════════════════════════════════
// ─── MODULE.EXPORTS ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Menus
  handleMenu,
  handleMenuUtil,
  handleMenuJogos,
  handleMenuBaixar,
  handleMenuRelacionamento,
  handleAlteradores,
  // Utilidades básicas
  handleQrcode,
  handleEncurtar,
  handleCep,
  handleClima,
  handleMoeda,
  handleCalcular,
  handleDado,
  handlePiada,
  handleFato,
  handleTraduzir,
  // Downloads
  handleTiktok,
  handleSave,
  handleSaveRec,
  handleAudioDownload,
  handleSom,
  handlePlayMp4,
  handlePlayDoc,
  handleCodigoMorse,
  handleDecodificarMorse,
  // Perfil
  handlePerfil,
  // Helpers
  setLogger,
  setRemoveBgKey,
  getYtDlpPath,
  getYtDlpArgs,
  getFfmpegPath,
  getFfprobePath,
};
