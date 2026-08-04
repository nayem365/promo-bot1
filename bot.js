'use strict';

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const JSZip = require('jszip');

const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const BANNER_BASE_URL = (process.env.BANNER_BASE_URL || '').replace(/\/$/, '');

const APP_DOWNLOAD_URL =
  process.env.APP_DOWNLOAD_URL || 'https://7starswin.com';

const PROMO_TEXT_X = Number(process.env.PROMO_TEXT_X || 50);
const PROMO_TEXT_Y = Number(process.env.PROMO_TEXT_Y || 85.2);
const PROMO_FONT_SIZE = Number(process.env.PROMO_FONT_SIZE || 0);

const PROCESS_CONCURRENCY = Math.max(
  1,
  Number(process.env.PROCESS_CONCURRENCY || 3)
);

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN missing');
}

if (!BANNER_BASE_URL) {
  throw new Error('BANNER_BASE_URL missing');
}

const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();
const users = new Map();

const languageNames = {
  ru: 'Russian',
  en: 'English',
  bn: 'Bangla',
  hi: 'Hindi',
  pk: 'Urdu / Pakistan',
  th: 'Thai'
};

const categoryNames = {
  sports: 'Sports',
  casino: 'Casino',
  games: 'Games',
  all: 'All'
};

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

function getSession(userId) {
  const id = String(userId);

  if (!sessions.has(id)) {
    sessions.set(id, {});
  }

  return sessions.get(id);
}

function saveUser(ctx) {
  if (!ctx.from) {
    return;
  }

  users.set(String(ctx.from.id), {
    id: String(ctx.from.id),
    firstName: ctx.from.first_name || '',
    lastName: ctx.from.last_name || '',
    username: ctx.from.username || ''
  });
}

function mainKeyboard(ctx) {
  const rows = [
    [
      Markup.button.callback(
        '🎨 Find Promo Banners',
        'promo_start'
      )
    ],
    [
      Markup.button.url(
        '📱 Download App',
        APP_DOWNLOAD_URL
      )
    ]
  ];

  if (isAdmin(ctx)) {
    rows.push([
      Markup.button.callback(
        '📢 Broadcast',
        'broadcast_start'
      ),
      Markup.button.callback(
        '📊 Bot Status',
        'bot_status'
      )
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

function languageKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🇷🇺 RU', 'lang_ru'),
      Markup.button.callback('🇬🇧 EN', 'lang_en')
    ],
    [
      Markup.button.callback('🇧🇩 BN', 'lang_bn'),
      Markup.button.callback('🇮🇳 HI', 'lang_hi')
    ],
    [
      Markup.button.callback('🇵🇰 PK', 'lang_pk'),
      Markup.button.callback('🇹🇭 TH', 'lang_th')
    ],
    [
      Markup.button.callback(
        '🏠 Main Menu',
        'main_menu'
      )
    ]
  ]);
}

function categoryKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🏏 Sports',
        'cat_sports'
      ),
      Markup.button.callback(
        '🎰 Casino',
        'cat_casino'
      )
    ],
    [
      Markup.button.callback(
        '🎮 Games',
        'cat_games'
      ),
      Markup.button.callback(
        '📦 ALL',
        'cat_all'
      )
    ],
    [
      Markup.button.callback(
        '⬅️ Back',
        'promo_start'
      )
    ]
  ]);
}

function broadcastKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '✅ Send Broadcast',
        'broadcast_confirm'
      )
    ],
    [
      Markup.button.callback(
        '❌ Cancel',
        'broadcast_cancel'
      )
    ]
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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getCategoryPrefixes(category) {
  if (category === 'sports') {
    return ['sports-banners-'];
  }

  if (category === 'casino') {
    return ['casino-banners-'];
  }

  if (category === 'games') {
    return ['games-banners-'];
  }

  return [
    'sports-banners-',
    'casino-banners-',
    'games-banners-'
  ];
}

