require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const BANNER_BASE_URL = process.env.BANNER_BASE_URL;
const DEFAULT_BANNER_COUNT = Number(process.env.DEFAULT_BANNER_COUNT || 2);
const APP_DOWNLOAD_URL = process.env.APP_DOWNLOAD_URL || 'https://7starswin.com/downloads/androidclient/releases_android/7StarsWin/site/7StarsWin.apk';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();
const users = new Map();

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

function getSession(userId) {
  const id = String(userId);
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

function saveUser(ctx) {
  if (!ctx.from) return;
  users.set(String(ctx.from.id), {
    id: String(ctx.from.id),
    first_name: ctx.from.first_name || '',
    username: ctx.from.username || '',
    last_seen: new Date().toISOString()
  });
}

function mainKeyboard(ctx) {
  const rows = [
    [Markup.button.callback('🎨 Generate Promo Banner', 'promo_start')],
    [Markup.button.url('📱 Download App', APP_DOWNLOAD_URL)]
  ];

  if (isAdmin(ctx)) {
    rows.push([
      Markup.button.callback('📢 Broadcast', 'broadcast_start'),
      Markup.button.callback('📊 Bot Status', 'bot_status')
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

function languageKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🇺🇸 English', 'promo_lang_en'),
      Markup.button.callback('🇧🇩 Bangla', 'promo_lang_bn')
    ],
    [
      Markup.button.callback('🇮🇳 Hindi', 'promo_lang_hi'),
      Markup.button.callback('🇵🇰 Pakistani', 'promo_lang_pk')
    ],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
}

function categoryKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🏏 Sports', 'promo_category_sports'),
      Markup.button.callback('🎰 Casino', 'promo_category_casino')
    ],
    [Markup.button.callback('⚪ All', 'promo_category_all')],
    [Markup.button.callback('⬅️ Back', 'promo_start')]
  ]);
}

function broadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Send Broadcast', 'broadcast_confirm')],
    [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
  ]);
}

function safePromo(text) {
  return String(text || '')
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

async function getBannerUrls(lang, category = 'all') {
  if (!BANNER_BASE_URL) throw new Error('BANNER_BASE_URL missing');

  const base = BANNER_BASE_URL.replace(/\/$/, '');
  const langCode = lang === 'hi' ? 'in' : lang;

  function makeUrls(prefix) {
    return Array.from(
      { length: DEFAULT_BANNER_COUNT },
      (_, i) => `${base}/${prefix}${langCode}-${i + 1}.jpg`
    );
  }

  if (category === 'sports') return makeUrls('sports-banners-');
  if (category === 'casino') return makeUrls('casino-banners-');

  return [
    ...makeUrls('banners-'),
    ...makeUrls('sports-banners-'),
    ...makeUrls('casino-banners-')
  ];
}

async function downloadBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 12000,
    validateStatus: s => s >= 200 && s < 300
  });

  return Buffer.from(res.data);
}

function getTextSettings(width, promoCode) {
  const len = promoCode.length;

  let fontSize = width * 0.083;
  if (len > 10) fontSize = width * 0.073;
  if (len > 13) fontSize = width * 0.064;

  return {
    fontSize: Math.max(46, Math.min(fontSize, 108)),
    y: '92.5%'
  };
}

