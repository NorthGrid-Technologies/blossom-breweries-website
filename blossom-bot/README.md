# Blossom Bot

Discord order management bot for Blossom Breweries.

## Setup

1. Fill in your credentials in `.env`
2. Install dependencies:
   ```
   npm install
   ```
3. Run the bot:
   ```
   npm start
   ```
   or for development with auto-restart:
   ```
   npm run dev
   ```

## How it works

- `order.html` sends order data to `http://localhost:3000/new-order`
- Bot posts the order as an embed in **#new-orders**
- Staff react with ✅ to complete or ❌ to cancel
- Bot moves the embed to the correct channel automatically

## Reaction workflow

| Reaction | Action |
|----------|--------|
| ✅ | Moves embed to **#completed-orders**, logs who approved |
| ❌ | Moves embed to **#cancelled-orders**, logs who cancelled |

The original message in **#new-orders** is deleted after either reaction.

## Bot restart recovery

On startup the bot fetches the last 50 messages from **#new-orders** and
re-registers any messages it posted itself, so pending orders survive a restart.

## Hosting on VPS (Ubuntu)

Install PM2 to keep the bot running permanently:

```
npm install -g pm2
pm2 start index.js --name blossom-bot
pm2 save
pm2 startup
```

To view live logs:
```
pm2 logs blossom-bot
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `NEW_ORDERS_WEBHOOK` | Webhook URL for the #new-orders channel |
| `COMPLETED_ORDERS_WEBHOOK` | Webhook URL for the #completed-orders channel |
| `CANCELLED_ORDERS_WEBHOOK` | Webhook URL for the #cancelled-orders channel |
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