function getFileCategory(filename) {
  const name = String(filename).toLowerCase();

  if (name.startsWith('sports-banners-')) {
    return 'sports';
  }

  if (name.startsWith('casino-banners-')) {
    return 'casino';
  }

  if (name.startsWith('games-banners-')) {
    return 'games';
  }

  return 'other';
}

function parseRawGithubUrl() {
  const match = BANNER_BASE_URL.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    branch: match[3],
    folder: match[4]
  };
}

async function findBanners(language, category) {
  const github = parseRawGithubUrl();

  if (!github) {
    throw new Error(
      'Use BANNER_BASE_URL like: https://raw.githubusercontent.com/USERNAME/REPOSITORY/main/banners'
    );
  }

  const encodedFolder = github.folder
    .split('/')
    .map(folderPart => encodeURIComponent(folderPart))
    .join('/');

  const apiUrl =
    `https://api.github.com/repos/${github.owner}/${github.repo}` +
    `/contents/${encodedFolder}?ref=${encodeURIComponent(github.branch)}`;

  const response = await axios.get(apiUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'promo-banner-broadcast-bot',
      Accept: 'application/vnd.github+json'
    }
  });

  if (!Array.isArray(response.data)) {
    throw new Error('GitHub banner folder was not found');
  }

  const wantedPrefixes =
    getCategoryPrefixes(category);

  return response.data
    .filter(file => file.type === 'file')
    .map(file => ({
      name: String(file.name).toLowerCase(),
      originalName: file.name,
      url: file.download_url,
      category: getFileCategory(file.name)
    }))
    .filter(file => {
      const correctLanguage =
        wantedPrefixes.some(prefix =>
          file.name.startsWith(
            `${prefix}${language}-`
          )
        );

      const correctExtension =
        /\.(jpg|jpeg|png|webp)$/i.test(
          file.name
        );

      return (
        correctLanguage &&
        correctExtension &&
        file.url
      );
    })
    .sort((first, second) => {
      const categoryOrder = {
        sports: 1,
        casino: 2,
        games: 3,
        other: 4
      };

      const firstOrder =
        categoryOrder[first.category] || 4;

      const secondOrder =
        categoryOrder[second.category] || 4;

      if (firstOrder !== secondOrder) {
        return firstOrder - secondOrder;
      }

      const firstNumber = Number(
        first.name.match(/-(\d+)\./)?.[1] || 0
      );

      const secondNumber = Number(
        second.name.match(/-(\d+)\./)?.[1] || 0
      );

      return firstNumber - secondNumber;
    });
}

function calculateFontSize(width, promoCode) {
  if (PROMO_FONT_SIZE > 0) {
    return PROMO_FONT_SIZE;
  }

  let fontSize = width * 0.06;

  if (promoCode.length <= 6) {
    fontSize = width * 0.07;
  }

  if (promoCode.length >= 9) {
    fontSize = width * 0.055;
  }

  if (promoCode.length >= 11) {
    fontSize = width * 0.05;
  }

  if (promoCode.length >= 13) {
    fontSize = width * 0.045;
  }

  return Math.max(
    30,
    Math.min(fontSize, 90)
  );
}

