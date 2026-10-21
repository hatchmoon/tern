# Tern

A self-hosted Flutter update distribution MVP inspired by Shorebird. Includes an authenticated API, persistent release and patch storage, a CLI, and a responsive release console. Runs on Node.js 24+ with **no npm dependencies or build step**.

**Android code push now works end to end.** Tern installs a pinned open-source Shorebird Flutter runtime, builds your release and patch, distributes the changed Dart code, and supports rollback. A native Android emulator executed the downloaded patch and then returned to the original code without reinstalling the APK. See [Android quickstart](docs/ANDROID.md) and the [validation record](docs/VALIDATION.md). iOS runtime integration and physical-device validation remain outside the verified scope.

## Start

```powershell
cd D:\HatchMoon\tern
npm start
```

In a second terminal, create a private setup link for your administrator email:

```powershell
npm run admin:setup -- --email you@example.com --origin http://127.0.0.1:4310
Start-Process (Get-Content .tern-data/admin-setup-url)
```

Choose a password of 15–128 characters on the setup page. The link expires in one hour and works once. Then sign in at **http://127.0.0.1:4310** using your email and password. Passwords are stored as salted scrypt hashes; dashboard sessions use 12-hour HttpOnly cookies. Change your password through **Account settings**. For recovery, run the same setup command with `--reset` and open the new private link. Recovery takes effect when that link is used; no email sender is configured.

The CLI keeps using the generated API key in `.tern-data/admin-token`. It is never embedded in the frontend or printed in server logs. CLI commands automatically read the local key; for remote use, set `TERN_TOKEN` and `TERN_SERVER` in your shell. Keep the API key and setup links private.

Optional: run a local, explicitly simulated demo while the server is running:

```powershell
npm run demo
```

The demo creates `Harbor · simulated demo`, uploads JSON fixture binaries, generates a patch, deploys to three channels, and runs eight actual download/reconstruction/hash verification cycles. Its reported installs are simulated, not physical devices. It is idempotent and preserves existing apps. Artifacts live in `.tern-data/demo/`.

## What works

- Pinned updater-enabled Flutter toolchain setup, isolated from your existing SDK.
- Android APK and app bundle (AAB) builds, original package preservation, and resumable release uploads.
- Compatibility checks that reject native-code, asset, engine, and entry-point changes in a patch.
- Native emulator verification of downloaded Dart execution and rollback without APK reinstall.
- Admin authentication, session login/logout, origin checks, and login throttling.
- Application registration and confirmed deletion; immutable release binaries with SHA-256 addressing.
- Multiple platforms and architectures; every patch must cover its release's architectures.
- zstd-compressed bidiff v1 patches, generated against the original release.
- Prebuilt patch uploads with server-side reconstruction and target hash verification.
- Staging, beta, and stable deployments; deterministic staged rollouts from 0–100%.
- Permanent patch revocation and client rollback instructions.
- Public updater checks and events compatible with the published upstream protocol.
- Public patch downloads with byte ranges, resume support, ETags, and HEAD responses.
- Private original release downloads behind admin authentication.
- Deduplicated, architecture-scoped install telemetry and anonymized install cohorts.
- SQLite WAL persistence and content-addressed local artifact storage.
- Dashboard uploads, deployment controls, activity, app search, and filtering.
- CLI simulation that downloads, reconstructs, verifies, and reports an install.

## Android workflow

Link the CLI once from its installation folder, then use your Flutter project’s terminal:

```powershell
cd D:\HatchMoon\tern
npm link
tern setup

cd C:\path\to\flutter_app
tern init --name "My app" --configure-runtime --server https://43.106.48.165
tern release
```

Setup downloads the pinned open-source runtime into `.tern-tools/`. Your own Android project also needs Android's INTERNET permission. Initialization writes `.tern.json` and `tern.yaml`, and adds the YAML file to the Flutter assets. Use `--update-url https://updates.example.com` when initializing for remote devices. A physical device cannot reach the server through its own loopback address.

