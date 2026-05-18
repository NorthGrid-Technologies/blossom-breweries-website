require('dotenv').config();

// Required env vars: DISCORD_BOT_TOKEN, NEW_ORDERS_WEBHOOK,
// COMPLETED_ORDERS_WEBHOOK, CANCELLED_ORDERS_WEBHOOK,
// CAD_NEW_ORDERS_WEBHOOK, CAD_COMPLETED_ORDERS_WEBHOOK,
// CAD_CANCELLED_ORDERS_WEBHOOK, FLEECA_API_KEY, FLEECA_MODE,
// ADMIN_KEY
// TODO: Add ADMIN_KEY to fly secrets and .env

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

// ── Promo codes: code → { discount, createdBy, createdAt } ──
const promoCodes = new Map();
// Structure: promoCodes.set('CODE', { discount: 10, createdBy: 'username', createdAt: Date })

// ── Order store: messageId → { type, data } ──────────────
// type: 'order' | 'drink-brief'
const orderStore = new Map();

// Temporary store for orders awaiting Fleeca payment confirmation
// keyed by payment_id
const pendingOrders = new Map();

// ── Outbound webhook clients ──────────────────────────────
// Regular orders (#new-orders channel)
const completedWebhook = new WebhookClient({ url: process.env.COMPLETED_ORDERS_WEBHOOK });
const cancelledWebhook = new WebhookClient({ url: process.env.CANCELLED_ORDERS_WEBHOOK });

// Create-a-Drink briefs (#cad-new-orders channel)
const cadCompletedWebhook = new WebhookClient({ url: process.env.CAD_COMPLETED_ORDERS_WEBHOOK });
const cadCancelledWebhook = new WebhookClient({ url: process.env.CAD_CANCELLED_ORDERS_WEBHOOK });

// Channel IDs resolved from webhooks on startup
let newOrdersChannelId    = null; // #new-orders
let cadNewOrdersChannelId = null; // #cad-new-orders

// ── Logging ───────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Env var validation ────────────────────────────────────
['FLEECA_API_KEY', 'FLEECA_MODE'].forEach(key => {
  if (!process.env[key]) log(`WARN: ${key} is not set — Fleeca payments will fail`);
});

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

  const fields = [
    { name: '👤 Customer',         value: String(order.customerName),                       inline: true  },
    { name: '💬 Discord',          value: String(order.discordUsername || order.email || ''), inline: true  },
    { name: '📦 Delivery Address', value: addressValue,                                      inline: false },
    { name: '📞 Phone',            value: String(order.phoneNumber || order.postcode || ''), inline: true  },
    { name: '🛒 Order',            value: orderLines,                                        inline: false },
    { name: '💰 Subtotal',  value: `$${Number(order.subtotal).toFixed(2)}`, inline: true },
    { name: '🚚 Shipping',  value: shippingDisplay,                         inline: true },
  ];

  if (order.promoCode && order.discountAmount > 0) {
    fields.push({ name: '🎟️ Promo Code', value: `${order.promoCode} (${order.discountPercent}% off)`, inline: true });
    fields.push({ name: '💸 Discount',   value: `-$${Number(order.discountAmount).toFixed(2)}`,        inline: true });
  }

  fields.push({ name: '✅ Total',  value: `$${Number(order.total).toFixed(2)}`, inline: true });
  fields.push({ name: '📝 Notes', value: String(order.notes || 'None'),         inline: false });

  return fields;
}