async function addPromoCode(
  bannerUrl,
  promoCode
) {
  const response = await axios.get(
    bannerUrl,
    {
      responseType: 'arraybuffer',
      timeout: 25000,
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024,
      validateStatus: status =>
        status >= 200 && status < 300
    }
  );

  const inputBuffer = Buffer.from(
    response.data
  );

  const image = sharp(inputBuffer, {
    failOn: 'none'
  }).rotate();

  const metadata = await image.metadata();

  const width = metadata.width || 1080;
  const height = metadata.height || 1080;

  const fontSize = calculateFontSize(
    width,
    promoCode
  );

  const escapedPromoCode =
    escapeXml(promoCode);

  const svg = `
    <svg
      width="${width}"
      height="${height}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter
          id="shadow"
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="3"
            flood-color="#000000"
            flood-opacity="0.90"
          />
        </filter>
      </defs>

      <text
        x="${PROMO_TEXT_X}%"
        y="${PROMO_TEXT_Y}%"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="Arial Black, DejaVu Sans, sans-serif"
        font-size="${fontSize}"
        font-weight="900"
        fill="#FFFFFF"
        stroke="#000000"
        stroke-width="5"
        paint-order="stroke fill"
        letter-spacing="2"
        filter="url(#shadow)"
      >${escapedPromoCode}</text>
    </svg>
  `;

  return image
    .composite([
      {
        input: Buffer.from(svg),
        top: 0,
        left: 0
      }
    ])
    .jpeg({
      quality: 88,
      mozjpeg: true
    })
    .toBuffer();
}

async function mapWithLimit(
  items,
  limit,
  worker
) {
  const results = new Array(items.length);

  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      results[currentIndex] =
        await worker(
          items[currentIndex],
          currentIndex
        );
    }
  }

  const workerCount = Math.min(
    Math.max(1, limit),
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => runWorker()
    )
  );

  return results;
}

async function sendGeneratedImages(
  ctx,
  generatedBanners
) {
  let sent = 0;

  for (
    let index = 0;
    index < generatedBanners.length;
    index += 10
  ) {
    const group =
      generatedBanners.slice(
        index,
        index + 10
      );

    if (group.length === 1) {
      await ctx.replyWithPhoto({
        source: group[0].image,
        filename: group[0].name
      });

      sent += 1;
      continue;
    }

    const mediaGroup = group.map(
      banner => ({
        type: 'photo',
        media: {
          source: banner.image,
          filename: banner.name
        }
      })
    );

    await ctx.replyWithMediaGroup(
      mediaGroup
    );

    sent += mediaGroup.length;
  }

  return sent;
}

async function createAllBannersZip(
  generatedBanners,
  promoCode,
  language
) {
  const zip = new JSZip();

  const rootFolder = zip.folder(
    `${promoCode}-${language}-all`
  );

  for (const banner of generatedBanners) {
    const categoryFolder =
      rootFolder.folder(
        banner.category
      );

    categoryFolder.file(
      banner.name,
      banner.image
    );
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 6
    }
  });
}

