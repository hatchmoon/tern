# Android quickstart

This page describes the legacy Shorebird-engine workflow retained for existing releases. New applications should follow [Tern's independent runtime guide](INDEPENDENT_RUNTIME.md), which uses official Flutter and Tern's own updater.

Tern has been verified on a native Android x86_64 emulator: original APK → downloaded Dart patch → original code after rollback. The APK was installed once. Runtime patch numbers, executed Dart UI, screenshots, and the unchanged Android package installation timestamp were checked.

## Requirements

Node.js 24+, Git, an Android SDK, and a JDK compatible with your Android Gradle plugin. Setup downloads an isolated Flutter SDK and runtime binaries under `.tern-tools/`; your Android SDK and Gradle caches are reused.

## Local sample

Start the Tern server with `npm start`, then run these commands from another terminal in the Tern folder:

```powershell
npm run cli -- setup
npm run demo:android
```

Start an Android emulator first. Set `TERN_ANDROID_DEVICE` if its serial differs from `emulator-5554`. The initial build may take several minutes while Android dependencies are cached.

The verifier installs and clears only the dedicated `dev.tern.tern_example` app. It builds a changed Dart UI, uploads a patch, deploys it to staging, and confirms that the native updater executes it after restart. It then revokes the patch and confirms fallback after another check and restart. The compiled patch APK is never installed.

The sample permits local HTTP and uses `adb reverse` to reach the loopback server. Its `tern.yaml` and `.tern.json` are generated locally. Reports, app logs, and three screenshots are saved under `test-results/android/`. After completion the app runs the original blue UI and the test patch is revoked.

## Your app

```powershell
cd D:/HatchMoon/tern
npm link
tern setup --runtime legacy
cd C:/path/to/app
tern init --name "My app" --configure-runtime --runtime legacy --server https://43.106.48.165
tern release
```

Initialization writes the app ID and update URL and adds `tern.yaml` to the Flutter assets. For an already initialized app, skip init. The next build migrates legacy shorebird.yaml to tern.yaml and updates its pubspec entry. The CLI temporarily generates the old native engine asset during compilation, then restores your source configuration. Android needs `<uses-permission android:name="android.permission.INTERNET" />` in its main manifest.

Use a reachable HTTPS server for remote devices. For a local USB/emulator test, `adb -s DEVICE reverse tcp:4310 tcp:4310` forwards the device’s loopback port to your server. A device’s `127.0.0.1` does not otherwise refer to your computer.

The release command returns the archived original APK path. Install that APK once. The build uses your existing Android signing configuration. The sample uses a debug key for local testing. This workflow emits APKs and does not automate Play Store AAB submission.

Keep the same version and build number in `pubspec.yaml` when changing Dart code:

```powershell
tern patch --notes "Fix checkout"
tern deploy --patch PATCH_ID --channel stable --rollout 10
tern rollback --patch PATCH_ID
```

Automatic updates use the YAML channel. Manual checks using the optional `shorebird_code_push` Dart package must select the same `UpdateTrack` as the deployment. The sample explicitly checks staging with automatic updates disabled. Patches and rollbacks become active after an app restart.

Tern compares packaged native libraries, DEX, the Android manifest, resources, and Flutter assets to the release fingerprints. Native/asset changes, a different runtime, or a different Dart entry point require a new store release. The manifest is a guard against accidental incompatible changes, not a cryptographic attestation of an administrator’s binaries.

## Build options and retries

`--arch aarch64,arm,x86_64` selects release architectures. Patches inherit the release's list. Repeat `--dart-define KEY=value` for build-time values. `--target lib/main.dart` selects the entry point, which must stay unchanged within a release.

The original APK and compatibility manifest live under the app’s `.tern-build/release/VERSION/`. If upload fails after compilation, use `release --project PATH --resume` to retry that exact original. Back up the APK if moving to another machine.

The SDK pin is in `runtime/toolchain.json`. Project builds update `.dart_tool/package_config.json` and Android `local.properties` to use that SDK. Run your normal SDK's `pub get` when returning to an editor configured for that SDK. Flavors, split APKs, obfuscation, AABs, and build-name overrides are not yet exposed by the project build command.

## Verified scope

Verified: Android x86_64 native execution and rollback on the local emulator using the pinned runtime. Physical ARM devices and iOS have not been tested. ARM compilation is supported by the toolchain and architecture mapping, but is not claimed as device-validated here.

Tern uses the open-source Shorebird Flutter runtime/compiler and its public artifact downloads. This flow uses Tern’s own CLI orchestration, server, dashboard, and update storage; it requires no Shorebird account or hosted update/control API.

Patch signing remains external. The verified local flow checks reconstruction hashes with no configured signing key. Production hosting, signing, backups, retention, and load testing remain deployment tasks.