// ── Build Discord embed fields from a drink-brief object ──
function buildDrinkBriefFields(brief) {
  const flavours = Array.isArray(brief.flavourProfile)
    ? brief.flavourProfile.join(', ')
    : (brief.flavourProfile || '');

  return [
    { name: '👤 Name',            value: String(brief.name || 'Unknown'),          inline: true  },
    { name: '💬 Discord',          value: String(brief.discordUsername || ''),     inline: true  },
    { name: '📞 Phone',            value: String(brief.phoneNumber || 'Not provided'), inline: true  },
    { name: '🥃 Base Spirit',     value: String(brief.baseSpirit || 'Not specified'), inline: false },
    { name: '🌸 Flavour Profile', value: flavours || 'None',                        inline: false },
    { name: '✨ Inspiration',     value: String(brief.inspiration || 'Not specified'), inline: false },
    { name: '🎯 Occasion',        value: String(brief.occasion    || 'Not specified'), inline: false },
    { name: '🍺 Beers & Beverages', value: `${brief.beersQty ?? 0} × $100 = $${((brief.beersQty ?? 0) * 100).toFixed(2)}`, inline: true },
    { name: '🥃 Liquor',           value: `${brief.liquorQty ?? 0} × $200 = $${((brief.liquorQty ?? 0) * 200).toFixed(2)}`, inline: true },
    { name: '💰 Estimated Total',  value: `$${((brief.beersQty ?? 0) * 100 + (brief.liquorQty ?? 0) * 200).toFixed(2)}`, inline: true },
  ];
}

