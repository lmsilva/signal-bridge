# Alexa Broadcast Bridge (POC)

Foreground service that connects to your Alexa account, listens for broadcast/announcement activity, and records matches to `broadcast.txt`.

## Prerequisites

- Node.js 18+
- An Amazon account with Alexa devices in your household

## Setup

```bash
npm install
```

Copy `config.example.json` to `config.json` and adjust if needed:

- `amazonPage`: `amazon.com`, `amazon.co.uk`, `amazon.de`, etc.
- `acceptLanguage`: e.g. `en-US`, `en-GB`, `de-DE`

## Authenticate once

```bash
npm run auth
```

1. A local proxy starts (default port `3456`).
2. Open the URL printed in the terminal.
3. Log in to Amazon and complete 2FA if prompted.
4. When successful, credentials are saved to `data/alexa-session.json`.

## Run the listener

```bash
npm start
```

The process stays in the foreground and prints activity to the terminal. Matching broadcasts are appended to `broadcast.txt`.

Enable verbose Amazon/push logging:

```bash
DEBUG=1 npm start
```

## Test it

Try on an Echo device:

- "Alexa, announce dinner is ready"
- "Alexa, announce" → wait for prompt → "the movie is starting"

You can also send an announcement from the Alexa mobile app.

## Output format

`broadcast.txt` uses tab-separated fields:

```
timestamp    message    device    source    trigger
```

## Notes

- This uses the unofficial `alexa-remote2` library (same approach as Home Assistant / Node-RED integrations).
- Amazon does not expose a supported API for passive broadcast listening, so detection is based on voice history and activity events.
- Announcements sent only from the Alexa app may not always appear in voice history.
- If auth breaks after an Amazon change, run `npm run auth` again.

## Next step

When you have a Vestaboard, add a second sink that POSTs to the Vestaboard Cloud API instead of only writing `broadcast.txt`.
