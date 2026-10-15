# net-switch

A one-screen web app for turning a single device's internet on and off through the
Firewalla MSP API. Built for parents who don't want to dig through the Firewalla app.

- **Off** = a Firewalla *block internet* rule for the device is active.
- **On** = that rule is paused for 30 min / 1 h / 2 h / until bedtime.
  Firewalla caps a pause at 24 h, and when it expires the device is blocked again.
- UI auto-detects English or Brazilian Portuguese from the browser (English fallback),
  follows light/dark mode, and can be added to the home screen.
- The MSP token never leaves the server. Zero npm dependencies.

## Setup

1. **Pin the phone's MAC.** On the phone, turn off private / randomized Wi-Fi address
   for your home network, so the rule keeps matching it.
2. **Create the rule** in the Firewalla app (or MSP): *Block → Internet → device: the phone*.
3. **Find the rule ID** in MSP: Rules → click the rule → ID at the bottom of the dialog.
4. **Create a personal access token** in MSP (Account Settings → Create New Token).
5. Configure and run:

   ```sh
   cp .env.example .env    # fill in MSP_DOMAIN, MSP_TOKEN, RULE_ID, labels
   chmod 600 .env
   docker compose up -d --build
   ```

6. **Put it behind Caddy + OIDC.** See `Caddyfile.example` for a caddy-security policy
   that only allows the parents' accounts and passes the user's email through for logging.
   Publish the container only to the Caddy host (`BIND_ADDR`, plus a firewall rule).

## Config

| Var | Required | Meaning |
|---|---|---|
| `MSP_DOMAIN` | yes | e.g. `yourname.firewalla.net` |
| `MSP_TOKEN` | yes | MSP personal access token |
| `RULE_ID` | yes | the block rule to pause/resume |
| `DEVICE_LABEL` | | text above the status, e.g. "Phone" |
| `BEDTIME` | | `HH:MM` for the "until bedtime" button (default `21:00`) |
| `TZ` | | time zone for bedtime math (default `America/Sao_Paulo`) |
| `USER_HEADER` | | header carrying the signed-in user, for logs (default `X-Token-User-Email`) |
| `BIND_ADDR` | | host address the port is published on (default `127.0.0.1`) |

`docker logs net-switch` shows who turned it on/off and when.

## API (internal)

- `GET /api/status` → `{ internet: "on"|"off", until: ISO|null, device, bedtime }`
- `POST /api/internet` `{ state: "on", minutes: 60 }` · `{ state: "on", until: "bedtime" }` · `{ state: "off" }`
- `GET /healthz`

State-changing calls require a same-origin request, on top of the OIDC gate.

## Notes

- Only blocks on your Wi-Fi; mobile data isn't affected.
- If the pause duration is ignored by your MSP version (every pause becomes 60 min),
  the status line will show it. Pause duration was added after the original pause API.
