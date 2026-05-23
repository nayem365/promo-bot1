require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const JSZip = require('jszip');
const fs = require('fs/promises');
const path = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const BANNER_BASE_URL = (process.env.BANNER_BASE_URL || '').replace(/\/$/, '');
const APP_DOWNLOAD_URL = process.env.APP_DOWNLOAD_URL || 'https://example.com/app.apk';
const PUBLIC_BANNER_LIST = (process.env.BANNER_LIST || '').trim();

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();

const dbFile = path.join(__dirname, 'db.json');
const db = new Low(new JSONFile(dbFile), { users: {}, submissions: [], broadcasts: [] });

const LANGS = {
  en: '🇺🇸 English',
  bn: '🇧🇩 Bangla',
  hi: '🇮🇳 Hindi',
  pk: '🇵🇰 Pakistani'
};

const STYLE_PRESETS = {
  modern: {
    label: '✨ Modern',
    fill: '#ffffff',
    stroke: '#111111',
    strokeWidth: 6,
    shadow: true,
    y: '91%',
    fontScale: 0.085
  },
  gold: {
    label: '🏆 Gold',
    fill: '#FFD966',
    stroke: '#4A2500',
    strokeWidth: 7,
    shadow: true,
    y: '91%',
    fontScale: 0.085
  },
  clean: {
    label: '⚪ Clean',
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 3,
    shadow: false,
    y: '91%',
    fontScale: 0.08
  }
};

async function initDb() {
  await db.read();
  db.data ||= { users: {}, submissions: [], broadcasts: [] };
  await db.write();
}

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

function getSession(ctx) {
  const id = String(ctx.from.id);
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

async function registerUser(ctx) {
  await db.read();
  const id = String(ctx.from.id);
  db.data.users[id] = {
    id,
    username: ctx.from.username || '',
    first_name: ctx.from.first_name || '',
    last_name: ctx.from.last_name || '',
    last_seen: new Date().toISOString()
  };
  await db.write();
}

function mainKeyboard(ctx) {
  const rows = [
    [Markup.button.callback('🎨 Generate Promo Banners', 'promo_start')],
    [Markup.button.callback('📱 Download App', 'download_app')]
  ];
  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback('📢 Broadcast', 'broadcast_start')]);
    rows.push([Markup.button.callback('📊 Stats', 'admin_stats')]);
  }
  return Markup.inlineKeyboard(rows);
}

function langKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LANGS.en, 'promo_lang_en'), Markup.button.callback(LANGS.bn, 'promo_lang_bn')],
    [Markup.button.callback(LANGS.hi, 'promo_lang_hi'), Markup.button.callback(LANGS.pk, 'promo_lang_pk')],
    [Markup.button.callback('⬅️ Back', 'back_main')]
  ]);
}

function styleKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(STYLE_PRESETS.modern.label, 'promo_style_modern'),
      Markup.button.callback(STYLE_PRESETS.gold.label, 'promo_style_gold')
    ],
    [Markup.button.callback(STYLE_PRESETS.clean.label, 'promo_style_clean')],
    [Markup.button.callback('⬅️ Back', 'promo_start')]
  ]);
}

function finalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Generate All Images', 'promo_generate_all')],
    [Markup.button.callback('📦 Send ZIP Also', 'promo_generate_zip')],
    [Markup.button.callback('✏️ Change Promo Code', 'promo_change_code')],
    [Markup.button.callback('🎨 Change Style', 'promo_change_style')],
    [Markup.button.callback('🏠 Main Menu', 'back_main')]
  ]);
}

function safePromoCode(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 15);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getBannerUrls(lang) {
  if (PUBLIC_BANNER_LIST) {
    const res = await axios.get(PUBLIC_BANNER_LIST, { timeout: 15000 });
    const list = res.data;
    if (Array.isArray(list)) return list.filter(u => String(u).includes(`/${lang}/`) || String(u).includes(`-${lang}-`));
    if (list && Array.isArray(list[lang])) return list[lang];
  }

  if (!BANNER_BASE_URL) throw new Error('BANNER_BASE_URL missing');

  // Simple default naming system:
  // https://your-host.com/banners/en/1.jpg ... 10.jpg
  const count = Number(process.env.DEFAULT_BANNER_COUNT || 10);
  return Array.from({ length: count }, (_, i) => `${BANNER_BASE_URL}/${lang}/${i + 1}.jpg`);
}

async function downloadBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: s => s >= 200 && s < 300
  });
  return Buffer.from(res.data);
}