async function generateBanners(
  ctx,
  promoCode,
  language,
  category
) {
  const startedAt = Date.now();

  await ctx.reply(
    `⚡ Finding banners...\n\n` +
    `🌍 Language: ${languageNames[language]}\n` +
    `📂 Category: ${categoryNames[category]}\n` +
    `🎁 Promo: ${promoCode}`
  );

  const bannerFiles =
    await findBanners(
      language,
      category
    );

  if (!bannerFiles.length) {
    await ctx.reply(
      '⚠️ No banners found.\n\n' +
      'Check your banner filenames and BANNER_BASE_URL.'
    );

    return;
  }

  await ctx.reply(
    `🔎 Found ${bannerFiles.length} banner(s).\n` +
    'Adding the promo code now...'
  );

  const processedResults =
    await mapWithLimit(
      bannerFiles,
      PROCESS_CONCURRENCY,
      async (file, index) => {
        try {
          const generatedImage =
            await addPromoCode(
              file.url,
              promoCode
            );

          const outputName =
            file.originalName.replace(
              /\.(jpg|jpeg|png|webp)$/i,
              '.jpg'
            );

          return {
            ok: true,
            index,
            image: generatedImage,
            category: file.category,
            name: outputName
          };
        } catch (error) {
          console.error(
            `Banner failed: ${file.originalName}`,
            error.message
          );

          return {
            ok: false,
            index,
            filename: file.originalName
          };
        }
      }
    );

  const successfulBanners =
    processedResults
      .filter(result => result.ok)
      .sort(
        (first, second) =>
          first.index - second.index
      );

  const failedCount =
    processedResults.filter(
      result => !result.ok
    ).length;

  if (!successfulBanners.length) {
    await ctx.reply(
      '⚠️ All banners failed to process.\n\n' +
      'Check the Heroku logs and banner image links.'
    );

    return;
  }

  const sentCount =
    await sendGeneratedImages(
      ctx,
      successfulBanners
    );

  let zipSent = false;

  if (
    category === 'all' &&
    successfulBanners.length
  ) {
    try {
      await ctx.reply(
        '📦 Creating ZIP file with all banners...'
      );

      const zipBuffer =
        await createAllBannersZip(
          successfulBanners,
          promoCode,
          language
        );

      await ctx.replyWithDocument(
        {
          source: zipBuffer,
          filename:
            `${promoCode}-${language}-all-banners.zip`
        },
        {
          caption:
            '📦 Download all Sports, Casino and Games banners.'
        }
      );

      zipSent = true;
    } catch (error) {
      console.error(
        'ZIP creation failed:',
        error
      );

      await ctx.reply(
        '⚠️ Images were sent, but ZIP creation failed.'
      );
    }
  }

  const seconds = (
    (Date.now() - startedAt) /
    1000
  ).toFixed(1);

  await ctx.reply(
    `✅ Done!\n\n` +
    `🎁 Promo: ${promoCode}\n` +
    `🌍 Language: ${languageNames[language]}\n` +
    `📂 Category: ${categoryNames[category]}\n` +
    `🖼 Sent: ${sentCount}\n` +
    `📦 ZIP: ${zipSent ? 'Yes' : 'No'}\n` +
    `❌ Failed: ${failedCount}\n` +
    `⚡ Time: ${seconds}s`,
    mainKeyboard(ctx)
  );

  for (const adminId of ADMIN_IDS) {
    try {
      const userDisplay =
        ctx.from.username
          ? `@${ctx.from.username}`
          : 'No username';

      await bot.telegram.sendMessage(
        adminId,
        `🎨 Banner Generated\n\n` +
        `👤 Name: ${ctx.from.first_name || ''}\n` +
        `🔗 Username: ${userDisplay}\n` +
        `🆔 User ID: ${ctx.from.id}\n` +
        `🎁 Promo: ${promoCode}\n` +
        `🌍 Language: ${languageNames[language]}\n` +
        `📂 Category: ${categoryNames[category]}\n` +
        `🖼 Sent: ${sentCount}\n` +
        `❌ Failed: ${failedCount}`
      );
    } catch (error) {
      console.error(
        `Admin notification failed for ${adminId}:`,
        error.message
      );
    }
  }
}

bot.start(async ctx => {
  saveUser(ctx);

  sessions.delete(
    String(ctx.from.id)
  );

  await ctx.reply(
    `👋 Welcome ${ctx.from.first_name || ''}\n\n` +
    'Select a language and banner category.',
    mainKeyboard(ctx)
  );
});

bot.command('menu', async ctx => {
  saveUser(ctx);

  sessions.delete(
    String(ctx.from.id)
  );

  await ctx.reply(
    '🏠 Main Menu',
    mainKeyboard(ctx)
  );
});

bot.action(
  'main_menu',
  async ctx => {
    await ctx.answerCbQuery();

    sessions.delete(
      String(ctx.from.id)
    );

    await ctx.reply(
      '🏠 Main Menu',
      mainKeyboard(ctx)
    );
  }
);

bot.action(
  'promo_start',
  async ctx => {
    await ctx.answerCbQuery();

    saveUser(ctx);

    const session =
      getSession(ctx.from.id);

    session.waitingPromo = false;

    delete session.language;
    delete session.category;

    await ctx.reply(
      '🌍 Select banner language:',
      languageKeyboard()
    );
  }
);

bot.action(
  /^lang_(ru|en|bn|hi|pk|th)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    session.language =
      ctx.match[1];

    session.waitingPromo = false;

    await ctx.reply(
      `✅ Language: ${languageNames[session.language]}\n\n` +
      '📂 Select banner category:',
      categoryKeyboard()
    );
  }
);

