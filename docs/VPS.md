# Deploy Tern to your VPS

The VPS hosts the dashboard, update API, SQLite database, and artifact storage. Flutter and Android builds stay on your development machine.

## Connection details

Deployment needs the VPS's SSH host/IP, SSH username, SSH port, and the public hostname for Tern. Use an SSH key available to the deploying machine. Check the OS, Docker availability, disk space, and existing services before making changes.

For a domain, its A record must point at the VPS. If it has an AAAA record, that IPv6 address must also reach this server. Allow inbound TCP 80 and 443 in both the cloud security group and any operating-system firewall, and keep your existing SSH port reachable.

## Without a domain

Tern can use a public IPv4 address with a trusted Let's Encrypt certificate. In `.env.vps`, set `TERN_DOMAIN` to that address, set `TERN_CADDYFILE=./deploy/Caddyfile.ip`, and leave `ACME_EMAIL` empty if you do not want to supply one. The IP configuration explicitly selects the `shortlived` ACME profile, uses Caddy 2.11.7, and sets a default SNI name for clients that connect by IP behind the VPS's public-IP NAT.

Use the HTTPS IP origin for `TERN_PUBLIC_URL` and Flutter configuration. Certificates are short-lived and renewed automatically by Caddy; keep its data volume and inbound TCP 80/443 available. The plain-domain Caddyfile still expects `ACME_EMAIL` from the normal example configuration.

For Alibaba Cloud ECS, open the instance's Security Groups page and add inbound Allow rules for TCP 80 and TCP 443 with source `0.0.0.0/0`. The Ubuntu firewall and Docker port mappings do not override a cloud security group that blocks these ports.

## New HTTPS proxy

Copy the prepared server archive to the VPS over SCP, then extract it into a dedicated directory such as `/opt/tern`. It contains source and configuration templates, not the local database, generated builds, or credentials. Create the actual `.env.vps` on the server. Keep existing server files and data separate while setting up the first deployment.

Use this mode when ports 80 and 443 are available. The standalone `compose.vps.yaml` runs:

- Tern on the private Docker network at port 4310.
- Caddy on public ports 80 and 443, issuing and renewing the HTTPS certificate.
- A persistent `tern-data` volume for SQLite, artifacts, and the generated admin key.
- Persistent Caddy volumes for certificates and configuration.

The Node application port is not published to the host. The proxy accepts request bodies up to 90 MiB and preserves Tern's API and artifact cache headers.

On a Linux VPS with Docker Engine and the Compose plugin installed:

```sh
cd /opt/tern
cp .env.vps.example .env.vps
chmod 600 .env.vps
# Set TERN_DOMAIN to your hostname and ACME_EMAIL to your email in .env.vps.
docker compose --env-file .env.vps -p tern -f compose.vps.yaml config --quiet
docker compose --env-file .env.vps -p tern -f compose.vps.yaml up --build -d --wait
```

Use a hostname only in `TERN_DOMAIN`, such as `updates.example.com`. Tern receives the corresponding HTTPS origin automatically. The same command and project name should be used for future deploys to retain volume identity.

Check the actual public endpoint:

```sh
curl --fail https://updates.example.com/health
docker compose --env-file .env.vps -p tern -f compose.vps.yaml ps
docker compose --env-file .env.vps -p tern -f compose.vps.yaml logs --tail=50
```

Create a private administrator setup link from your own SSH terminal:

```sh
docker compose --env-file .env.vps -p tern -f compose.vps.yaml exec -T tern node server/admin.mjs setup --email you@example.com --origin https://updates.example.com
docker compose --env-file .env.vps -p tern -f compose.vps.yaml exec -T tern cat /data/admin-setup-url
```

Open that private URL in your browser and choose a password of 15–128 characters. The link expires in one hour and can be used once. Subsequent dashboard sign-ins use your email and password. Use Account settings to change the password, or issue a fresh setup command with `--reset` for recovery. No email delivery is configured. The CLI continues using `/data/admin-token`; transfer it privately to an ignored local token file. Keep both secrets outside Flutter apps and source archives.

## Moving an existing IP deployment to a domain

The live HatchMoon installation uses `https://tern.hatchmoon.cv`. To preserve updater access from existing releases built with `https://43.106.48.165`, `.env.vps` selects `TERN_CADDYFILE=./deploy/Caddyfile.domain-ip`, `TERN_DOMAIN=tern.hatchmoon.cv`, `TERN_LEGACY_IP=43.106.48.165`, and `ACME_EMAIL=p@hatchmoon.cv`. This configuration serves trusted HTTPS on both addresses, redirects the IP dashboard to the domain, and keeps the IP API and artifacts reachable. New download links use the domain.

Recreate Caddy when changing its environment or bind-mounted configuration. Retain its certificate volumes. Do not edit `tern.yaml` for an existing published baseline just to change hosts: it is bundled into the APK and covered by Tern's asset compatibility check. Keep the legacy origin operational for those releases. New applications and new store releases can use the domain.

## A VPS that already has an HTTPS proxy

Preserve the current Nginx, Caddy, Traefik, or hosting control panel. Start only Tern using the existing loopback Compose configuration:

```sh
cd /opt/tern
export TERN_PUBLIC_URL=https://updates.example.com
docker compose -p tern -f compose.yaml up --build -d --wait
```

Persist that environment setting in the server's deployment configuration for subsequent starts. Add the Tern hostname to the existing proxy, forwarding every path to `http://127.0.0.1:4310`. Allow at least 90 MiB request bodies, retain Range and HEAD requests, and preserve response cache headers.

If the existing proxy runs in another container, its loopback address is different from the host's. Connect it to the appropriate Docker network and use the Tern service address instead.

## Updates and backups

Deploy a new source version using the same directory, Compose project name, and volumes:

```sh
docker compose --env-file .env.vps -p tern -f compose.vps.yaml up --build -d --wait
```

Tern is a single process using local SQLite and artifact storage. Container replacement causes a short interruption. Keep one backend instance against the data volume.

Before a backup, pause Tern so that the database and referenced artifacts form a consistent snapshot:

```sh
mkdir -p backups
chmod 700 backups
docker compose --env-file .env.vps -p tern -f compose.vps.yaml stop tern
docker compose --env-file .env.vps -p tern -f compose.vps.yaml run --rm --no-deps --user 0 --entrypoint sh -v "$PWD/backups:/backup" tern -c 'umask 077; tar -czf "/backup/tern-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C /data .'
docker compose --env-file .env.vps -p tern -f compose.vps.yaml start tern
```

Resume the service even if the backup command fails, then investigate the failure. Store a protected copy off the VPS; the backup includes the admin key. Do not delete the data volumes during updates.

## Existing local apps

A fresh deployment starts with an empty database. To preserve current applications, copy the entire consistent local data directory into the backend's data volume while both backends are stopped. Preserve file ownership for UID 1000 used by the Node image. Preserve app IDs, release versions, original binaries, build manifests, patch numbers, revoked patches, and the admin key together. Do not overwrite an existing cloud database without preserving its contents.

The original demo APK contains a localhost update URL. Deploying the server does not change an installed APK. Build and install one new baseline APK with the public HTTPS URL in its `tern.yaml`, then use Tern to deliver subsequent Dart patches.

From the development machine, verify the remote API with the remote token:

```powershell
npm run cli -- doctor --server https://updates.example.com --token-file C:\secure\tern-vps-token
```

Then verify a staging patch download, Dart execution after restart, and revocation before using the stable channel.

References: [Docker Compose in production](https://docs.docker.com/compose/how-tos/production/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy request body limits](https://caddyserver.com/docs/caddyfile/directives/request_body), and [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).