async function addPromoText(inputBuffer, promoCode) {
  const image = sharp(inputBuffer).rotate();
  const meta = await image.metadata();

  const width = meta.width || 1080;
  const height = meta.height || 1080;
  const { fontSize, y } = getTextSettings(width, promoCode);

  const text = escapeXml(promoCode);

  const svg = `
  <svg width="${width}" height="${height}">
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="7" stdDeviation="5" flood-color="#000000" flood-opacity="0.90"/>
      </filter>
    </defs>

    <text
      x="50%"
      y="${y}"
      text-anchor="middle"
      dominant-baseline="middle"
      font-family="Impact, Arial Black, Anton, Oswald, sans-serif"
      font-size="${fontSize}"
      font-weight="900"
      fill="#ffffff"
      stroke="#000000"
      stroke-width="7"
      paint-order="stroke fill"
      letter-spacing="2.5"
      filter="url(#shadow)"
    >${text}</text>
  </svg>`;

  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

async function processOneBanner(url, promoCode, index) {
  try {
    const raw = await downloadBuffer(url);
    const finalImage = await addPromoText(raw, promoCode);
    return { ok: true, image: finalImage, index, url };
  } catch (error) {
    console.log('Banner failed:', url, error.message);
    return { ok: false, index, url, error: error.message };
  }
}

async function generateBanners(ctx, promoCode, lang, category) {
  const started = Date.now();

  await ctx.reply(`⚡ Generating ${category.toUpperCase()} banners for: ${promoCode}`);

  const urls = await getBannerUrls(lang, category);

  const results = await Promise.all(
    urls.map((url, index) => processOneBanner(url, promoCode, index))
  );

  const images = results
    .filter(r => r.ok)
    .sort((a, b) => a.index - b.index)
    .map(r => ({
      type: 'photo',
      media: { source: r.image }
    }));

  let sent = 0;

  for (let i = 0; i < images.length; i += 10) {
    const group = images.slice(i, i + 10);
    await ctx.replyWithMediaGroup(group);
    sent += group.length;
  }

  const failed = results.filter(r => !r.ok).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  await ctx.reply(
    `✅ Done!\n\n🎁 Promo: ${promoCode}\n🌍 Language: ${lang.toUpperCase()}\n📂 Category: ${category}\n🖼 Sent: ${sent}\n❌ Failed: ${failed}\n⚡ Time: ${seconds}s`,
    mainKeyboard(ctx)
  );

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(
        adminId,
        `🎨 Banner Generated\n\n👤 User: ${ctx.from.first_name || ''} @${ctx.from.username || ''}\n🆔 ID: ${ctx.from.id}\n🎁 Promo: ${promoCode}\n🌍 Language: ${lang}\n📂 Category: ${category}\n🖼 Sent: ${sent}\n❌ Failed: ${failed}\n⚡ Time: ${seconds}s`
      );
    } catch {}
  }
}

bot.start(async ctx => {
  saveUser(ctx);

  await ctx.reply(
    `👋 Welcome ${ctx.from.first_name || ''}\n\nGenerate promo banners instantly.`,
    mainKeyboard(ctx)
  );
});

bot.action('main_menu', async ctx => {
  await ctx.answerCbQuery();
  saveUser(ctx);
  sessions.delete(String(ctx.from.id));

  await ctx.reply('🏠 Main Menu', mainKeyboard(ctx));
});

bot.action('promo_start', async ctx => {
  await ctx.answerCbQuery();
  saveUser(ctx);

  const s = getSession(ctx.from.id);
  s.flow = 'promo';

  await ctx.reply('🌍 Select banner language:', languageKeyboard());
});

bot.action(/^promo_lang_(.+)$/, async ctx => {
  await ctx.answerCbQuery();

  const lang = ctx.match[1];

  const s = getSession(ctx.from.id);
  s.lang = lang;

  await ctx.reply('📂 Select banner category:', categoryKeyboard());
});

bot.action(/^promo_category_(.+)$/, async ctx => {
  await ctx.answerCbQuery();

  const category = ctx.match[1];

  const s = getSession(ctx.from.id);
  s.category = category;
  s.waitingPromo = true;

  await ctx.reply('✏️ Send promo code now.\n\nExample: WELCOME20');
});

bot.action('bot_status', async ctx => {
  await ctx.answerCbQuery();

  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ Admin only');
  }

  const uptime = Math.floor(process.uptime());
  const minutes = Math.floor(uptime / 60);
  const seconds = uptime % 60;

  await ctx.reply(
    `📊 Bot Status\n\n✅ Status: Running\n👥 Users this session: ${users.size}\n🧠 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\n⏱ Uptime: ${minutes}m ${seconds}s\n🖼 Banner count setting: ${DEFAULT_BANNER_COUNT}\n🌐 Base URL: ${BANNER_BASE_URL || 'Missing'}`,
    mainKeyboard(ctx)
  );
});

