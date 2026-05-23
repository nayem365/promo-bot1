require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');

const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim());

const BANNER_BASE_URL =
  process.env.BANNER_BASE_URL;

const DEFAULT_BANNER_COUNT = Number(
  process.env.DEFAULT_BANNER_COUNT || 2
);

const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {});
  }

  return sessions.get(userId);
}

function categoryKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🏏 Sports',
        'promo_category_sports'
      ),
      Markup.button.callback(
        '🎰 Casino',
        'promo_category_casino'
      )
    ],
    [
      Markup.button.callback(
        '⚪ All',
        'promo_category_all'
      )
    ]
  ]);
}

async function getBannerUrls(
  lang,
  category = 'all'
) {
  if (!BANNER_BASE_URL) {
    throw new Error(
      'BANNER_BASE_URL missing'
    );
  }

  const base =
    BANNER_BASE_URL.replace(/\/$/, '');

  const langCode =
    lang === 'hi'
      ? 'in'
      : lang;

  function makeUrls(prefix) {
    return Array.from(
      {
        length:
          DEFAULT_BANNER_COUNT
      },
      (_, i) =>
        `${base}/${prefix}${langCode}-${i + 1}.jpg`
    );
  }

  // SPORTS
  if (category === 'sports') {
    return makeUrls(
      'sports-banners-'
    );
  }

  // CASINO
  if (category === 'casino') {
    return makeUrls(
      'casino-banners-'
    );
  }

  // ALL
  return [
    ...makeUrls('banners-'),
    ...makeUrls(
      'sports-banners-'
    ),
    ...makeUrls(
      'casino-banners-'
    )
  ];
}

async function downloadBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer'
  });

  return Buffer.from(res.data);
}

async function addPromoText(
  inputBuffer,
  promoCode
) {
  const image = sharp(inputBuffer);

  const meta =
    await image.metadata();

  const width =
    meta.width || 1080;

  const height =
    meta.height || 1080;

  const fontSize = Math.max(
    50,
    Math.min(
      width * 0.085,
      120
    )
  );

  const svg = `
  <svg width="${width}" height="${height}">
  
    <text
      x="50%"
      y="91%"
      text-anchor="middle"
      font-family="Impact, Arial Black"
      font-size="${fontSize}"
      font-weight="900"
      fill="white"
      stroke="black"
      stroke-width="6"
      paint-order="stroke fill"
      letter-spacing="3"
    >
      ${promoCode}
    </text>

  </svg>
  `;

  return await image
    .composite([
      {
        input: Buffer.from(svg),
        top: 0,
        left: 0
      }
    ])
    .jpeg({
      quality: 95
    })
    .toBuffer();
}

bot.start(async ctx => {
  await ctx.reply(
    '🌍 Select Banner Language',
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🇺🇸 English',
          'promo_lang_en'
        ),
        Markup.button.callback(
          '🇧🇩 Bangla',
          'promo_lang_bn'
        )
      ],

      [
        Markup.button.callback(
          '🇮🇳 Hindi',
          'promo_lang_hi'
        ),
        Markup.button.callback(
          '🇵🇰 Pakistani',
          'promo_lang_pk'
        )
      ]
    ])
  );
});

bot.action(
  /^promo_lang_(.+)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const lang =
      ctx.match[1];

    const session =
      getSession(ctx.from.id);

    session.lang = lang;

    await ctx.reply(
      '📂 Select Banner Category',
      categoryKeyboard()
    );
  }
);

bot.action(
  /^promo_category_(.+)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const category =
      ctx.match[1];

    const session =
      getSession(ctx.from.id);

    session.category =
      category;

    session.waitingPromo = true;

    await ctx.reply(
      '✏️ Send Promo Code\n\nExample: WELCOME100'
    );
  }
);

bot.on('text', async ctx => {
  const session =
    getSession(ctx.from.id);

  if (!session.waitingPromo) {
    return;
  }

  session.waitingPromo = false;

  const promoCode =
    ctx.message.text
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ''
      )
      .slice(0, 15);

  const lang =
    session.lang;

  const category =
    session.category;

  await ctx.reply(
    `⏳ Generating banners for ${promoCode}`
  );

  try {
    const urls =
      await getBannerUrls(
        lang,
        category
      );

    const media = [];

    let count = 0;

    for (
      let i = 0;
      i < urls.length;
      i++
    ) {
      try {
        const buffer =
          await downloadBuffer(
            urls[i]
          );

        const finalImage =
          await addPromoText(
            buffer,
            promoCode
          );

        media.push({
          type: 'photo',
          media: {
            source:
              finalImage
          }
        });

        count++;

        // Telegram limit = 10
        if (
          media.length === 10
        ) {
          await ctx.replyWithMediaGroup(
            media.splice(
              0,
              10
            )
          );
        }
      } catch (err) {
        console.log(
          'Banner failed:',
          urls[i]
        );
      }
    }

    if (media.length > 0) {
      await ctx.replyWithMediaGroup(
        media
      );
    }

    await ctx.reply(
      `✅ Done\n\nGenerated ${count} banners`
    );

    // ADMIN LOG
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          adminId,

          `🎨 Banner Generated

👤 User: ${ctx.from.first_name}

🎁 Promo: ${promoCode}

🌍 Language: ${lang}

📂 Category: ${category}

🖼 Generated: ${count}`
        );
      } catch (e) {}
    }
  } catch (err) {
    console.log(err);

    await ctx.reply(
      '⚠️ Error generating banners'
    );
  }
});

bot.launch();

console.log('Bot running...');
