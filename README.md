# AIRA Chatbot — Easy Setup Guide

This app adds a chat bubble on your Shopify store. Shoppers can search products, add items to cart, and ask about shipping or store policies.

Follow the steps below in order.

---

## Before you start

You need:

- A Shopify Partner / Dev Dashboard account
- Shopify CLI installed
- Node.js installed
- This project on your computer

In the project folder, install packages once:

```bash
npm install
```

Put your public app URL in `.env` as `APP_URL`.

- If you use **ngrok**, use the ngrok `https://...` URL.
- If you use your **own server**, use that server URL.

Example:

```bash
APP_URL=https://your-ngrok-or-server-url
```

---

## Step 1 — Log in to Shopify

First log out, so you start clean:

```bash
shopify auth logout
```

Then log in:

```bash
shopify auth login
```

This command shows a **URL**.

1. Copy that URL.
2. Open it in the same browser where you are already logged in to Shopify (Dev Dashboard).
3. Click **Allow** / approve the login.

When that succeeds, the terminal login is done.

---

## Step 2 — Link this project to your custom app

```bash
shopify app config link
```

This connects the code to your Shopify custom app.

It will create (or update) a `.toml` file, for example:

- `shopify.app.toml`
- or `shopify.app.something.toml`

---

## Step 3 — Update the app URL and redirect URLs

Open the `.toml` file that was created.

Set the **app URL** to the same public URL your chatbot will use.

**If you use ngrok**

1. Start ngrok in another terminal:

   ```bash
   ngrok http 3000
   ```

2. Copy the `https://....ngrok-free.dev` URL.
3. Put that URL in the `.toml` file.

**If you use your own server**

Use your server URL instead of ngrok.

In the `.toml` file, update:

```toml
application_url = "https://YOUR-PUBLIC-URL"

[auth]
redirect_urls = [
  "https://YOUR-PUBLIC-URL/auth/callback",
  "https://YOUR-PUBLIC-URL/api/auth"
]
```

Also put the same URL in `.env`:

```bash
APP_URL=https://YOUR-PUBLIC-URL
SHOPIFY_APP_URL=https://YOUR-PUBLIC-URL
REDIRECT_URL=https://YOUR-PUBLIC-URL/auth/callback
```

Use the same URL everywhere. Do not mix localhost, ngrok, and server URLs.

---

## Step 4 — Deploy the custom app

This pushes the app (including the chat bubble) to Shopify:

```bash
shopify app deploy
```

If Shopify asks which config to use, pick the `.toml` file you just updated.

After deploy, install / open the app on the store where you want the chatbot.

---

## Step 5 — Start the chatbot server

Keep ngrok running if you use ngrok.

Then start the chatbot:

```bash
npm run dev:server
```

This runs the chatbot backend on port `3000`.

The chat bubble on the store talks to this server using your public URL.

---

## Step 6 — Turn on the chat bubble in the theme

1. Open the Shopify admin for the store where you installed this custom app.
2. Go to **Online Store**.
3. Open your live theme and click **Customize** (edit theme).
4. Open **App embeds**.
5. Find **AIRA** and **enable** it.
6. Save the theme.

The chat bubble should now show on the store.

If you do not see it:

- Hard refresh the store page.
- Make sure you enabled AIRA on the **same theme** the store is using.
- Make sure `npm run dev:server` is still running.
- If you use ngrok, make sure ngrok is still running and the URL did not change.

---

## Quick command list

```bash
shopify auth logout
shopify auth login
shopify app config link
# update URL + redirect URLs in the .toml file (and in .env)
shopify app deploy
npm run dev:server
```

If you use ngrok:

```bash
ngrok http 3000
```

---

## After that, try the chat

Open the store, click the chat bubble, and try:

- `Hi`
- `Show me popular products`
- `What's in my cart?`
- `What is your shipping policy?`

---

## If the chat bubble does not load new changes

Theme files (`chat.js` / `chat.css`) only update after you deploy the app again:

```bash
shopify app deploy
```

Then hard refresh the store page.