// ── Reconstruct a minimal order object from an embed ──────
// Used when restoring orders from channel history on startup.
function reconstructFromEmbed(embed) {
  const f = {};
  (embed.fields || []).forEach(field => { f[field.name] = field.value; });

  const shippingRaw = f['🚚 Shipping'] || '$0';
  const shipping = shippingRaw === 'FREE'
    ? 0
    : parseFloat(shippingRaw.replace('$', '')) || 0;

  return {
    customerName:    f['👤 Customer']         || 'Unknown',
    discordUsername: f['💬 Discord']          || '',
    address:         f['📦 Delivery Address'] || '',
    city:            '',
    phoneNumber:     f['📞 Phone']            || '',
    items:           [],
    _rawOrderLines:  f['🛒 Order']            || '',
    subtotal: parseFloat((f['💰 Subtotal'] || '$0').replace('$', '')) || 0,
    shipping,
    total:    parseFloat((f['✅ Total']    || '$0').replace('$', '')) || 0,
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
    // ── Resolve #new-orders channel and restore pending orders ──
    const ordersInfo = await fetchWebhookInfo(process.env.NEW_ORDERS_WEBHOOK);
    newOrdersChannelId = ordersInfo.channel_id;
    log(`New-orders channel resolved: ${newOrdersChannelId}`);

    const ordersChannel  = await client.channels.fetch(newOrdersChannelId);
    const ordersMessages = await ordersChannel.messages.fetch({ limit: 50 });
    let restored = 0;

    ordersMessages.forEach(msg => {
      if (msg.author.id !== client.user.id || msg.embeds.length === 0) return;
      const embed = msg.embeds[0];
      const title = embed.title || '';
      if (title.startsWith('🍺')) {
        orderStore.set(msg.id, { type: 'order', data: reconstructFromEmbed(embed) });
        restored++;
      }
    });

    log(`Restored ${restored} pending order(s) from #new-orders`);
  } catch (err) {
    log(`ERROR restoring #new-orders: ${err.message}`);
  }

  try {
    // ── Resolve #cad-new-orders channel and restore pending drink briefs ──
    const cadInfo = await fetchWebhookInfo(process.env.CAD_NEW_ORDERS_WEBHOOK);
    cadNewOrdersChannelId = cadInfo.channel_id;
    log(`CAD new-orders channel resolved: ${cadNewOrdersChannelId}`);

    const cadChannel  = await client.channels.fetch(cadNewOrdersChannelId);
    const cadMessages = await cadChannel.messages.fetch({ limit: 50 });
    let cadRestored = 0;

    cadMessages.forEach(msg => {
      if (msg.author.id !== client.user.id || msg.embeds.length === 0) return;
      const embed = msg.embeds[0];
      const title = embed.title || '';
      if (title.startsWith('🍹')) {
        orderStore.set(msg.id, { type: 'drink-brief', data: reconstructDrinkBriefFromEmbed(embed) });
        cadRestored++;
      }
    });

    log(`Restored ${cadRestored} pending drink brief(s) from #cad-new-orders`);
  } catch (err) {
    log(`ERROR restoring #cad-new-orders: ${err.message}`);
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
        await cadCompletedWebhook.send({ embeds: [embed] });
        log(`Drink brief ${messageId} APPROVED by ${username}`);

      // ── Decline ───────────────────────────────────────────
      } else {
        const embed = buildDrinkBriefEmbed('❌ Drink Brief Declined', 0xED4245, data, {
          name: 'Handled By', value: username, inline: false,
        });
        await cadCancelledWebhook.send({ embeds: [embed] });
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Admin: Add promo code ─────────────────────────────
    if (req.method === 'POST' && req.url === '/admin/promo/add') {
      try {
        const body = await readBody(req);
        if (body.adminKey !== process.env.ADMIN_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
          return;
        }
        const code = String(body.code || '').toUpperCase().trim();
        const discount = Number(body.discount);
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Code is required' }));
          return;
        }
        if (isNaN(discount) || discount < 1 || discount > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Discount must be between 1 and 100' }));
          return;
        }
        promoCodes.set(code, { discount, createdBy: 'admin', createdAt: new Date() });
        log(`Promo code added: ${code} (${discount}%)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, code, discount }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // ── Admin: Remove promo code ──────────────────────────
    if (req.method === 'POST' && req.url === '/admin/promo/remove') {
      try {
        const body = await readBody(req);
        if (body.adminKey !== process.env.ADMIN_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
          return;
        }
        const code = String(body.code || '').toUpperCase().trim();
        if (!promoCodes.has(code)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Code not found' }));
          return;
        }
        promoCodes.delete(code);
        log(`Promo code removed: ${code}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // ── Admin: List promo codes ───────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/admin/promo/list')) {
      const urlParams = new URL(req.url, 'http://localhost').searchParams;
      const adminKey  = urlParams.get('adminKey') || '';
      if (adminKey !== process.env.ADMIN_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
        return;
      }
      const codes = [];
      promoCodes.forEach((val, code) => {
        codes.push({ code, discount: val.discount, createdAt: val.createdAt });
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, codes }));
      return;
    }

    // ── Public: Validate promo code ───────────────────────
    if (req.method === 'POST' && req.url === '/validate-promo') {
      try {
        const body = await readBody(req);
        const code = String(body.code || '').toUpperCase().trim();
        const entry = promoCodes.get(code);
        if (!entry) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid promo code' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, discount: entry.discount }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/create-payment') {
      try {
        const order = await readBody(req);

        // Apply promo discount if valid
        let discountAmount = 0;
        let discountPercent = 0;
        let appliedPromoCode = null;
        if (order.promoCode) {
          const promoEntry = promoCodes.get(String(order.promoCode).toUpperCase().trim());
          if (promoEntry) {
            discountPercent = promoEntry.discount;
            discountAmount = (Number(order.subtotal) * discountPercent) / 100;
            appliedPromoCode = String(order.promoCode).toUpperCase().trim();
          }
        }

        const discountedSubtotal = Number(order.subtotal) - discountAmount;
        const shipping = discountedSubtotal >= 80 ? 0 : (discountedSubtotal > 0 ? 8.99 : 0);
        const finalTotal = discountedSubtotal + shipping;

        // Enrich order with server-validated discount values
        order.promoCode      = appliedPromoCode;
        order.discountPercent = discountPercent;
        order.discountAmount  = discountAmount;
        order.shipping        = shipping;
        order.total           = finalTotal;

        const description = `Blossom Breweries Order — ${order.customerName}`.slice(0, 255);
        const amount = Math.round(finalTotal);
        const mode = parseInt(process.env.FLEECA_MODE) || 0;

        // Call Fleeca API
        const fleecaRes = await new Promise((resolve, reject) => {
          const body = JSON.stringify({ amount, mode, description });
          const options = {
            hostname: 'banking.gta.world',
            path: '/api/v2/payment',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.FLEECA_API_KEY}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          };
          const r = https.request(options, resp => {
            let data = '';
            resp.on('data', chunk => { data += chunk; });
            resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
          });
          r.on('error', reject);
          r.write(body);
          r.end();
        });

        if (fleecaRes.status !== 201) {
          log(`ERROR: Fleeca API returned ${fleecaRes.status}: ${fleecaRes.body}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payment creation failed' }));
          return;
        }

        const fleecaData = JSON.parse(fleecaRes.body);
        const { payment_id, payment_link } = fleecaData;
        pendingOrders.set(payment_id, { ...order, payment_id });
        log(`Payment created — ID: ${payment_id} — customer: ${order.customerName}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, payment_link }));

      } catch (err) {
        log(`ERROR handling /create-payment: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/fleeca-callback') {
      // Read raw body for HMAC verification
      const rawBody = await new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk.toString(); });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      });

      // Verify HMAC-SHA256 signature
      const crypto = require('crypto');
      const signature = req.headers['x-fleeca-signature'] || '';
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.FLEECA_API_KEY)
        .update(rawBody)
        .digest('hex');

      if (signature !== expected) {
        log(`WARN: Invalid Fleeca signature — possible spoofed callback`);
        res.writeHead(403);
        res.end('Invalid signature');
        return;
      }

      // Always respond 200 to Fleeca immediately
      res.writeHead(200);
      res.end('OK');

      try {
        const payload = JSON.parse(rawBody);
        const { status, payment_id, payer_routing } = payload;
        log(`Fleeca callback — status: ${status} — payment_id: ${payment_id}`);

        if (status === 'payment_successful') {
          const order = pendingOrders.get(payment_id);
          if (!order) { log(`WARN: No pending order found for payment_id ${payment_id}`); return; }

          if (!newOrdersChannelId) { log('WARN: newOrdersChannelId not resolved yet'); return; }
          const channel = await client.channels.fetch(newOrdersChannelId);

          const embed = new EmbedBuilder()
            .setTitle('💰 PAID Order — Blossom Breweries')
            .setColor(0x57F287)
            .addFields(
              ...buildEmbedFields(order),
              { name: '🆔 Payment ID',    value: String(payment_id),      inline: true },
              { name: '🏦 Payer Routing', value: String(payer_routing || 'N/A'), inline: true },
            )
            .setFooter({ text: 'Payment verified via Fleeca' })
            .setTimestamp();

          const message = await channel.send({ embeds: [embed] });
          await message.react('✅');
          await message.react('❌');

          orderStore.set(message.id, { type: 'order', data: order });
          pendingOrders.delete(payment_id);
          log(`PAID order posted — message: ${message.id} — payment_id: ${payment_id}`);

        } else if (status === 'payment_failed') {
          const order = pendingOrders.get(payment_id) || {};
          log(`Payment FAILED — payment_id: ${payment_id} — customer: ${order.customerName || 'unknown'}`);

          if (newOrdersChannelId) {
            const channel = await client.channels.fetch(newOrdersChannelId);
            const embed = new EmbedBuilder()
              .setTitle(`❌ Payment Failed — ${order.customerName || 'Unknown'}`)
              .setColor(0xED4245)
              .addFields(
                { name: '🆔 Payment ID', value: String(payment_id), inline: true },
                { name: '📛 Reason',     value: String(payload.reason || 'Not provided'), inline: true },
              )
              .setFooter({ text: 'Blossom Breweries · Fleeca Payment' })
              .setTimestamp();
            await channel.send({ embeds: [embed] });
          }
          pendingOrders.delete(payment_id);

        } else if (status === 'pending') {
          log(`Fleeca callback: payment ${payment_id} still pending — no action`);
        } else {
          log(`Fleeca callback: unknown status "${status}" for payment_id ${payment_id}`);
        }
      } catch (err) {
        log(`ERROR processing Fleeca callback: ${err.message}`);
      }
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
        if (!cadNewOrdersChannelId) {
          throw new Error('Bot not fully ready — CAD channel ID not yet resolved');
        }

        const brief   = await readBody(req);
        const channel = await client.channels.fetch(cadNewOrdersChannelId);
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

  const PORT = process.env.PORT || 8080;
  server.listen(PORT, '0.0.0.0', () => {
    log(`🌐 HTTP server listening on port ${PORT}`);
  });
}

// ── Start ─────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