bot.action('broadcast_start', async ctx => {
  await ctx.answerCbQuery();

  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ Admin only');
  }

  const s = getSession(ctx.from.id);
  s.flow = 'broadcast';
  s.waitingBroadcast = true;

  await ctx.reply('📢 Send broadcast text, photo, or video.\n\nI will show preview before sending.');
});

bot.action('broadcast_cancel', async ctx => {
  await ctx.answerCbQuery();
  sessions.delete(String(ctx.from.id));

  await ctx.reply('❌ Broadcast cancelled.', mainKeyboard(ctx));
});

bot.action('broadcast_confirm', async ctx => {
  await ctx.answerCbQuery();

  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ Admin only');
  }

  const s = getSession(ctx.from.id);

  if (!s.broadcast) {
    return ctx.reply('⚠️ No broadcast message found.');
  }

  const userIds = Array.from(users.keys());
  let sent = 0;
  let failed = 0;

  await ctx.reply(`📢 Sending broadcast to ${userIds.length} users...`);

  for (const userId of userIds) {
    try {
      if (s.broadcast.type === 'text') {
        await bot.telegram.sendMessage(userId, s.broadcast.text, {
          parse_mode: 'HTML'
        });
      }

      if (s.broadcast.type === 'photo') {
        await bot.telegram.sendPhoto(userId, s.broadcast.fileId, {
          caption: s.broadcast.caption || '',
          parse_mode: 'HTML'
        });
      }

      if (s.broadcast.type === 'video') {
        await bot.telegram.sendVideo(userId, s.broadcast.fileId, {
          caption: s.broadcast.caption || '',
          parse_mode: 'HTML'
        });
      }

      sent++;
      await new Promise(r => setTimeout(r, 35));
    } catch {
      failed++;
    }
  }

  sessions.delete(String(ctx.from.id));

  await ctx.reply(
    `✅ Broadcast complete.\n\nSent: ${sent}\nFailed: ${failed}`,
    mainKeyboard(ctx)
  );
});

bot.on('message', async ctx => {
  saveUser(ctx);

  const s = getSession(ctx.from.id);

  if (s.waitingBroadcast && isAdmin(ctx)) {
    if (ctx.message.text) {
      s.broadcast = {
        type: 'text',
        text: ctx.message.text
      };

      s.waitingBroadcast = false;

      return ctx.reply(
        `📢 Broadcast Preview:\n\n${ctx.message.text}`,
        broadcastConfirmKeyboard()
      );
    }

    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];

      s.broadcast = {
        type: 'photo',
        fileId: photo.file_id,
        caption: ctx.message.caption || ''
      };

      s.waitingBroadcast = false;

      return ctx.replyWithPhoto(photo.file_id, {
        caption: `📢 Broadcast Preview\n\n${ctx.message.caption || ''}`,
        ...broadcastConfirmKeyboard()
      });
    }

    if (ctx.message.video) {
      s.broadcast = {
        type: 'video',
        fileId: ctx.message.video.file_id,
        caption: ctx.message.caption || ''
      };

      s.waitingBroadcast = false;

      return ctx.replyWithVideo(ctx.message.video.file_id, {
        caption: `📢 Broadcast Preview\n\n${ctx.message.caption || ''}`,
        ...broadcastConfirmKeyboard()
      });
    }

    return ctx.reply('⚠️ Send text, photo, or video only.');
  }

  if (s.waitingPromo && ctx.message.text) {
    s.waitingPromo = false;

    const promoCode = safePromo(ctx.message.text);

    if (!promoCode || promoCode.length < 3) {
      return ctx.reply('⚠️ Invalid promo code. Use at least 3 letters or numbers.');
    }

    const lang = s.lang || 'en';
    const category = s.category || 'all';

    try {
      await generateBanners(ctx, promoCode, lang, category);
    } catch (error) {
      console.log(error);

      await ctx.reply(
        '⚠️ Error generating banners. Please check hosting image links and BANNER_BASE_URL.'
      );
    }

    return;
  }

  await ctx.reply('Use menu:', mainKeyboard(ctx));
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx?.reply?.('⚠️ Something went wrong. Please try again.').catch(() => {});
});

bot.launch();

console.log('Bot running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
