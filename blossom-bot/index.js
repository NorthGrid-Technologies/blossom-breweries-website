require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  WebhookClient,
} = require('discord.js');
const http  = require('http');
const https = require('https');

// ── Discord client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
  ],
});

// ── Order store: messageId → { type, data } ──────────────
// type: 'order' | 'drink-brief'
const orderStore = new Map();

// ── Outbound webhook clients ──────────────────────────────
const completedWebhook = new WebhookClient({ url: process.env.COMPLETED_ORDERS_WEBHOOK });
const cancelledWebhook = new WebhookClient({ url: process.env.CANCELLED_ORDERS_WEBHOOK });

// Channel ID resolved from NEW_ORDERS_WEBHOOK on startup
let newOrdersChannelId = null;

// ── Logging ───────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Fetch webhook metadata via HTTPS (no external deps) ──
function fetchWebhookInfo(webhookUrl) {
  return new Promise((resolve, reject) => {
    https.get(webhookUrl, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse webhook response')); }
      });
    }).on('error', reject);
  });
}

// ── Parse JSON body from an incoming http.IncomingMessage ─
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Build Discord embed fields from an order object ───────
// Handles both fresh orders (items array) and reconstructed
// orders from embed text (_rawOrderLines).
function buildEmbedFields(order) {
  const orderLines =
    order.items && order.items.length > 0
      ? order.items
          .map(i => `${i.qty} × ${i.name} — £${(i.qty * i.price).toFixed(2)}`)
          .join('\n')
      : order._rawOrderLines || 'No items';

  const addressValue = order.city
    ? `${order.address}, ${order.city}`
    : order.address;

  const shippingDisplay =
    Number(order.shipping) === 0 ? 'FREE' : `£${Number(order.shipping).toFixed(2)}`;

  return [
    { name: '👤 Customer',         value: String(order.customerName),                       inline: true  },
    { name: '💬 Discord',          value: String(order.discordUsername || order.email || ''), inline: true  },
    { name: '📦 Delivery Address', value: addressValue,                                      inline: false },
    { name: '📞 Phone',            value: String(order.phoneNumber || order.postcode || ''), inline: true  },
    { name: '🛒 Order',            value: orderLines,                                        inline: false },
    { name: '💰 Subtotal',  value: `£${Number(order.subtotal).toFixed(2)}`, inline: true },
    { name: '🚚 Shipping',  value: shippingDisplay,                         inline: true },
    { name: '✅ Total',     value: `£${Number(order.total).toFixed(2)}`,    inline: true },
    { name: '📝 Notes',     value: String(order.notes || 'None'),           inline: false },
  ];
}

// ── Build Discord embed fields from a drink-brief object ──
function buildDrinkBriefFields(brief) {
  const flavours = Array.isArray(brief.flavourProfile)
    ? brief.flavourProfile.join(', ')
    : (brief.flavourProfile || '');

  return [
    { name: '👤 Name',            value: String(brief.name || 'Unknown'),          inline: true  },
    { name: '💬 Discord',          value: String(brief.discordUsername || ''),     inline: true  },
    { name: '🥃 Base Spirit',     value: String(brief.baseSpirit || 'Not specified'), inline: false },
    { name: '🌸 Flavour Profile', value: flavours || 'None',                        inline: false },
    { name: '✨ Inspiration',     value: String(brief.inspiration || 'Not specified'), inline: false },
    { name: '🎯 Occasion',        value: String(brief.occasion    || 'Not specified'), inline: false },
  ];
}

