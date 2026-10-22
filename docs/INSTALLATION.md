# Install Tern on Windows

## npm installation

Install a patched Node.js 24.22.1+ or 26.12.1+ release. Sign in to [the Tern dashboard](https://tern.hatchmoon.cv), open **Getting started**, and select **Download npm package**. In the folder containing the downloaded tarball, run:

```powershell
npm install -g ./tern-cli-0.2.0.tgz
tern login --server https://tern.hatchmoon.cv
```

Reopen your terminal if `tern` is not found. This installs only the CLI; Git, Java 17+, and Android SDK/NDK tools are needed for Flutter builds. The package keeps credentials, signing keys, and downloaded SDKs under `%LOCALAPPDATA%\Tern`, so `npm install -g` can replace the CLI without removing them. To update, download the latest tarball from the dashboard and install it with the same command. `tern upgrade --check` reports the available version; it does not invoke the Windows installer for npm installations. Use `npm uninstall -g @hatchmoon/tern` to remove the CLI.

The Tern GitHub repository and release assets are private. The downloaded tarball works without GitHub access or an npm registry account. Direct `npm install -g @hatchmoon/tern` requires a separately published registry package and is not available yet.

## Windows installer (alternative)

Tern CLI 0.2.0 has a Windows x64 installer with a bundled, pinned Node.js 24.22.1 runtime. You do not need Node.js, npm, GitHub access, or a source checkout to install and run the CLI. Git, Java 17+, and Android SDK/NDK tools are still needed for Flutter builds.

1. Sign in to [the Tern dashboard](https://tern.hatchmoon.cv), open **Getting started**, and click **Download Tern for Windows**.
2. Run `TernSetup-0.2.0-windows-x64.exe`. It installs for your Windows user without administrator access. Reopen your terminal afterward.
3. Sign in:

```powershell
tern login --server https://tern.hatchmoon.cv
```

Compare the verification code in your terminal with the request you approve in the browser. Sign in with your existing dashboard email/password when requested. No password enters the CLI. Use `--no-browser` to open the printed link yourself.

The installer is not Authenticode publisher-signed. Windows may show an unknown-publisher or SmartScreen warning. Download it from the authenticated dashboard. Installer manifests are signed with Tern's release key; `tern upgrade` verifies that signature and the complete installer checksum before opening Setup. This release signature does not substitute for Windows publisher signing.

## Existing applications

Open the existing Flutter project, with its original source and Android signing configuration:

```powershell
cd D:\Projects\my_flutter_app
tern connect
tern setup
tern doctor
```

`connect` uses the application ID in `tern.yaml` (or the legacy `shorebird.yaml`) and recreates the ignored `.tern.json` connection. It never creates an application or replaces an existing app ID. If no configuration exists, choose an application interactively or use `--app APP_ID`; recovery requires a matching release version in `pubspec.yaml` so its runtime can be restored safely. `tern apps` lists IDs.

Setup detects the project’s original runtime automatically. Apps already installed on devices continue using the runtime in their original release; do not run `tern integrate` merely to move to another machine. Native updates need the original patch-signing key, described below. Keep the release version/build number unchanged when building patches.

```powershell
tern patch --notes "Fix checkout"
tern deploy --patch PATCH_ID --channel staging --rollout 100
```

Restore local Flutter package dependencies if your project's `pubspec.yaml` points to an absolute path from another machine. Prefer the versioned Git dependency documented in the Flutter package README, or point the dependency at the package included with the installed CLI. Preserve the original package/runtime version for existing releases.

For a new application, use `tern init --name "My app" --configure-runtime`, add the update scope/banner, and build a new baseline with `tern release`. See [the independent runtime guide](INDEPENDENT_RUNTIME.md).

## Patch-signing keys

On the original build machine, from its project directory:

```powershell
tern keys export --output D:\Backups\my-app.encrypted.pem
```

Choose a backup passphrase of at least 15 characters. Transfer the encrypted file privately and provide the passphrase separately. On the new machine, after connecting the project:

```powershell
tern keys import --input D:\Backups\my-app.encrypted.pem
```

The import verifies the key against an existing matching native release on the server and local runtime configuration, and refuses to overwrite a different key. Export does not upload keys. For automation, `--passphrase-file` reads a private local file instead of prompting; never put that file or private keys in Git. Android APK signing keys are separate and must also be restored when needed.

## Settings, setup and updates

Installed versions live under `%LOCALAPPDATA%\Programs\Tern`. Settings, credentials, signing keys and SDK caches live under `%LOCALAPPDATA%\Tern`. Windows credentials use DPAPI encryption bound to the current Windows user and machine. Each machine credential expires after 90 days, can be revoked through **Getting started → Manage connected machines**, and is invalidated by an administrator password change.

`tern doctor` checks the connection, authentication, Node security baseline, Git, Java, Android platform/build tools/licenses/NDK, and the project's pinned Flutter SDK and patch-signing key. It prints fixes for failures. `tern doctor --server-only` checks API access; `tern doctor --build` also returns a failing exit status for incomplete build prerequisites. Doctor does not build an APK or prove compatibility with an existing release; the release/patch build still checks native fingerprints.

Setup serializes concurrent installations and retains reusable Git/Flutter caches. Retry `tern setup` after an interrupted download. Managed installations cache SDKs by their pinned framework revision. CLI upgrades do not change an existing release's runtime or automatically migrate projects.

```powershell
tern upgrade --check
tern upgrade
tern upgrade --rollback
tern logout
```

An upgrade opens the verified installer for confirmation. Setup verifies its embedded payload and CLI startup before switching the active version. The prior version is retained for rollback. Uninstall through Windows **Installed apps → Tern CLI**; user settings, keys and SDK caches are retained. Close running Tern commands before uninstalling.

For CI or troubleshooting, `TERN_HOME` selects a separate settings/keys directory and `TERN_CACHE_DIR` selects the SDK cache. `TERN_TOKEN` and explicit `--token-file` authentication remain supported. Environment variables override saved server profiles; project configuration takes precedence over the saved default server. Clear a stale `TERN_SERVER` variable if you are switching servers.

## Source installation and packaging

The existing private-repository installation still works:

```powershell
git clone https://github.com/hatchmoon/tern.git D:\HatchMoon\tern
cd D:\HatchMoon\tern
npm.cmd link
tern login --server https://tern.hatchmoon.cv
```

Existing local admin tokens and legacy SDK caches continue to work. New signing keys go in the user data directory; original checkout signing keys remain readable in `.tern-data/signing`.

Maintainers build on Windows with `npm run package:cli`. The packager verifies the official Node archive against `runtime/installer-toolchain.json`, compiles the launcher/Setup with the Windows .NET Framework compiler, and packages only tracked CLI/library/runtime/package files. Stage new files first. Keep `.tern-data/cli-release-signing.pem` backed up privately; its public counterpart is committed. Releases contain the EXE, detached signed JSON manifest and SHA-256 file. The server serves these from its persistent `cli-distributions` directory after authentication. The packager does not publish, upload keys, or change Windows PATH.

The installer targets Windows x64. macOS/Linux installers, automatic Android tool installation, and Windows publisher signing are separate work.