bot.action(
  /^cat_(sports|casino|games|all)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (!session.language) {
      await ctx.reply(
        '⚠️ Select a language first.',
        languageKeyboard()
      );

      return;
    }

    session.category =
      ctx.match[1];

    session.waitingPromo = true;

    await ctx.reply(
      `✅ Category: ${categoryNames[session.category]}\n\n` +
      '✏️ Send your promo code now.\n\n' +
      'Example: WELCOME20'
    );
  }
);

bot.action(
  'bot_status',
  async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
      await ctx.reply(
        '⛔ Admin only'
      );

      return;
    }

    const uptimeSeconds =
      Math.floor(
        process.uptime()
      );

    const uptimeHours =
      Math.floor(
        uptimeSeconds / 3600
      );

    const uptimeMinutes =
      Math.floor(
        (uptimeSeconds % 3600) /
        60
      );

    const memoryMb =
      Math.round(
        process.memoryUsage().rss /
        1024 /
        1024
      );

    await ctx.reply(
      `📊 Bot Status\n\n` +
      `✅ Status: Running\n` +
      `👥 Users this session: ${users.size}\n` +
      `🧠 Memory: ${memoryMb} MB\n` +
      `⏱ Uptime: ${uptimeHours}h ${uptimeMinutes}m\n` +
      `📍 Promo X: ${PROMO_TEXT_X}%\n` +
      `📍 Promo Y: ${PROMO_TEXT_Y}%\n` +
      `🔠 Fixed font: ${PROMO_FONT_SIZE || 'Automatic'}\n` +
      `⚙️ Concurrency: ${PROCESS_CONCURRENCY}\n` +
      `🌐 Banner URL: ${BANNER_BASE_URL}`,
      mainKeyboard(ctx)
    );
  }
);

bot.action(
  'broadcast_start',
  async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
      await ctx.reply(
        '⛔ Admin only'
      );

      return;
    }

    const session =
      getSession(ctx.from.id);

    session.waitingBroadcast = true;

    delete session.broadcast;

    await ctx.reply(
      '📢 Send broadcast text, photo, or video.\n\n' +
      'The bot will show a preview before sending.'
    );
  }
);

bot.action(
  'broadcast_cancel',
  async ctx => {
    await ctx.answerCbQuery();

    sessions.delete(
      String(ctx.from.id)
    );

    await ctx.reply(
      '❌ Broadcast cancelled.',
      mainKeyboard(ctx)
    );
  }
);

bot.action(
  'broadcast_confirm',
  async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
      await ctx.reply(
        '⛔ Admin only'
      );

      return;
    }

    const session =
      getSession(ctx.from.id);

    if (!session.broadcast) {
      await ctx.reply(
        '⚠️ No broadcast message found.'
      );

      return;
    }

    const userIds =
      Array.from(users.keys());

    let sent = 0;
    let failed = 0;

    await ctx.reply(
      `📢 Sending broadcast to ${userIds.length} user(s)...`
    );

    for (const userId of userIds) {
      try {
        const broadcast =
          session.broadcast;

        if (
          broadcast.type === 'text'
        ) {
          await bot.telegram.sendMessage(
            userId,
            broadcast.text,
            {
              parse_mode: 'HTML'
            }
          );
        }

        if (
          broadcast.type === 'photo'
        ) {
          await bot.telegram.sendPhoto(
            userId,
            broadcast.fileId,
            {
              caption:
                broadcast.caption || '',
              parse_mode: 'HTML'
            }
          );
        }

        if (
          broadcast.type === 'video'
        ) {
          await bot.telegram.sendVideo(
            userId,
            broadcast.fileId,
            {
              caption:
                broadcast.caption || '',
              parse_mode: 'HTML'
            }
          );
        }

        sent += 1;

        await sleep(50);
      } catch (error) {
        failed += 1;

        console.error(
          `Broadcast failed for ${userId}:`,
          error.message
        );
      }
    }

    sessions.delete(
      String(ctx.from.id)
    );

    await ctx.reply(
      `✅ Broadcast complete.\n\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}`,
      mainKeyboard(ctx)
    );
  }
);

