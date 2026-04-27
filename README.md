# VoidIdle Combat Relay

A tiny stateless WebSocket relay for the VoidIdle party combat tracker userscript. Players connect to the same room key and the relay forwards safe combat events between them. No data is stored, no login required.

---

## Local Development

```bash
npm install
npm start
# Listening on http://localhost:8080
```

Health check: `GET http://localhost:8080/health`

Test with [websocat](https://github.com/vi/websocat):

```bash
websocat "ws://localhost:8080/?room=testroom"
```

---

## Deploy to Render

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect your GitHub repository.
4. Set the following:

   | Field | Value |
   |---|---|
   | **Environment** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Health Check Path** | `/health` |

5. Click **Create Web Service**. Render will provide a URL like:

   ```
   https://your-app.onrender.com
   ```

---

## Userscript Connection

Hash the shared room key on the client before sending it (never send the raw key):

```js
async function hashRoomKey(raw) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const roomKey = await hashRoomKey(userEnteredKey);
const ws = new WebSocket(`wss://your-app.onrender.com/?room=${roomKey}`);
```

### relayReady message

On connect the server sends:

```json
{
  "type": "relayReady",
  "room": "<hashedRoomKey>",
  "clientId": "<uuid>",
  "connected": 3,
  "ts": 1714200000000
}
```

### Sending an event

```js
ws.send(JSON.stringify({
  type: 'abilityDamage',
  abilityName: 'Fireball',
  damage: 412,
  targetId: 'mob_42'
}));
```

The relay adds `senderClientId` and `relayTs`, then broadcasts to everyone in the room (including the sender).

### Allowed event types

| Type | Purpose |
|---|---|
| `hello` | Announce presence / share player name |
| `abilityDamage` | Damage dealt by an ability |
| `abilityHealing` | Healing done by an ability |
| `abilityCast` | Ability cast notification |
| `summaryPing` | Periodic combat summary |

Any other type is silently dropped by the relay.

---

## Limits

| Constraint | Value |
|---|---|
| Max message size | 16 KB |
| Rate limit | 30 messages / 10 seconds per socket |
| Room key length | 4–128 characters, `[a-zA-Z0-9_-]` |

Exceeding these closes the socket with an appropriate WebSocket close code.

---

## Privacy

- Only send local `abilitiesFired` combat events.
- Never send cookies, authentication tokens, raw socket dumps, or any PII.
- The relay does not log message contents and does not persist any data.
- Rooms are destroyed as soon as the last client disconnects.
