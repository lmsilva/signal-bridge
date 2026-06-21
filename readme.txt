1. Session expired - re-authenticate
Use this when logs show auth/session errors or broadcasts stop because Amazon logged you out.

cd /share/Container/alexa-broadcast-bridge
PROXY_OWN_IP=192.168.1.10 ./reauth.sh
Then:

Open http://192.168.1.10:3456/ in a browser (PC or phone on the same LAN).
Log in to Amazon.
Wait until the page says Authentication complete.
Press Ctrl+C in the SSH terminal (the script restarts the listener for you).
If port 3456 is still busy:

docker compose stop alexa-broadcast-bridge
docker rm -f alexa-broadcast-auth
PROXY_PORT=3457 PROXY_OWN_IP=192.168.1.10 ./reauth.sh
# then open http://192.168.1.10:3457/
Verify it is working:

docker compose logs -f
2. Config changed - restart (no rebuild)
Use this when you edit data/config.json (UDP targets, display timeout, keep-alive settings, etc.). That file is mounted into the container; the app reads it at startup. You do not need to rebuild the image.

cd /share/Container/alexa-broadcast-bridge
./recreate.sh
Or manually:

cd /share/Container/alexa-broadcast-bridge
docker compose up -d --force-recreate
docker compose logs -f
A plain restart also works for config-only changes:

docker compose restart
./recreate.sh / --force-recreate is slightly safer if you also changed docker-compose.yml (env vars like TZ, AMAZON_PAGE).

When you do need a rebuild
Only if you changed code, Dockerfile, or package.json - not for data/config.json.

cd /share/Container/alexa-broadcast-bridge
./recreate.sh --build

On QNAP, --build often fails with a ZFS/Container Station error. If that
happens, keep using ./recreate.sh without --build and update the image some
other way (build on PC, push/load image, or copy updated src/ only if
you've set up a bind mount - which this project does not do by default).
