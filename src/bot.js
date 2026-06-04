/**
 * WhatsApp Sticker Bot — Piroquinhas
 * bot.js principal — roteador completo
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino    = require('pino');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');

// ─── Importar Handlers ────────────────────────────────────────
const figurinhaHandler      = require('./handlers/figurinha');
const diversaoHandler       = require('./handlers/diversao');
const relacionamentoHandler = require('./handlers/relacionamento');
const grupoHandler          = require('./handlers/grupo');
const imagemHandler         = require('./handlers/imagem');
const textoHandler          = require('./handlers/texto');
const utilidadeHandler      = require('./handlers/utilidade');
const aniversarioHandler    = require('./handlers/aniversario');
const alteradoresHandler    = require('./handlers/alteradores');
const downloadsHandler      = require('./handlers/downloads');

// ─── Silenciar logs de sessão ─────────────────────────────────
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const NOISE = [
  'Closing open session','Closing session:','SessionEntry','_chains',
  'registrationId','currentRatchet','indexInfo','ephemeralKeyPair',
  'lastRemoteEphemeralKey','previousCounter','rootKey','baseKey',
  'remoteIdentityKey','Bad MAC','MessageCounterError','Failed to decrypt',
  'chainKey','chainType','messageKeys','pubKey','privKey',
];
const isNoise = a => {
  try {
    for (const x of a) {
      if (x && typeof x === 'object') {
        const keys = Object.keys(x);
        if (keys.some(k => NOISE.includes(k))) return true;
        const name = x?.constructor?.name || '';
        if (name === 'SessionEntry' || NOISE.some(p => name.includes(p))) return true;
      }
    }
    const s = a.map(x => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return ''; } }).join(' ');
    return NOISE.some(p => s.includes(p));
  } catch { return false; }
};
console.log   = (...a) => { if (!isNoise(a)) _log(...a); };
console.error = (...a) => { if (!isNoise(a)) _err(...a); };

// ─── Diretórios ───────────────────────────────────────────────
const SESSION_DIR = path.resolve(__dirname, '../session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── Persistência ─────────────────────────────────────────────
const DATA_FILE = path.resolve(__dirname, '../data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.log('⚠️ Erro ao carregar data.json:', e.message); }
  return { msgCount: {}, stickerCount: {}, cmdCount: {}, pinnedMessages: {}, groupConfig: {}, warnings: {} };
}

const _savedData   = loadData();
const msgCount     = new Map(Object.entries(_savedData.msgCount     || {}));
const stickerCount = new Map(Object.entries(_savedData.stickerCount || {}));
const cmdCount     = new Map(Object.entries(_savedData.cmdCount     || {}));

// Warnings: Map<groupJid, Map<userJid, count>>
const warnings = new Map();
for (const [gJid, usersObj] of Object.entries(_savedData.warnings || {})) {
  if (typeof usersObj === 'object') warnings.set(gJid, new Map(Object.entries(usersObj)));
}

console.log(`📂 Dados carregados: ${msgCount.size} usuários no histórico`);

function saveData() {
  try {
    const existingData = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}
      : {};

    const warningsObj = {};
    for (const [gJid, usersMap] of warnings.entries()) {
      warningsObj[gJid] = Object.fromEntries([...usersMap.entries()]);
    }

    const data = {
      ...existingData,
      msgCount:       Object.fromEntries([...msgCount.entries()]),
      stickerCount:   Object.fromEntries([...stickerCount.entries()]),
      cmdCount:       Object.fromEntries([...cmdCount.entries()]),
      pinnedMessages: Object.fromEntries([...pinnedMessages.entries()]),
      warnings:       warningsObj,
      groupConfig: {
        antiLink:    [...antiLinkGroups],
        autoSticker: [...autoStickerGroups],
        prefixos:    Object.fromEntries([...prefixMap.entries()]),
      },
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.log('⚠️ Erro ao salvar data.json:', e.message); }
}

setInterval(saveData, 60 * 1000);
process.on('SIGINT',  () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });

// ─── Estado Global ────────────────────────────────────────────
const logger           = pino({ level: 'silent' });
const contactNames     = {};
const mutedUsers       = new Map();
const pendingMusic     = new Map();
const prefixMap        = new Map();
const relacionamentos  = new Map();
const pedidosPendentes = new Map();
const pinnedMessages   = new Map(Object.entries(_savedData.pinnedMessages || {}));
const lastTexts        = new Map();

let botJid = null;

const _cfg = _savedData.groupConfig || {};
const antiLinkGroups    = new Set(_cfg.antiLink    || []);
const autoStickerGroups = new Set(_cfg.autoSticker || []);
if (_cfg.prefixos) {
  for (const [k, v] of Object.entries(_cfg.prefixos)) prefixMap.set(k, v);
}

function getPrefix(jid) { return prefixMap.get(jid) || '!'; }

// ─── Helpers de prefixo ───────────────────────────────────────
const VALID_PREFIXES = ['!', '.', '/', ','];

function isAnyCmd(text) {
  return VALID_PREFIXES.some(p => text.startsWith(p));
}
function matchCmd(raw, cmdName) {
  for (const p of VALID_PREFIXES) {
    if (raw === p + cmdName) return true;
  }
  return false;
}
function matchCmdStart(raw, cmdName) {
  for (const p of VALID_PREFIXES) {
    if (raw.startsWith(p + cmdName)) return true;
  }
  return false;
}

// ─── Contadores ───────────────────────────────────────────────
function contarSticker(jid) {
  stickerCount.set(jid, (stickerCount.get(jid) || 0) + 1);
  saveData();
}
function contarCmd(jid) {
  cmdCount.set(jid, (cmdCount.get(jid) || 0) + 1);
  if (cmdCount.get(jid) % 5 === 0) saveData();
}
function contarMensagem(jid, nome) {
  const cur = msgCount.get(jid) || { nome, count: 0 };
  cur.nome  = nome || cur.nome;
  cur.count++;
  msgCount.set(jid, cur);
  if (cur.count % 10 === 0) saveData();
}

// ─── Configurar Handlers ──────────────────────────────────────
figurinhaHandler.setLogger(logger);
imagemHandler.setLogger(logger);
alteradoresHandler.setLogger(logger);
downloadsHandler.setLogger(logger);

// ═══════════════════════════════════════════════════════════════
// ─── INICIALIZAR BOT ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`\n🤖 Iniciando bot com Baileys v${version.join('.')}\n`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['Piroquinhas', 'Chrome', '1.0.0'],
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.buttonsMessage  ||
        message.templateMessage ||
        message.listMessage     ||
        message.stickerMessage
      );
      if (requiresPatch) {
        message = {
          viewOnceMessageV2: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        };
      }
      return message;
    },
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Atualizar nomes de contato ─────────────────────────────
  sock.ev.on('contacts.upsert', cs => {
    for (const c of cs) if (c.name || c.notify) contactNames[c.id] = c.name || c.notify;
  });
  sock.ev.on('contacts.update', cs => {
    for (const c of cs) if (c.name || c.notify) contactNames[c.id] = c.name || c.notify;
  });

  // ── Eventos de grupo (entradas/saídas) ─────────────────────
  sock.ev.on('group-participants.update', async ({ id: groupJid, participants, action }) => {
    if (action === 'add') {
      for (const userJid of participants) {
        const nome = contactNames[userJid] || userJid.split('@')[0];
        try {
          await grupoHandler.processarBemVindo(sock, groupJid, userJid, nome);
        } catch (e) {
          console.log('⚠️ Erro no bem-vindo:', e.message);
        }
      }
    }
  });

  // ── Conexão ────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code:\n');
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      await QRCode.toFile(path.resolve(__dirname, '../qrcode.png'), qr, { width: 400 });
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log('🚪 Desconectado. Delete /session e reinicie.');
    } else if (connection === 'open') {
      botJid = sock.user?.id || null;
      console.log(`✅ Bot conectado! JID: ${botJid}\n`);
    }
  });

  // ── Mensagens ─────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message)   continue;

      const _jid       = msg.key.remoteJid || '';
      const _isPrivate = !_jid.endsWith('@g.us') && !_jid.endsWith('@broadcast');
      if (_isPrivate) {
        const _txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        console.log(`📩 Privado | ${_jid} | "${_txt.slice(0, 50)}"`);
      }

      try { await handleMessage(sock, msg); }
      catch (err) { console.error('❌ Erro no handleMessage:', err.message); }
    }
  });
}

function getSenderName(msg) {
  if (msg.pushName) return msg.pushName;
  const jid = msg.key.participant || msg.key.remoteJid || '';
  return contactNames[jid] || jid.split('@')[0] || 'Anônimo';
}

// ═══════════════════════════════════════════════════════════════
// ─── HANDLER PRINCIPAL ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;

  const content =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message  ||
    msg.message;
  if (!content) return;

  const imageMsg  = content.imageMessage;
  const videoMsg  = content.videoMessage;
  const textMsg   = content.conversation || content.extendedTextMessage?.text || '';
  const caption   = (imageMsg?.caption || videoMsg?.caption || textMsg || '').trim();
  const author    = getSenderName(msg);
  const senderJid = msg.key.participant || msg.key.remoteJid;

  const raw     = caption.toLowerCase();
  const cmdWord = raw.split(/\s+/)[0];
  const cmd     = raw;

  if (senderJid) contarMensagem(senderJid, author);

  const isPrivate = jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast');
  const isGroup   = jid && jid.endsWith('@g.us');

  // ── Slow Mode ────────────────────────────────────────────────
  if (isGroup && !isAnyCmd(raw)) {
    const permitido = grupoHandler.verificarSlowMode(jid, senderJid);
    if (!permitido) return;
  }

  // ── Anti-Flood ───────────────────────────────────────────────
  if (isGroup) {
    try {
      const flood = await grupoHandler.verificarAntiFlood(sock, jid, senderJid, botJid);
      if (flood) {
        await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
        await sock.sendMessage(jid, {
          text: `🚫 *@${senderJid.split('@')[0]}* foi removido por flood!`,
          mentions: [senderJid],
        });
        return;
      }
    } catch {}
  }

  // ── Substituição estilo vim (s/antigo/novo/) ──────────────────
  const subMatch = caption.match(/^[!.]s\/([^\/]+)\/([^\/]+)\/?/i);
  if (subMatch && (isPrivate || content.extendedTextMessage?.contextInfo?.quotedMessage)) {
    if (senderJid) contarCmd(senderJid);
    const pattern     = subMatch[1];
    const replacement = subMatch[2];
    const targetText  = content.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
      || lastTexts.get(jid) || '';
    if (!targetText) {
      await sock.sendMessage(jid, { text: '⚠️ Nenhuma mensagem para corrigir.' }, { quoted: msg });
    } else {
      try {
        const newText = targetText.replace(new RegExp(pattern, 'g'), replacement);
        await sock.sendMessage(jid, {
          text: newText === targetText ? '⚠️ Nada foi alterado.' : newText,
        }, { quoted: msg });
      } catch {
        await sock.sendMessage(jid, { text: '⚠️ Padrão inválido.' }, { quoted: msg });
      }
    }
    return;
  }

  // Guardar última msg de texto no PV
  if (isPrivate && textMsg && !isAnyCmd(raw)) lastTexts.set(jid, textMsg);

  // ── Anti-Link ────────────────────────────────────────────────
  if (isGroup && antiLinkGroups.has(jid) && !isAnyCmd(raw)) {
    const hasLink = /(https?:\/\/|wa\.me\/|chat\.whatsapp\.com)/i.test(caption);
    if (hasLink) {
      const isAdm = await grupoHandler.isAdmin(sock, jid, senderJid).catch(() => false);
      if (!isAdm) {
        try {
          await sock.sendMessage(jid, {
            text: `🚫 *${getSenderName(msg)}*, links não são permitidos neste grupo!`,
            mentions: [senderJid],
          });
          await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
        } catch {}
        return;
      }
    }
  }

  // ── Auto-Sticker ──────────────────────────────────────────────
  if (isGroup && autoStickerGroups.has(jid) && !isAnyCmd(raw)) {
    if (imageMsg || videoMsg) {
      try { await figurinhaHandler.processMedia(sock, msg, content, jid, author, stickerCount); } catch {}
      return;
    }
  }

  // ── Pedido de casamento (sim/não) ─────────────────────────────
  if (pedidosPendentes.has(senderJid)) {
    const resp = raw.trim();
    if (resp === 'sim' || resp === 'nao' || resp === 'não') {
      await relacionamentoHandler.handleResposta(sock, msg, jid, senderJid, resp, relacionamentos, pedidosPendentes, contactNames);
      return;
    }
  }

  // ── Quiz ativo ────────────────────────────────────────────────
  if (diversaoHandler.quizState?.has(senderJid)) {
    await diversaoHandler.handleQuiz(sock, msg, jid, author, senderJid);
    return;
  }

  // ── Anagrama ativo ────────────────────────────────────────────
  if (diversaoHandler.anagramaState?.has(senderJid)) {
    await diversaoHandler.handleAnagrama(sock, msg, jid, author, senderJid);
    return;
  }

  // Ignorar sem prefixo
  if (!isAnyCmd(raw)) return;
  if (senderJid) contarCmd(senderJid);

  // ── Mute check ────────────────────────────────────────────────
  if (isGroup && mutedUsers.has(senderJid)) {
    setTimeout(async () => {
      try {
        await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
        mutedUsers.delete(senderJid);
      } catch (e) { console.log('❌ Erro ao remover mutado:', e.message); }
    }, 20000);
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // ROTEADOR
  // ═══════════════════════════════════════════════════════════════

  // ── MENUS ─────────────────────────────────────────────────────
  if (matchCmd(cmdWord, 'menu') || matchCmdStart(cmd, 'menu '))
    { await utilidadeHandler.handleMenu(sock, msg, jid, caption, getPrefix, author); return; }
  if (matchCmd(cmdWord, 'menuutil'))
    { await utilidadeHandler.handleMenuUtil(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menujogos'))
    { await utilidadeHandler.handleMenuJogos(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menubaixar'))
    { await utilidadeHandler.handleMenuBaixar(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menucasal') || matchCmd(cmdWord, 'menurelacionamento') || matchCmd(cmdWord, 'menurelacionamentos'))
    { await utilidadeHandler.handleMenuRelacionamento(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menuadm'))
    { await grupoHandler.handleMenuAdm(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menufig'))
    { await figurinhaHandler.handleMenuFig(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menuefeitos'))
    { await imagemHandler.handleMenuEfeitos(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menuaniversario'))
    { await aniversarioHandler.handleMenuAniversario(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'brincadeiras'))
    { await diversaoHandler.handleBrincadeiras(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'sistemgold'))
    { await diversaoHandler.handleSistemaGold(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'sistempet'))
    { await diversaoHandler.handleSistemaPet(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menugold'))
    { await diversaoHandler.handleMenuGold(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'menupet'))
    { await diversaoHandler.handleMenuPet(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'gold'))
    { await diversaoHandler.handleGold(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'loja'))
    { await diversaoHandler.handleLoja(sock, msg, jid, getPrefix); return; }
  if (matchCmd(cmdWord, 'comprar'))
    { await diversaoHandler.handleComprar(sock, msg, jid, caption); return; }
  if (matchCmd(cmdWord, 'vender'))
    { await diversaoHandler.handleVender(sock, msg, jid, caption); return; }
  if (matchCmd(cmdWord, 'extrato'))
    { await diversaoHandler.handleExtrato(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'adotar'))
    { await diversaoHandler.handleAdotarPet(sock, msg, jid, caption); return; }
  if (matchCmd(cmdWord, 'alimentar'))
    { await diversaoHandler.handleAlimentarPet(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'brincar'))
    { await diversaoHandler.handleBrincarPet(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'statuspet'))
    { await diversaoHandler.handleStatusPet(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'petrank'))
    { await diversaoHandler.handlePetRank(sock, msg, jid, contactNames); return; }
  if (matchCmd(cmdWord, 'alteradores'))
    { await utilidadeHandler.handleAlteradores(sock, msg, jid); return; }

  // ── UTILIDADES ────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'qrcode ') || matchCmd(cmdWord, 'qrcode'))
    { await utilidadeHandler.handleQrcode(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'encurtar ') || matchCmd(cmdWord, 'encurtar'))
    { await utilidadeHandler.handleEncurtar(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'cep ') || matchCmd(cmdWord, 'cep'))
    { await utilidadeHandler.handleCep(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'clima ') || matchCmd(cmdWord, 'clima'))
    { await utilidadeHandler.handleClima(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'calcular ') || matchCmd(cmdWord, 'calcular'))
    { await utilidadeHandler.handleCalcular(sock, msg, jid, caption); return; }
  if (matchCmd(cmdWord, 'piada'))
    { await utilidadeHandler.handlePiada(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'fato'))
    { await utilidadeHandler.handleFato(sock, msg, jid); return; }

  // !moeda: 3 args numéricos → câmbio, senão → cara/coroa
  if (matchCmdStart(cmd, 'moeda ')) {
    const args = caption.replace(/^[!.,\/]moeda\s*/i, '').trim().split(/\s+/);
    if (args.length >= 3 && !isNaN(parseFloat(args[0])))
      { await utilidadeHandler.handleMoeda(sock, msg, jid, caption); }
    else
      { await diversaoHandler.handleMoeda(sock, msg, jid); }
    return;
  }
  if (matchCmd(cmdWord, 'moeda'))
    { await diversaoHandler.handleMoeda(sock, msg, jid); return; }

  if (matchCmdStart(cmd, 'traduzir ') || matchCmd(cmdWord, 'traduzir'))
    { await utilidadeHandler.handleTraduzir(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'codigomorse ') || matchCmd(cmdWord, 'codigomorse') || matchCmdStart(cmd, 'morse ') || matchCmd(cmdWord, 'morse'))
    { await utilidadeHandler.handleCodigoMorse(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'decodificarmorse ') || matchCmd(cmdWord, 'decodificarmorse') || matchCmdStart(cmd, 'demorse ') || matchCmd(cmdWord, 'demorse'))
    { await utilidadeHandler.handleDecodificarMorse(sock, msg, jid, caption); return; }

  // ── DOWNLOADS ─────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'tiktok'))
    { await utilidadeHandler.handleTiktok(sock, msg, jid, caption, getPrefix); return; }
  if (matchCmd(cmdWord, 'save') || matchCmdStart(cmd, 'save '))
    { await utilidadeHandler.handleSave(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'saverec'))
    { await utilidadeHandler.handleSaveRec(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'audio'))
    { await utilidadeHandler.handleAudioDownload(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'som ') || matchCmd(cmdWord, 'som') || matchCmdStart(cmd, 'play '))
    { await utilidadeHandler.handleSom(sock, msg, jid, caption, getPrefix, pendingMusic); return; }
  if (matchCmd(cmdWord, 'playmp4'))
    { await utilidadeHandler.handlePlayMp4(sock, msg, jid, getPrefix, pendingMusic); return; }
  if (matchCmd(cmdWord, 'playdoc'))
    { await utilidadeHandler.handlePlayDoc(sock, msg, jid, getPrefix, pendingMusic); return; }
  if (matchCmd(cmdWord, 'pinterest') || matchCmd(cmdWord, 'pinterest2'))
    { await downloadsHandler.handlePinterest(sock, msg, jid, caption); return; }

  // ── PERFIL ────────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'perfil'))
    { await utilidadeHandler.handlePerfil(sock, msg, content, jid, contactNames, msgCount, cmdCount, stickerCount, relacionamentos); return; }

  // ── FIGURINHAS ────────────────────────────────────────────────
  if (
    (matchCmd(cmd, 's') || matchCmdStart(cmd, 's ')) &&
    (imageMsg || videoMsg || content.extendedTextMessage?.contextInfo?.quotedMessage)
  ) { await figurinhaHandler.handleSticker(sock, msg, content, jid, author, stickerCount); return; }

  if (
    matchCmd(cmdWord, 'f') &&
    (imageMsg || videoMsg || content.extendedTextMessage?.contextInfo?.quotedMessage)
  ) { await figurinhaHandler.handleSticker(sock, msg, content, jid, author, stickerCount); return; }

  if (matchCmdStart(cmd, 'desfig'))       { await figurinhaHandler.handleDesfig(sock, msg, content, jid); return; }
  if (matchCmdStart(cmd, 'estourar'))     { await figurinhaHandler.handleEstourar(sock, msg, content, jid); return; }
  if (matchCmdStart(cmd, 'brat '))        { await figurinhaHandler.handleBrat(sock, msg, jid, caption, getPrefix, stickerCount); return; }
  if (matchCmdStart(cmd, 'figtexto '))    { await figurinhaHandler.handleFigtexto(sock, msg, jid, caption, getPrefix, stickerCount); return; }
  if (matchCmdStart(cmd, 'attp '))        { await figurinhaHandler.handleAttp(sock, msg, jid, caption, getPrefix, stickerCount, 1); return; }
  if (matchCmdStart(cmd, 'attp2 '))       { await figurinhaHandler.handleAttp(sock, msg, jid, caption, getPrefix, stickerCount, 2); return; }
  if (matchCmdStart(cmd, 'qc '))          { await figurinhaHandler.handleQc(sock, msg, jid, caption, getPrefix, stickerCount, 1); return; }
  if (matchCmdStart(cmd, 'qc2 '))         { await figurinhaHandler.handleQc(sock, msg, jid, caption, getPrefix, stickerCount, 2); return; }
  if (matchCmdStart(cmd, 'emojimix'))     { await figurinhaHandler.handleEmojiMix(sock, msg, jid, caption, getPrefix, stickerCount); return; }
  if (matchCmdStart(cmd, 'emoji'))        { await figurinhaHandler.handleEmoji(sock, msg, jid, caption, getPrefix, stickerCount); return; }
  if (matchCmdStart(cmd, 'toimg'))        { await figurinhaHandler.handleToImg(sock, msg, content, jid); return; }
  if (matchCmdStart(cmd, 'togif'))        { await figurinhaHandler.handleToGif(sock, msg, content, jid); return; }
  if (matchCmdStart(cmd, 'figemoji'))     { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figemoji',    'emoji meme',      stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figroblox'))    { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figroblox',   'roblox meme',     stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figmeme'))      { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figmeme',     'funny meme',      stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figcoreana'))   { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figcoreana',  'kpop cute',       stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figraiva'))     { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figraiva',    'angry reaction',  stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figengracada')) { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figengracada','funny laugh',     stickerCount, author); return; }
  if (matchCmdStart(cmd, 'figdesenho'))   { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'figdesenho',  'cartoon sticker', stickerCount, author); return; }
  if (matchCmdStart(cmd, 'fig '))         { await figurinhaHandler.handleFigCategoria(sock, msg, jid, caption, 'fig',         'sticker',         stickerCount, author); return; }
  if (matchCmdStart(cmd, 'pesquisafig'))  { await figurinhaHandler.handlePesquisaFig(sock, msg, jid, caption, getPrefix, stickerCount, author); return; }

  // ── RELACIONAMENTO ────────────────────────────────────────────
  if (matchCmdStart(cmd, 'casar'))
    { await relacionamentoHandler.handleRelacionamento(sock, msg, content, jid, author, 'casamento', relacionamentos, pedidosPendentes, contactNames); return; }
  if (matchCmdStart(cmd, 'namorar'))
    { await relacionamentoHandler.handleRelacionamento(sock, msg, content, jid, author, 'namoro', relacionamentos, pedidosPendentes, contactNames); return; }
  if (matchCmdStart(cmd, 'terminar'))
    { await relacionamentoHandler.handleTerminar(sock, msg, content, jid, author, relacionamentos); return; }
  if (matchCmd(cmdWord, 'fixar') || matchCmdStart(cmd, 'fixar'))
    { await relacionamentoHandler.handleFixar(sock, msg, content, jid, author, pinnedMessages, contactNames); return; }
  if (matchCmd(cmdWord, 'pinned') || matchCmdStart(cmd, 'pinned'))
    { await relacionamentoHandler.handlePinned(sock, msg, jid, pinnedMessages, contactNames); return; }
  if (matchCmdStart(cmd, 'desfixar'))
    { await relacionamentoHandler.handleDesfixar(sock, msg, jid, pinnedMessages); return; }
  if (matchCmd(cmdWord, 'euaceito'))
    { await relacionamentoHandler.handleEuAceito(sock, msg, jid, senderJid, relacionamentos, pedidosPendentes, contactNames); return; }
  if (matchCmd(cmdWord, 'eurecuso'))
    { await relacionamentoHandler.handleEuRecuso(sock, msg, jid, senderJid, pedidosPendentes, contactNames); return; }
  if (matchCmd(cmdWord, 'cancelarpedido'))
    { await relacionamentoHandler.handleCancelarPedido(sock, msg, jid, senderJid, pedidosPendentes, contactNames); return; }
  if (matchCmd(cmdWord, 'cancelarcasamento'))
    { await relacionamentoHandler.handleCancelarCasamento(sock, msg, jid, author, senderJid, relacionamentos); return; }
  // Diários originais
  if (matchCmd(cmdWord, 'flores'))    { await relacionamentoHandler.handleFlores(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'doces'))     { await relacionamentoHandler.handleDoces(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'carta'))     { await relacionamentoHandler.handleCarta(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'mimo'))      { await relacionamentoHandler.handleMimo(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'beijo'))     { await relacionamentoHandler.handleBeijo(sock, msg, jid, author, senderJid, relacionamentos); return; }
  // Diários novos
  if (matchCmd(cmdWord, 'abraco'))    { await relacionamentoHandler.handleAbraco(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'presente'))  { await relacionamentoHandler.handlePresente(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'jantar'))    { await relacionamentoHandler.handleJantar(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'cinematel')) { await relacionamentoHandler.handleCinemaRel(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'viajar'))    { await relacionamentoHandler.handleViajar(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'serenata'))  { await relacionamentoHandler.handleSerenata(sock, msg, jid, author, senderJid, relacionamentos); return; }
  // Especiais de relacionamento
  if (matchCmd(cmdWord, 'declarar'))           { await relacionamentoHandler.handleDeclarar(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmdStart(cmd, 'ciumento'))          { await relacionamentoHandler.handleCiumento(sock, msg, content, jid, author, senderJid, relacionamentos, contactNames); return; }
  if (matchCmd(cmdWord, 'statu'))              { await relacionamentoHandler.handleStatu(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'meupar'))             { await relacionamentoHandler.handleMeuPar(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'xpdobro'))            { await relacionamentoHandler.handleXpDobro(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmd(cmdWord, 'aniversario_casal'))  { await relacionamentoHandler.handleAniversarioCasal(sock, msg, jid, author, senderJid, relacionamentos); return; }
  if (matchCmdStart(cmd, 'duelodecasais'))     { await relacionamentoHandler.handleDueloDeCasais(sock, msg, content, jid, author, senderJid, relacionamentos, contactNames); return; }
  if (matchCmd(cmdWord, 'rankcasais'))         { await relacionamentoHandler.handleRankCasais(sock, msg, jid, relacionamentos); return; }

  // ── ANIVERSÁRIOS ──────────────────────────────────────────────
  if (matchCmdStart(cmd, 'reganiversario'))
    { await aniversarioHandler.handleRegAniversario(sock, msg, jid, caption, author, senderJid); return; }
  if (matchCmd(cmdWord, 'excluiraniversario'))
    { await aniversarioHandler.handleExcluirAniversario(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'meuaniversario'))
    { await aniversarioHandler.handleMeuAniversario(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'listaniversarios'))
    { await aniversarioHandler.handleListAniversarios(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'sistemaniversario')) {
    const isAdm = await grupoHandler.isAdmin(sock, jid, senderJid).catch(() => false);
    await aniversarioHandler.handleSistemaAniversario(sock, msg, jid, isAdm);
    return;
  }

  // ── DIVERSÃO ──────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'gay'))           { await diversaoHandler.handleGay(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'sexo'))          { await diversaoHandler.handleSexo(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'nazista'))       { await diversaoHandler.handleNazista(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'lesbica'))       { await diversaoHandler.handleLesbica(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'aura'))          { await diversaoHandler.handleAura(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'podre'))         { await diversaoHandler.handlePodre(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'frango'))        { await diversaoHandler.handleFrango(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'dado'))          { await diversaoHandler.handleDado(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, '8ball'))         { await diversaoHandler.handle8ball(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'ship'))          { await diversaoHandler.handleShip(sock, msg, content, jid, contactNames); return; }
  if (matchCmdStart(cmd, 'compatibilidade')) { await diversaoHandler.handleCompatibilidade(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'rolar'))         { await diversaoHandler.handleRolar(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'xingar'))        { await diversaoHandler.handleXingar(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'elogio'))        { await diversaoHandler.handleElogio(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'crush'))         { await diversaoHandler.handleCrush(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'cantada'))       { await diversaoHandler.handleCantada(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'safadeza'))      { await diversaoHandler.handleSafadeza(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'tiro'))          { await diversaoHandler.handleTiro(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'morte'))         { await diversaoHandler.handleMorte(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'maldizer'))      { await diversaoHandler.handleMaldizer(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'fortuna'))       { await diversaoHandler.handleFortuna(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'julgamento'))    { await diversaoHandler.handleJulgamento(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'confissao'))     { await diversaoHandler.handleConfissao(sock, msg, content, jid, author); return; }
  if (matchCmdStart(cmd, 'verdadeoudesafio')) { await diversaoHandler.handleVerdadeOuDesafio(sock, msg, content, jid, author); return; }
  if (matchCmd(cmdWord, 'roletarussa'))    { await diversaoHandler.handleRoletaRussa(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'roletarussa2'))   { await diversaoHandler.handleRoletaRussa2(sock, msg, jid, author); return; }
  if (matchCmd(cmdWord, 'roletarussa3'))   { await diversaoHandler.handleRoletaRussa3(sock, msg, jid, author, senderJid); return; }
  if (matchCmdStart(cmd, 'falta'))         { await diversaoHandler.handleFalta(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmd(cmdWord, 'baterfalta'))     { await diversaoHandler.handleBaterFalta(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'eununca'))        { await diversaoHandler.handleEuNunca(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'quiz') || matchCmdStart(cmd, 'quiz '))
    { await diversaoHandler.handleQuiz(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'pontos'))         { await diversaoHandler.handlePontos(sock, msg, jid, author, senderJid); return; }
  if (matchCmd(cmdWord, 'rankjogos'))      { await diversaoHandler.handleRankJogos(sock, msg, jid, contactNames); return; }
  if (matchCmd(cmdWord, 'levelon'))        { await utilidadeHandler.handleLevelOn(sock, msg, jid, author); return; }
  if (matchCmd(cmdWord, 'level'))          { await utilidadeHandler.handleLevel(sock, msg, jid, author, msgCount); return; }
  if (matchCmd(cmdWord, 'ranklevel'))      { await utilidadeHandler.handleRankLevel(sock, msg, jid, contactNames, msgCount); return; }
  if (matchCmd(cmdWord, 'anagrama') || matchCmdStart(cmd, 'anagrama '))
    { await diversaoHandler.handleAnagrama(sock, msg, jid, author, senderJid); return; }
  if (matchCmdStart(cmd, 'ppt'))           { await diversaoHandler.handlePpt(sock, msg, jid, caption, author, senderJid); return; }

  // ── GRUPO ─────────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'ban'))          { await grupoHandler.handleBan(sock, msg, content, jid, botJid, contactNames); return; }
  if (matchCmdStart(cmd, 'mute'))         { await grupoHandler.handleMute(sock, msg, content, jid, botJid, mutedUsers, contactNames); return; }
  if (matchCmdStart(cmd, 'desmute'))      { await grupoHandler.handleDesmute(sock, msg, content, jid, botJid, mutedUsers, contactNames); return; }
  if (matchCmdStart(cmd, 'ranking'))      { await grupoHandler.handleRanking(sock, msg, jid, msgCount); return; }
  if (matchCmdStart(cmd, 'sorteio'))      { await grupoHandler.handleSorteio(sock, msg, content, jid, contactNames); return; }
  if (matchCmdStart(cmd, 'enquete'))      { await grupoHandler.handleEnquete(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'todos'))        { await grupoHandler.handleTodos(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'fechar'))       { await grupoHandler.handleFecharAbrir(sock, msg, jid, true); return; }
  if (matchCmdStart(cmd, 'abrir'))        { await grupoHandler.handleFecharAbrir(sock, msg, jid, false); return; }
  if (matchCmdStart(cmd, 'promover'))     { await grupoHandler.handlePromoverRebaixar(sock, msg, content, jid, 'promote', botJid, contactNames); return; }
  if (matchCmdStart(cmd, 'rebaixar'))     { await grupoHandler.handlePromoverRebaixar(sock, msg, content, jid, 'demote', botJid, contactNames); return; }
  if (matchCmdStart(cmd, 'tempo'))        { await grupoHandler.handleTempo(sock, msg, content, jid, author, contactNames); return; }
  if (matchCmdStart(cmd, 'antilink'))     { await grupoHandler.handleAntiLink(sock, msg, content, jid, antiLinkGroups, saveData); return; }
  if (matchCmdStart(cmd, 'autosticker'))  { await grupoHandler.handleAutoSticker(sock, msg, content, jid, autoStickerGroups, saveData); return; }
  if (matchCmdStart(cmd, 'reportar'))     { await grupoHandler.handleReportar(sock, msg, content, jid, warnings, contactNames, saveData, botJid); return; }
  // Novos de grupo
  if (matchCmd(cmdWord, 'grupinfo'))      { await grupoHandler.handleGrupInfo(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'listaadm'))      { await grupoHandler.handleListaAdm(sock, msg, jid, contactNames); return; }
  if (matchCmd(cmdWord, 'listamembros'))  { await grupoHandler.handleListaMembros(sock, msg, jid, contactNames); return; }
  if (matchCmdStart(cmd, 'bemvindo'))     { await grupoHandler.handleBemVindo(sock, msg, jid, caption); return; }
  if (matchCmd(cmdWord, 'linkgrupo'))     { await grupoHandler.handleLinkGrupo(sock, msg, jid); return; }
  if (matchCmdStart(cmd, 'apagarmsg'))    { await grupoHandler.handleApagarMsg(sock, msg, content, jid); return; }
  if (matchCmdStart(cmd, 'slowmode'))     { await grupoHandler.handleSlowMode(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'antiflood'))    { await grupoHandler.handleAntiFlood(sock, msg, jid, caption); return; }
  if (matchCmdStart(cmd, 'avisar'))       { await grupoHandler.handleAvisar(sock, msg, jid, caption, contactNames); return; }
  if (matchCmdStart(cmd, 'fixargrupo'))   { await grupoHandler.handleFixarGrupo(sock, msg, content, jid, caption); return; }

  // ── FILTROS DE IMAGEM (específicos antes dos genéricos) ───────
  if (matchCmdStart(cmd, 'pbiphone'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'pbiphone',  getPrefix); return; }
  if (matchCmdStart(cmd, 'pb'))         { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'pb',        getPrefix); return; }
  if (matchCmdStart(cmd, 'girar180'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'girar180',  getPrefix); return; }
  if (matchCmdStart(cmd, 'girar270'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'girar270',  getPrefix); return; }
  if (matchCmdStart(cmd, 'girar'))      { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'girar',     getPrefix); return; }
  if (matchCmdStart(cmd, 'pixelar'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'pixelar',   getPrefix); return; }
  if (matchCmdStart(cmd, 'pixel'))      { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'pixel',     getPrefix); return; }
  if (matchCmdStart(cmd, 'blur'))       { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'blur',      getPrefix); return; }
  if (matchCmdStart(cmd, 'espelhar'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'espelhar',  getPrefix); return; }
  if (matchCmdStart(cmd, 'flipv'))      { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'flipv',     getPrefix); return; }
  if (matchCmdStart(cmd, 'negativo'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'negativo',  getPrefix); return; }
  if (matchCmdStart(cmd, 'sepia'))      { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'sepia',     getPrefix); return; }
  if (matchCmdStart(cmd, 'vintage'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'vintage',   getPrefix); return; }
  if (matchCmdStart(cmd, 'brilho'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'brilho',    getPrefix); return; }
  if (matchCmdStart(cmd, 'contraste'))  { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'contraste', getPrefix); return; }
  if (matchCmdStart(cmd, 'saturar'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'saturar',   getPrefix); return; }
  if (matchCmdStart(cmd, 'nitido'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'nitido',    getPrefix); return; }
  if (matchCmdStart(cmd, 'corecore'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'corecore',  getPrefix); return; }
  if (matchCmdStart(cmd, 'desfazer'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'desfazer',  getPrefix); return; }
  if (matchCmdStart(cmd, 'sfundo'))     { await imagemHandler.handleSfundo(sock, msg, content, jid); return; }
  // Novos filtros
  if (matchCmdStart(cmd, 'cartoon'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'cartoon',   getPrefix); return; }
  if (matchCmdStart(cmd, 'glitch'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'glitch',    getPrefix); return; }
  if (matchCmdStart(cmd, 'vinheta'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'vinheta',   getPrefix); return; }
  if (matchCmdStart(cmd, 'radiancia'))  { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'radiancia', getPrefix); return; }
  if (matchCmdStart(cmd, 'matrix'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'matrix',    getPrefix); return; }
  if (matchCmdStart(cmd, 'polaroid'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'polaroid',  getPrefix); return; }
  if (matchCmdStart(cmd, 'sketch'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'sketch',    getPrefix); return; }
  if (matchCmdStart(cmd, 'calor'))      { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'calor',     getPrefix); return; }
  if (matchCmdStart(cmd, 'gelo'))       { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'gelo',      getPrefix); return; }
  if (matchCmdStart(cmd, 'dourado'))    { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'dourado',   getPrefix); return; }
  if (matchCmdStart(cmd, 'neon'))       { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'neon',      getPrefix); return; }
  if (matchCmdStart(cmd, 'cinema'))     { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'cinema',    getPrefix); return; }
  if (matchCmdStart(cmd, 'old'))        { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'old',       getPrefix); return; }
  if (matchCmdStart(cmd, 'halloween'))  { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'halloween', getPrefix); return; }
  if (matchCmdStart(cmd, 'aquarela'))   { await imagemHandler.handleImageFilter(sock, msg, content, jid, 'aquarela',  getPrefix); return; }

  // ── ALTERADORES ───────────────────────────────────────────────
  if (matchCmd(cmdWord, 'videolento'))     { await alteradoresHandler.handleVideoLento(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'videorapido'))    { await alteradoresHandler.handleVideoRapido(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'videocontrario')) { await alteradoresHandler.handleVideoContrario(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'reversevideo'))   { await alteradoresHandler.handleReverseVideo(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'audiolento'))     { await alteradoresHandler.handleAudioLento(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'audiorapido'))    { await alteradoresHandler.handleAudioRapido(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'grave'))          { await alteradoresHandler.handleGrave(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'esquilo'))        { await alteradoresHandler.handleEsquilo(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'bass'))           { await alteradoresHandler.handleBass(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozmenino'))      { await alteradoresHandler.handleVozMenino(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozgrossa'))      { await alteradoresHandler.handleVozGrossa(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozmulher'))      { await alteradoresHandler.handleVozMulher(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'audioreverse'))   { await alteradoresHandler.handleAudioReverse(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozrobo'))        { await alteradoresHandler.handleVozRobo(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozalien'))       { await alteradoresHandler.handleVozAlien(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozvelho'))       { await alteradoresHandler.handleVozVelho(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozcrianca'))     { await alteradoresHandler.handleVozCrianca(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'vozdemonio'))     { await alteradoresHandler.handleVozDemonio(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'eco'))            { await alteradoresHandler.handleEco(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'caverna'))        { await alteradoresHandler.handleCaverna(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'telefone'))       { await alteradoresHandler.handleTelefone(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'radio'))          { await alteradoresHandler.handleRadio(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'megafone'))       { await alteradoresHandler.handleMegafone(sock, msg, jid); return; }
  if (matchCmd(cmdWord, 'underwater'))     { await alteradoresHandler.handleUnderwater(sock, msg, jid); return; }

  // ── TEXTO ─────────────────────────────────────────────────────
  if (matchCmdStart(cmd, 'maiusculo'))  { await textoHandler.handleTextoFun(sock, msg, jid, caption, getPrefix, 'maiusculo'); return; }
  if (matchCmdStart(cmd, 'invertido'))  { await textoHandler.handleTextoFun(sock, msg, jid, caption, getPrefix, 'invertido'); return; }
  if (matchCmdStart(cmd, 'caixa'))      { await textoHandler.handleTextoFun(sock, msg, jid, caption, getPrefix, 'caixa');     return; }
}

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot Online!');
});

app.listen(port, () => {
  console.log(`Servidor web do bot rodando na porta ${port}`);
});

startBot().catch(console.error);