For Google Play, use `tern release --format aab`; patches then build as bundles automatically. See [Google Play](docs/ANDROID.md#google-play-app-bundles). The release command returns the archived original APK's path. Install that APK on the device. Edit Dart code, keep the exact version/build number in `pubspec.yaml`, then build and deploy a patch:

```powershell
tern patch --notes "Fix checkout"
tern deploy --patch PATCH_ID --channel staging --rollout 100
tern deploy --patch PATCH_ID --channel stable --rollout 10
tern rollback --patch PATCH_ID
```

The linked command resolves to this Tern installation and reads its admin key from `.tern-data/admin-token`, even when run inside another project. On another machine, link its Tern checkout and supply `--token-file` or `TERN_TOKEN`. No key is saved inside the Flutter project. If a terminal does not find `tern`, reopen it and ensure `npm prefix -g` is on PATH; `node D:/HatchMoon/tern/cli/tern.mjs` is also usable from any folder.

Existing initialized apps can skip `init`. The next build migrates `shorebird.yaml` to `tern.yaml`. The build temporarily generates the native engine’s legacy asset name and restores the project afterward, keeping existing release fingerprints compatible. Always use `tern release` and `tern patch` for updater-enabled builds.

In Applications, use the delete button and type the exact application name to permanently remove its releases, patches, deployments, metrics, and unused artifact files. Files shared by another application are retained. Deletion stops future updates; it does not roll back an installed patch.

The app must check the channel you deploy to. Automatic updates use the YAML channel; the optional upstream Dart bindings support explicit track selection. Updates run after an app restart. Rollbacks take effect after another check and restart.

By default Android releases include `aarch64`, `arm`, and `x86_64`. Use `--arch x86_64` for an x86 emulator, or a comma-separated subset. A patch inherits the release's architecture list. `--dart-define KEY=value` is repeatable; `--target` selects an entry point that must remain unchanged for that release.

The CLI retains the original APK under your app's `.tern-build/release/`. Use `release --project PATH --resume` to retry an upload from that saved binary. Compiled patch APKs are retained for inspection, but must not be installed as part of the OTA test.

To repeat the verified native example with a running local server and Android emulator:

```powershell
npm run demo:android
```

This installs and clears only `dev.tern.tern_example`, builds a changed Dart UI, deploys it to staging, confirms downloaded code execution, revokes it, and confirms fallback. It uses `adb reverse` for the local update URL. Set `TERN_ANDROID_DEVICE` if your emulator serial differs from `emulator-5554`. Evidence is saved in `test-results/android/`. This is distinct from `npm run demo`, which uses simulated binary fixtures.

Advanced raw artifact uploads and binary simulation remain available. Run `tern --help` for `--artifact arch=path`, `--engine`, `check`, and `simulate`. Runtime-managed releases also require a matching build compatibility manifest when uploading a patch; the project build command supplies it automatically.

## Tests

```powershell
npm test
```

Tests cover upstream patch fixtures, binary round trips, large native uploads, APK extraction and checksums, native/asset compatibility checks, auth/session security, version/architecture isolation, original-release baselines, staged cohorts, rollback, resumed downloads, telemetry retries, persistence, and a spawned CLI workflow against a real server. Test databases are created under the system temp directory.

Optional browser QA uses an externally available Playwright installation and an installed Edge browser:

```powershell
$env:TERN_PLAYWRIGHT_PATH = 'path/to/playwright/index.mjs'
node scripts/browser-check.mjs
```

The script runs against an isolated temporary server and database. Screenshots go to ignored `test-results/`. It never changes your running workspace data.

## Deployment

For your own VPS, use the [VPS deployment guide](docs/VPS.md) and [Docker Compose configuration](compose.vps.yaml). They run Tern with persistent storage and a Caddy HTTPS proxy. Flutter builds continue on your development machine.

For managed hosting, the [Render Blueprint](render.yaml) and [cloud deployment guide](docs/CLOUD.md) remain available as an alternative.

Configuration: `HOST`, `PORT`, `TERN_DATA_DIR`, `TERN_PUBLIC_URL`, and optional `TERN_ADMIN_TOKEN` (at least 32 characters). To load a `.env` file, use `node --env-file=.env server/main.mjs`. The default listener is loopback only.

```sh
docker compose up --build -d
docker compose exec tern node server/admin.mjs setup --email you@example.com --origin http://127.0.0.1:4310
docker compose exec tern cat /data/admin-setup-url
```

Open the printed private link in your own browser to choose your password. The container stores SQLite, account hashes, and binaries in the `tern-data` volume. Set `TERN_PUBLIC_URL` to a URL reachable from devices; the server uses it for download links. For a remote installation, terminate HTTPS at a reverse proxy and route the console, API, and `/artifacts/` through the same origin. An HTTPS public URL enables Secure session cookies. Configure your proxy for request bodies up to 90 MiB. Do not override cache headers on private `/api/` routes. Set `TERN_TRUST_PROXY=true` only when the backend is reachable exclusively through a trusted proxy that replaces forwarded client addresses; the VPS Compose configuration does this.

This is a single-admin, single-process MVP. API uploads and delta generation are buffered in memory with a 64 MiB combined binary limit and can temporarily block the event loop. Artifact storage is local disk; no CDN or job queue is provisioned. Multi-user roles, scoped CI keys, automatic crash-based rollbacks, audit retention, and managed backups are not implemented. Telemetry is unauthenticated by design, so it represents client-reported outcomes rather than trusted analytics. Add production infrastructure as load and access requirements become concrete.

Back up the whole data directory consistently (stop the process first, or use SQLite's online backup tools and retain all referenced artifact files). Do not copy only a live `.sqlite` file while ignoring its WAL. Token rotation changes the install anonymization salt; prior install records are retained but new checks use new hashes.

## Layout

Optional Flutter integration: [Tern Updater](packages/tern_updater/README.md) adds a reusable update-ready banner, unsaved-work guard, and Android cold restart. It requires a new baseline APK when first installed. See the package's Android example and `scripts/flutter-sdk-e2e.mjs` for validation.

```text
cli/tern.mjs          Project build/upload CLI and binary verification simulator
runtime/toolchain.json Pinned open-source Flutter runtime
lib/android.mjs       APK inspection, build pipeline, and compatibility guards
examples/hello_flutter Native code push sample
scripts/android-e2e.mjs Emulator execution and rollback verification
server/app.mjs        HTTP API, sessions, rollouts, updater protocol
server/store.mjs      SQLite schema and content-addressed artifacts
lib/patch.mjs         bidiff v1 encoder/reader with zstd compression
web/                 Buildless dashboard (no third-party requests)
packages/tern_updater/ Reusable Flutter update status, banner, and Android restart
scripts/demo.mjs      Real distribution demo using sample binaries
test/                Node integration tests
docs/                Runtime and API contracts
tools/native-verifier/ Optional independent upstream Rust patch decoder
```

## References

Tern is an independent implementation, with no affiliation to Shorebird. The wire format and API were checked against the [upstream updater](https://github.com/shorebirdtech/updater), its [network structs](https://github.com/shorebirdtech/updater/blob/main/library/src/network.rs), [bidiff v1](https://github.com/divvun/bidiff/tree/v1.0.0), and [Shorebird's system architecture](https://docs.shorebird.dev/code-push/system-architecture/). The test suite includes a small published upstream test vector; it is identified at its use site.