// ── Reconstruct a minimal order object from an embed ──────
// Used when restoring orders from channel history on startup.
function reconstructFromEmbed(embed) {
  const f = {};
  (embed.fields || []).forEach(field => { f[field.name] = field.value; });

  const shippingRaw = f['🚚 Shipping'] || '£0';
  const shipping = shippingRaw === 'FREE'
    ? 0
    : parseFloat(shippingRaw.replace('£', '')) || 0;

  return {
    customerName:    f['👤 Customer']         || 'Unknown',
    discordUsername: f['💬 Discord']          || '',
    address:         f['📦 Delivery Address'] || '',
    city:            '',
    phoneNumber:     f['📞 Phone']            || '',
    items:           [],
    _rawOrderLines:  f['🛒 Order']            || '',
    subtotal: parseFloat((f['💰 Subtotal'] || '£0').replace('£', '')) || 0,
    shipping,
    total:    parseFloat((f['✅ Total']    || '£0').replace('£', '')) || 0,
    notes:    f['📝 Notes'] || 'None',
  };
}

// ── Reconstruct a drink-brief object from an embed ────────
function reconstructDrinkBriefFromEmbed(embed) {
  const f = {};
  (embed.fields || []).forEach(field => { f[field.name] = field.value; });

  const flavoursRaw = f['🌸 Flavour Profile'] || '';
  const flavourProfile = flavoursRaw && flavoursRaw !== 'None'
    ? flavoursRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    name:            f['👤 Name']            || 'Unknown',
    discordUsername: f['💬 Discord']          || '',
    baseSpirit:      f['🥃 Base Spirit']     || '',
    flavourProfile,
    inspiration:     f['✨ Inspiration']     || '',
    occasion:        f['🎯 Occasion']        || '',
  };
}

// ── Build a complete embed from an order + title + color ──
function buildEmbed(title, color, order, extraField = null) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(...buildEmbedFields(order))
    .setFooter({ text: 'Blossom Breweries · Los Santos, San Andreas' })
    .setTimestamp();

  if (extraField) embed.addFields(extraField);
  return embed;
}

// ── Build a complete embed from a drink brief ─────────────
function buildDrinkBriefEmbed(title, color, brief, extraField = null) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(...buildDrinkBriefFields(brief))
    .setFooter({ text: 'Blossom Breweries · Create a Drink' })
    .setTimestamp();

  if (extraField) embed.addFields(extraField);
  return embed;
}

// ── Bot ready ─────────────────────────────────────────────
client.once('ready', async () => {
  log('🌸 Blossom Bot is online');

  try {
    const info = await fetchWebhookInfo(process.env.NEW_ORDERS_WEBHOOK);
    newOrdersChannelId = info.channel_id;
    log(`New-orders channel resolved: ${newOrdersChannelId}`);

    // Restore pending orders/briefs from the last 50 channel messages
    const channel  = await client.channels.fetch(newOrdersChannelId);
    const messages = await channel.messages.fetch({ limit: 50 });
    let restored = 0;

    messages.forEach(msg => {
      if (msg.author.id !== client.user.id || msg.embeds.length === 0) return;
      const embed = msg.embeds[0];
      const title = embed.title || '';

      if (title.startsWith('🍹')) {
        orderStore.set(msg.id, {
          type: 'drink-brief',
          data: reconstructDrinkBriefFromEmbed(embed),
        });
        restored++;
      } else if (title.startsWith('🍺')) {
        orderStore.set(msg.id, {
          type: 'order',
          data: reconstructFromEmbed(embed),
        });
        restored++;
      }
    });

    log(`Restored ${restored} pending item(s) from channel history`);
  } catch (err) {
    log(`ERROR during startup restore: ${err.message}`);
  }

  startHttpServer();
});