async function makeBanner(inputBuffer, promoCode, styleName = 'modern') {
  const style = STYLE_PRESETS[styleName] || STYLE_PRESETS.modern;
  const image = sharp(inputBuffer).rotate();
  const meta = await image.metadata();
  const width = meta.width || 1080;
  const height = meta.height || 1080;
  const fontSize = Math.max(46, Math.min(width * style.fontScale, 112));
  const shadow = style.shadow
    ? `<text x="50%" y="${style.y}" text-anchor="middle" font-family="Impact, Arial Black, Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="rgba(0,0,0,.55)" letter-spacing="3" dx="4" dy="5">${escapeXml(promoCode)}</text>`
    : '';

  const svg = `
  <svg width="${width}" height="${height}">
    ${shadow}
    <text x="50%" y="${style.y}" text-anchor="middle"
      font-family="Impact, Arial Black, Arial, sans-serif"
      font-size="${fontSize}" font-weight="900"
      fill="${style.fill}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"
      paint-order="stroke fill" letter-spacing="3">${escapeXml(promoCode)}</text>
  </svg>`;

  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 94 })
    .toBuffer();
}

async function generateBanners(ctx, sendZip = false) {
  const s = getSession(ctx);
  const lang = s.lang;
  const promo = s.promo;
  const style = s.style || 'modern';

  if (!lang || !promo) return ctx.reply('⚠️ Please start again.');

  await ctx.reply(`⏳ Processing banners for promo code: ${promo}`);

  const urls = await getBannerUrls(lang);
  const media = [];
  const zip = new JSZip();
  let ok = 0, failed = 0;

  for (let i = 0; i < urls.length; i++) {
    try {
      const raw = await downloadBuffer(urls[i]);
      const out = await makeBanner(raw, promo, style);
      ok++;
      zip.file(`${promo}_${lang}_${i + 1}.jpg`, out);
      media.push({ type: 'photo', media: { source: out } });

      if (media.length === 10) {
        await ctx.replyWithMediaGroup(media.splice(0, 10));
        await new Promise(r => setTimeout(r, 900));
      }
    } catch (e) {
      failed++;
      console.error('Banner failed:', urls[i], e.message);
    }
  }

  if (media.length) await ctx.replyWithMediaGroup(media);

  if (sendZip && ok > 0) {
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    await ctx.replyWithDocument({
      source: zipBuffer,
      filename: `${promo}_${lang}_banners.zip`
    });
  }

  await db.read();
  db.data.submissions.push({
    userId: String(ctx.from.id),
    promo,
    lang,
    style,
    ok,
    failed,
    date: new Date().toISOString()
  });
  await db.write();

  await ctx.reply(
    `✅ Complete!\n\nPromo: ${promo}\nLanguage: ${lang.toUpperCase()}\nSent: ${ok}\nFailed: ${failed}`,
    Markup.inlineKeyboard([
      [Markup.button.url('📱 Download App', APP_DOWNLOAD_URL)],
      [Markup.button.callback('🏠 Main Menu', 'back_main')]
    ])
  );

  for (const adminId of ADMIN_IDS) {
    if (adminId !== String(ctx.from.id)) {
      bot.telegram.sendMessage(
        adminId,
        `🎨 Banner Generated\nUser: ${ctx.from.first_name || ''} @${ctx.from.username || ''}\nID: ${ctx.from.id}\nPromo: ${promo}\nLang: ${lang}\nStyle: ${style}\nSuccess: ${ok}\nFailed: ${failed}`
      ).catch(() => {});
    }
  }
}

bot.start(async ctx => {
  await registerUser(ctx);
  await ctx.reply(
    `👋 Welcome ${ctx.from.first_name || ''}!\n\nUse this bot to generate promo banners instantly.`,
    mainKeyboard(ctx)
  );
});

bot.action('back_main', async ctx => {
  await ctx.answerCbQuery();
  await registerUser(ctx);
  sessions.delete(String(ctx.from.id));
  await ctx.editMessageText('🏠 Main Menu', mainKeyboard(ctx)).catch(() => ctx.reply('🏠 Main Menu', mainKeyboard(ctx)));
});

bot.action('download_app', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(`📱 Download app here:\n${APP_DOWNLOAD_URL}`);
});

bot.action('promo_start', async ctx => {
  await ctx.answerCbQuery();
  await registerUser(ctx);
  const s = getSession(ctx);
  s.flow = 'promo';
  await ctx.editMessageText('🌍 Select banner language:', langKeyboard()).catch(() => ctx.reply('🌍 Select banner language:', langKeyboard()));
});

bot.action(/^promo_lang_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const lang = ctx.match[1];
  const s = getSession(ctx);
  s.lang = lang;
  await ctx.editMessageText('🎨 Select promo text style:', styleKeyboard()).catch(() => ctx.reply('🎨 Select promo text style:', styleKeyboard()));
});

bot.action(/^promo_style_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const style = ctx.match[1];
  const s = getSession(ctx);
  s.style = style;
  s.waiting = 'promo_code';
  await ctx.reply('✏️ Send your promo code now.\n\nExample: WELCOME100');
});

bot.action('promo_change_code', async ctx => {
  await ctx.answerCbQuery();
  const s = getSession(ctx);
  s.waiting = 'promo_code';
  await ctx.reply('✏️ Send new promo code:');
});

bot.action('promo_change_style', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('🎨 Select new style:', styleKeyboard());
});

bot.action('promo_generate_all', async ctx => {
  await ctx.answerCbQuery();
  await generateBanners(ctx, false);
});

