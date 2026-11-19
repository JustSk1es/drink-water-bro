# Drink Water Bro — Push Notification Setup (Free)

This makes reminders work **even when the app is closed**, as real iPhone/Android
notifications. Everything uses free tiers: GitHub Pages (already set up) +
Cloudflare Workers.

## What you'll do (about 20 minutes, one time)

### 1. Install the Cloudflare tooling

```bash
npm install -g wrangler     # needs Node.js; or: brew install wrangler
wrangler login              # opens browser, create/login free Cloudflare account
```

### 2. Create the storage and deploy

```bash
cd push-worker
wrangler kv:namespace create SUBSCRIPTIONS
```

Copy the `id = "..."` value it prints into `wrangler.toml`
(replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`), then:

```bash
wrangler secret put VAPID_PRIVATE
# paste when prompted:
FfZsJ0A2O5nOeNHkA8k9eX2Yp4X0W9vBTjWSv1wNPyw

wrangler deploy
```

Note the URL it prints, e.g. `https://drink-water-bro-push.<your-subdomain>.workers.dev`.

Also: in `worker.js`, change `VAPID_SUBJECT` to your real email
(`mailto:you@example.com`) — it's required by the push spec.

### 3. Point the app at your server

In `index.html` (top of the file), set:

```js
const PUSH_SERVER_URL = "https://drink-water-bro-push.<your-subdomain>.workers.dev";
```

Then push the update:

```bash
git add index.html push-worker sw.js PUSH-SETUP.md
git commit -m "Add push notification server"
git push
```

### 4. Enable reminders on your iPhone

1. Open the app from your **home screen** (installed PWA, iOS 16.4+).
2. Tap **🔔 Enable reminders** once.
3. If iOS asks for notification permission, tap **Allow**.
4. Close the app. You'll now get lock-screen notifications at each reminder time,
   based on the schedule for the current day of the week.

## How it works

- The app subscribes to push (Web Push protocol) and uploads the subscription
  plus your per-day wake/sleep schedule to the Worker.
- A free Cloudflare **cron trigger** runs every 15 minutes, works out which
  reminder times fall in that window per subscription (all times in **UTC** —
  see note), and sends encrypted pushes directly to Apple/Google's push services.
- Expired subscriptions are auto-deleted. Reminders are deduplicated so you
  get one push per reminder window.

## Notes & limits

- **Time zone:** the cron currently computes reminder times in UTC. If you're in
  Malaysia (MYT = UTC+8), tell me and I'll add a fixed +8 offset (or read the
  offset the browser reports and store it with the subscription — better).
- Free KV has a 1,000-write/day limit — vastly more than personal use needs.
- If you clear iPhone Safari data or reinstall the app, tap the bell once to
  re-subscribe.
- The in-app (while-open) reminders keep working exactly as before; push adds
  the closed-app layer on top.