// ── Reaction handler ──────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  try {
    // Resolve partials
    if (reaction.partial) await reaction.fetch();
    if (user.partial)     await user.fetch();

    const emoji     = reaction.emoji.name;
    const messageId = reaction.message.id;

    if (emoji !== '✅' && emoji !== '❌')  return;

    const entry = orderStore.get(messageId);
    if (!entry) return;
    const { type, data } = entry;
    const username = user.tag ?? user.username;

    if (type === 'order') {
      // ── Complete ──────────────────────────────────────────
      if (emoji === '✅') {
        const embed = buildEmbed('✅ Order Completed', 0x57F287, data, {
          name: 'Completed By', value: username, inline: false,
        });
        await completedWebhook.send({ embeds: [embed] });
        log(`Order ${messageId} marked as COMPLETED by ${username}`);

      // ── Cancel ────────────────────────────────────────────
      } else {
        const embed = buildEmbed('❌ Order Cancelled', 0xED4245, data, {
          name: 'Cancelled By', value: username, inline: false,
        });
        await cancelledWebhook.send({ embeds: [embed] });
        log(`Order ${messageId} marked as CANCELLED by ${username}`);
      }

    } else if (type === 'drink-brief') {
      // ── Approve ───────────────────────────────────────────
      if (emoji === '✅') {
        const embed = buildDrinkBriefEmbed('✅ Drink Brief Approved', 0x57F287, data, {
          name: 'Handled By', value: username, inline: false,
        });
        await completedWebhook.send({ embeds: [embed] });
        log(`Drink brief ${messageId} APPROVED by ${username}`);

      // ── Decline ───────────────────────────────────────────
      } else {
        const embed = buildDrinkBriefEmbed('❌ Drink Brief Declined', 0xED4245, data, {
          name: 'Handled By', value: username, inline: false,
        });
        await cancelledWebhook.send({ embeds: [embed] });
        log(`Drink brief ${messageId} DECLINED by ${username}`);
      }
    }

    // Delete original #new-orders message
    try {
      const msg = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;
      await msg.delete();
    } catch (err) {
      log(`WARN: Could not delete message ${messageId}: ${err.message}`);
    }

    orderStore.delete(messageId);

  } catch (err) {
    log(`ERROR in reaction handler: ${err.message}`);
  }
});

// ── HTTP server (receives orders from order.html) ─────────
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers so the browser page can POST locally
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/new-order') {
      try {
        if (!newOrdersChannelId) {
          throw new Error('Bot not fully ready — channel ID not yet resolved');
        }

        const order   = await readBody(req);
        const channel = await client.channels.fetch(newOrdersChannelId);
        const embed   = buildEmbed('🍺 New Blossom Breweries Order', 0xCB6F87, order);

        // TODO: Add Discord ping here — replace DISCORD_USER_ID with your actual ID
        // Example: await channel.send({ content: "<@DISCORD_USER_ID>", embeds: [embed] });
        // Add "content" as a top-level field alongside "embeds" in the channel.send payload.
        const message = await channel.send({ embeds: [embed] });

        // Add reaction controls for staff
        await message.react('✅');
        await message.react('❌');

        orderStore.set(message.id, { type: 'order', data: order });
        log(`New order — ID: ${message.id} — customer: ${order.customerName}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, messageId: message.id }));

      } catch (err) {
        log(`ERROR handling /new-order: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/new-drink') {
      try {
        if (!newOrdersChannelId) {
          throw new Error('Bot not fully ready — channel ID not yet resolved');
        }

        const brief   = await readBody(req);
        const channel = await client.channels.fetch(newOrdersChannelId);
        const embed   = buildDrinkBriefEmbed('🍹 New Drink Creation Brief', 0xCB6F87, brief);

        // TODO: Add Discord ping here — replace DISCORD_USER_ID with your actual ID
        // Example: await channel.send({ content: "<@DISCORD_USER_ID>", embeds: [embed] });
        // Add "content" as a top-level field alongside "embeds" in the channel.send payload.
        const message = await channel.send({ embeds: [embed] });

        // Add reaction controls for staff
        await message.react('✅');
        await message.react('❌');

        orderStore.set(message.id, { type: 'drink-brief', data: brief });
        log(`New drink brief — ID: ${message.id} — name: ${brief.name}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, messageId: message.id }));

      } catch (err) {
        log(`ERROR handling /new-drink: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(3000, () => {
    log('HTTP server listening on :3000');
  });
}

// ── Start ─────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