bot.action('promo_generate_zip', async ctx => {
  await ctx.answerCbQuery();
  await generateBanners(ctx, true);
});

bot.action('admin_stats', async ctx => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only');
  await db.read();
  const users = Object.keys(db.data.users || {}).length;
  const submissions = db.data.submissions.length;
  const broadcasts = db.data.broadcasts.length;
  await ctx.reply(`📊 Bot Stats\n\nUsers: ${users}\nBanner requests: ${submissions}\nBroadcasts: ${broadcasts}`);
});

bot.action('broadcast_start', async ctx => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only');
  const s = getSession(ctx);
  s.flow = 'broadcast';
  s.waiting = 'broadcast_message';
  await ctx.reply('📢 Send broadcast text, photo, or video.\n\nI will show preview before sending.');
});

bot.action('broadcast_cancel', async ctx => {
  await ctx.answerCbQuery();
  sessions.delete(String(ctx.from.id));
  await ctx.reply('❌ Broadcast cancelled.', mainKeyboard(ctx));
});

bot.action('broadcast_confirm', async ctx => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only');

  const s = getSession(ctx);
  if (!s.broadcast) return ctx.reply('⚠️ No broadcast found.');

  await db.read();
  const users = Object.keys(db.data.users || {});
  let sent = 0, failed = 0;

  await ctx.reply(`📢 Sending broadcast to ${users.length} users...`);

  for (const userId of users) {
    try {
      if (s.broadcast.type === 'text') {
        await bot.telegram.sendMessage(userId, s.broadcast.text, { parse_mode: 'HTML' });
      } else if (s.broadcast.type === 'photo') {
        await bot.telegram.sendPhoto(userId, s.broadcast.file_id, { caption: s.broadcast.caption || '', parse_mode: 'HTML' });
      } else if (s.broadcast.type === 'video') {
        await bot.telegram.sendVideo(userId, s.broadcast.file_id, { caption: s.broadcast.caption || '', parse_mode: 'HTML' });
      }
      sent++;
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
    }
  }

  db.data.broadcasts.push({
    adminId: String(ctx.from.id),
    type: s.broadcast.type,
    sent,
    failed,
    date: new Date().toISOString()
  });
  await db.write();

  sessions.delete(String(ctx.from.id));
  await ctx.reply(`✅ Broadcast complete.\n\nSent: ${sent}\nFailed: ${failed}`, mainKeyboard(ctx));
});

bot.on('message', async ctx => {
  await registerUser(ctx);
  const s = getSession(ctx);

  if (s.waiting === 'promo_code' && ctx.message.text) {
    const promo = safePromoCode(ctx.message.text);
    if (!promo || promo.length < 3) return ctx.reply('⚠️ Invalid promo code. Use at least 3 letters/numbers.');
    s.promo = promo;
    s.waiting = null;

    try {
      const urls = await getBannerUrls(s.lang);
      const raw = await downloadBuffer(urls[0]);
      const preview = await makeBanner(raw, promo, s.style || 'modern');
      await ctx.replyWithPhoto({ source: preview }, {
        caption: `👀 Preview\n\nPromo: ${promo}\nLanguage: ${s.lang.toUpperCase()}\nStyle: ${s.style || 'modern'}`,
        ...finalKeyboard()
      });
    } catch (e) {
      console.error(e);
      await ctx.reply('⚠️ Could not create preview. Check BANNER_BASE_URL / BANNER_LIST image links.');
    }
    return;
  }

  if (s.waiting === 'broadcast_message' && isAdmin(ctx)) {
    if (ctx.message.text) {
      s.broadcast = { type: 'text', text: ctx.message.text };
      s.waiting = null;
      await ctx.reply(`📢 Preview:\n\n${ctx.message.text}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Send Broadcast', 'broadcast_confirm')],
        [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
      ]));
      return;
    }

    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      s.broadcast = { type: 'photo', file_id: photo.file_id, caption: ctx.message.caption || '' };
      s.waiting = null;
      await ctx.replyWithPhoto(photo.file_id, {
        caption: `📢 Preview\n\n${ctx.message.caption || ''}`,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Send Broadcast', 'broadcast_confirm')],
          [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
        ])
      });
      return;
    }

    if (ctx.message.video) {
      s.broadcast = { type: 'video', file_id: ctx.message.video.file_id, caption: ctx.message.caption || '' };
      s.waiting = null;
      await ctx.replyWithVideo(ctx.message.video.file_id, {
        caption: `📢 Preview\n\n${ctx.message.caption || ''}`,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Send Broadcast', 'broadcast_confirm')],
          [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
        ])
      });
      return;
    }

    return ctx.reply('⚠️ Send text, photo, or video only.');
  }

  await ctx.reply('Use menu:', mainKeyboard(ctx));
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx?.reply?.('⚠️ Something went wrong. Please try again.').catch(() => {});
});

(async () => {
  await initDb();
  await bot.launch();
  console.log('Bot running...');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