bot.on(
  'message',
  async ctx => {
    saveUser(ctx);

    const session =
      getSession(ctx.from.id);

    if (
      session.waitingBroadcast &&
      isAdmin(ctx)
    ) {
      if (ctx.message.text) {
        session.broadcast = {
          type: 'text',
          text: ctx.message.text
        };

        session.waitingBroadcast =
          false;

        await ctx.reply(
          `📢 Broadcast Preview:\n\n${ctx.message.text}`,
          broadcastKeyboard()
        );

        return;
      }

      if (
        Array.isArray(
          ctx.message.photo
        ) &&
        ctx.message.photo.length
      ) {
        const photo =
          ctx.message.photo[
            ctx.message.photo.length - 1
          ];

        session.broadcast = {
          type: 'photo',
          fileId: photo.file_id,
          caption:
            ctx.message.caption || ''
        };

        session.waitingBroadcast =
          false;

        await ctx.replyWithPhoto(
          photo.file_id,
          {
            caption:
              `📢 Broadcast Preview\n\n` +
              `${ctx.message.caption || ''}`,
            ...broadcastKeyboard()
          }
        );

        return;
      }

      if (ctx.message.video) {
        session.broadcast = {
          type: 'video',
          fileId:
            ctx.message.video.file_id,
          caption:
            ctx.message.caption || ''
        };

        session.waitingBroadcast =
          false;

        await ctx.replyWithVideo(
          ctx.message.video.file_id,
          {
            caption:
              `📢 Broadcast Preview\n\n` +
              `${ctx.message.caption || ''}`,
            ...broadcastKeyboard()
          }
        );

        return;
      }

      await ctx.reply(
        '⚠️ Send text, photo, or video only.'
      );

      return;
    }

    if (
      session.waitingPromo &&
      ctx.message.text
    ) {
      const promoCode =
        safePromo(
          ctx.message.text
        );

      if (
        !promoCode ||
        promoCode.length < 3
      ) {
        await ctx.reply(
          '⚠️ Invalid promo code.\n\n' +
          'Use at least 3 letters or numbers.'
        );

        return;
      }

      if (
        !session.language ||
        !session.category
      ) {
        session.waitingPromo =
          false;

        await ctx.reply(
          '⚠️ Please select language and category again.',
          languageKeyboard()
        );

        return;
      }

      session.waitingPromo =
        false;

      try {
        await generateBanners(
          ctx,
          promoCode,
          session.language,
          session.category
        );
      } catch (error) {
        console.error(
          'Generation error:',
          error
        );

        await ctx.reply(
          `⚠️ Error generating banners.\n\n` +
          `${error.message}\n\n` +
          'Check the Heroku logs, banner filenames and BANNER_BASE_URL.',
          mainKeyboard(ctx)
        );
      }

      return;
    }

    await ctx.reply(
      'Use the menu below:',
      mainKeyboard(ctx)
    );
  }
);

bot.catch((error, ctx) => {
  console.error(
    'Bot error:',
    error
  );

  if (ctx?.reply) {
    ctx
      .reply(
        '⚠️ Something went wrong. Please try again.'
      )
      .catch(() => {});
  }
});

bot.launch()
  .then(() => {
    console.log(
      'Promo banner bot is running...'
    );
  })
  .catch(error => {
    console.error(
      'Failed to launch bot:',
      error
    );

    process.exit(1);
  });

process.once(
  'SIGINT',
  () => bot.stop('SIGINT')
);

process.once(
  'SIGTERM',
  () => bot.stop('SIGTERM')
);
