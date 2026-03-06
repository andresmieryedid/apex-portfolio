# APEX — AI Portfolio Monitor

A self-contained HTML app that uses Claude AI + EmailJS to monitor your stock portfolio and send rebalancing alerts every market open.

## Stack
- Vanilla HTML/CSS/JS (single file)
- [EmailJS](https://www.emailjs.com) — email delivery (free, no backend)
- [Anthropic Claude API](https://console.anthropic.com) — AI analysis

## Setup

### 1. EmailJS (for email alerts)
1. Create a free account at [emailjs.com](https://www.emailjs.com)
2. Add an Email Service (Gmail, Outlook, etc.) → copy **Service ID**
3. Create a Template with variables: `{{to_email}}`, `{{subject}}`, `{{message}}` → copy **Template ID**
4. Go to Account → API Keys → copy your **Public Key**
5. Paste all three into the app's setup card

### 2. Anthropic API Key
The app calls `https://api.anthropic.com/v1/messages` directly from the browser.

> ⚠️ **For production use**, move the API call to a backend to keep your key secret.
> For local/personal use, you can add your key directly in `index.html`:

In `index.html`, find the fetch call and add your key to the headers:
```js
headers: {
  'Content-Type': 'application/json',
  'x-api-key': 'YOUR_ANTHROPIC_KEY_HERE',        // ← add this
  'anthropic-version': '2023-06-01',               // ← add this
  'anthropic-dangerous-direct-browser-access': 'true' // ← add this
}
```

### 3. Run locally
Just open `index.html` in your browser — no build step needed.

Or serve with:
```bash
npx serve .
# or
python3 -m http.server 8080
```

## Project Structure
```
apex-portfolio/
├── index.html       # Full app (HTML + CSS + JS in one file)
└── README.md        # This file
```

## Extending with Cursor + Claude
Some ideas for extending the app:

- **Split into components** — separate `styles.css`, `app.js`, `api.js`
- **Add a backend** — Next.js / Express to hide the API key server-side
- **Real price data** — integrate Alpha Vantage or Yahoo Finance API for live prices
- **Price drift alerts** — trigger rebalance when allocation drifts >5% from target
- **Portfolio history** — chart performance over time with Chart.js
- **PWA** — add a service worker so it works offline and can send native push notifications

## Environment Variables (if you add a backend)
```
ANTHROPIC_API_KEY=sk-ant-...
EMAILJS_SERVICE_ID=service_...
EMAILJS_TEMPLATE_ID=template_...
EMAILJS_PUBLIC_KEY=...
```
