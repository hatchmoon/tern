# Public cloud deployment

Tern's server is a small Node service. Flutter and Android builds stay on your development machine; the cloud service hosts the dashboard, API, SQLite database, and binary artifacts.

For an existing VPS, follow the [VPS deployment guide](VPS.md). The instructions below cover managed hosting on Render.

## Render configuration

The root `render.yaml` defines one paid Node 24 web service in Singapore with a 1 GB persistent disk at `/var/data`. The service writes its database and artifact directory under `/var/data/tern`. Deploys are manual. Review the selected compute and disk prices in Render before creating the service.

The selected compute plan has 512 MB RAM. It suits the small native demo; increase memory if large uploads or delta generation exhaust it. The server accepts up to 64 MiB of combined binary artifacts and buffers uploads and patch generation in memory.

Render provides HTTPS and the `RENDER_EXTERNAL_URL` environment variable. Tern uses that URL for public downloads, browser origin checks, and Secure session cookies. To use a custom domain, add it in Render and set `TERN_PUBLIC_URL` to its HTTPS origin.

## Deploy

1. Put this source in a private GitHub repository. Keep `.tern-data`, `.tern-tools`, `.tern.json`, generated builds, and credentials excluded by the existing `.gitignore`.
2. Connect the Render account and that GitHub repository. Create a Blueprint from the repository's `render.yaml`. Confirm the Singapore region, paid compute, persistent disk, and account billing.
3. Wait for the service health check at `/health` to pass. Open the actual HTTPS URL assigned by Render.
4. From the service's private shell, run `node server/admin.mjs setup --email you@example.com --origin https://YOUR-SERVICE.onrender.com`, then read the `admin-setup-url` file in `TERN_DATA_DIR`. Open that private, single-use URL to choose your dashboard password. It expires in one hour. Future sign-ins use email and password; add `--reset` to issue a recovery link. Retrieve the generated `TERN_ADMIN_TOKEN` from the service's environment settings for CLI use, keeping it in a password manager or ignored token file. Do not put it in Flutter configuration or commit it.
5. Check API access from your development machine using the cloud URL and the cloud token file:

```powershell
npm run cli -- doctor --server https://YOUR-SERVICE.onrender.com --token-file C:\secure\tern-cloud-token
```

The generated cloud token differs from the local server token. The Blueprint starts with an empty database. Existing local apps and releases are not copied by deploying source.

The deployment requires a connected Render account and access to the source repository. Preparing this configuration does not create a cloud service.

## Point a Flutter app at the public server

For a new project registration, pass the public server URL when initializing:

```powershell
npm run cli -- init --project C:\path\to\flutter_app --name "My app" --configure-runtime --server https://YOUR-SERVICE.onrender.com --token-file C:\secure\tern-cloud-token
```

Then build and upload the original release using the same server and token. Keep the cloud URL in the project's `.tern.json` and `tern.yaml`; keep the token outside those files. The YAML asset contains public configuration only.

For an existing app, migrate its original release and metadata before publishing patches against it. Changing `.tern.json` alone only changes CLI traffic. A previously installed APK still contains its original `base_url`. The local demo APK points to localhost, so it needs a new baseline APK built with the public URL and installed once before it can receive cloud updates.

A public HTTPS update URL does not require `adb reverse`.

## Migrate existing local data

Preserve application IDs, release versions, original binaries, build manifests, patch numbers, and revocations together.

1. Stop management writes and the local Tern process.
2. Copy the **entire** `.tern-data` directory to a secure temporary backup, including `tern.sqlite`, any WAL/SHM files, `artifacts/`, and `admin-token`. Do not publish this backup in the source repository.
3. Before importing, stop the target process and ensure its disk is empty, or back up any cloud data first. Transfer the backup into the persistent `/var/data/tern` directory using the provider's SSH/file transfer facilities.
4. For a fresh migrated service, set its secret `TERN_ADMIN_TOKEN` to the existing local admin token before starting it. The token also salts device IDs; retaining it preserves existing device identity hashes. Keep the database and artifact files writable by the runtime user.
5. Start the service and verify authentication, app/release counts, public download URLs, and artifact hashes.

Do not copy only a live SQLite main file while ignoring its WAL. Keep a consistent database backup and all referenced artifacts. If the service already contains data, migration needs an explicit merge strategy; overwriting it loses that data.

## Operation

- Run one instance against this disk. SQLite and local artifacts are not configured for horizontal scaling.
- A service with a persistent disk has a short interruption during Render redeploys. Devices retry later; schedule deploys appropriately.
- Keep independent consistent backups of the database and artifacts.
- Build a release, publish a staging patch, confirm downloaded Dart execution on a device, then test revocation before widening rollout.
- CLI signing and physical ARM/iOS verification remain separate from hosting.

References: [Render Blueprints](https://render.com/docs/blueprint-spec), [persistent disks](https://render.com/docs/disks), [default environment variables](https://render.com/docs/environment-variables), and [Node versions](https://render.com/docs/node-version).
