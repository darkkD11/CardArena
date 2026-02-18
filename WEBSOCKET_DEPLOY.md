# Deploying CardArena on Railway (Static + WebSocket)

You can deploy both the static client and the WebSocket server together on [Railway](https://railway.app/):

## Steps

1. [Sign up for Railway](https://railway.app/)
2. Click **New Project** → **Deploy from GitHub repo** (or upload your code)
3. Make sure your project includes:
   - `server.js` (WebSocket server, now also serves static files)
   - `public/CardArena.html` (static client)
   - `package.json`
4. The `server.js` is already set up to serve static files from the `public/` directory and handle WebSocket connections.
5. Set the **Start Command** to:
   ```
   node server.js
   ```
6. Deploy. Railway will provide a public URL (e.g. `https://cardarena.up.railway.app`)
7. The static client will be at `/CardArena.html` and the WebSocket endpoint at `wss://cardarena.up.railway.app` (or `ws://` for local/dev)
8. Update the `WS_URL` in your client code if needed (see below)

---

## Updating the Client

- In `public/CardArena.html`, set the `WS_URL` variable to your Railway production WebSocket server URL (e.g. `wss://cardarena.up.railway.app`).
- You can use browser devtools or re-deploy with the correct value.

---

## Summary
- **Static client**: Served from Railway `/CardArena.html`
- **WebSocket server**: Same Railway project, same domain
- **Update `WS_URL`**: Point client to your Railway public WebSocket URL

Enjoy your multiplayer CardArena!
