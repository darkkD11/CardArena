
# CardArena — Multiplayer Card Game

This project contains:
- A static HTML/JS client (`public/CardArena.html`)
- A minimal Node.js WebSocket server (`server.js`) for multiplayer

---

## Deploying on Railway (Static + WebSocket Server)

You can deploy both the static client and the WebSocket server together on [Railway](https://railway.app/):

1. [Sign up for Railway](https://railway.app/)
2. Create a **New Project** and select **Deploy from GitHub repo** (or upload your code)
3. Make sure your project includes:
	- `server.js` (WebSocket server)
	- `public/CardArena.html` (static client)
	- `package.json`
4. In your `server.js`, serve static files from the `public/` directory (see below)
5. Set the **Start Command** to:
	```
	node server.js
	```
6. Deploy. Railway will provide a public URL (e.g. `https://cardarena.up.railway.app`)
7. The static client will be at `/CardArena.html` and the WebSocket endpoint at `wss://cardarena.up.railway.app` (or `ws://` for local/dev)
8. Update the `WS_URL` in your client code if needed

---

## Local Development

You can run the server locally for development:
```sh
npm install
node server.js
```
Then open `public/CardArena.html` in your browser.

---

## Protocol

JSON messages with `type` and `payload` fields. The server supports: `list_rooms`, `create_room`, `join_room`, `join_by_code`, `leave_room`, `chat`, `player_ready`, `add_bot`, `kick_player`, `start_game`, `play_cards`, `pass`, `check`.

This server is intentionally minimal — useful for local testing and demonstration. For production use, add authentication, validation, persistence, and robust error handling.
