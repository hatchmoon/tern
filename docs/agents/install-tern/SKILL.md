---
name: install-tern
description: Install and integrate Tern (self-hosted Flutter code push for Android) into a Flutter project - CLI setup, project connection, the tern_updater package, update banner, first release and first patch. Use when asked to add Tern, set up Tern updates or code push, or connect a Flutter app to a Tern server.
---

# Install Tern in a Flutter project

Tern ships Dart-only updates (patches) to Android apps built with the official Flutter SDK. It has three parts:

- **Tern CLI** (`tern`): builds releases and patches with Tern's pinned Flutter and uploads them.
- **Tern server/dashboard** (default `https://tern.hatchmoon.cv`): stores releases and patches and serves updates.
- **`tern_updater` Flutter package**: the Android runtime that loads patches, plus `TernUpdateScope` and `TernUpdateBanner`.

Android only (API 26+). iOS is not supported. Work from the Flutter project's root folder (the one with `pubspec.yaml`).

## Ground rules

- **Only the user can sign in.** `tern login` needs browser approval and a dashboard password. Run it or hand it over, but never ask for, store or type their password or tokens.
- **Builds go through the CLI only.** Releases and patches must be built with `tern release` and `tern patch`, never `flutter build apk` or `flutter run`, because they must use Tern's pinned Flutter (3.44.8).
- **The device must run the original APK from `tern release`.** Installing over it with `flutter run`, an IDE Run button or a self-built APK replaces the baseline, and patches stop working.
- **Native changes need a new release.** Adding `tern_updater`, plugins, Android code, assets or Gradle settings requires a new version/build and a new `tern release`. Patches may change Dart code only.
- **Keep the version fixed while patching.** Patches are matched to the exact `version:` in `pubspec.yaml` (for example `1.0.0+1`). Never change it for a patch.
- **Don't commit machine files.** Never commit `.tern.json` (per-machine connection) or `.tern-build/` (build output). Signing keys live outside the project; never copy them into it.
- **Commands that change the server need the user's go-ahead.** That means `tern init` (creates an app), `tern release`, `tern patch`, `tern deploy` and `tern rollback`. Confirm with the user before each one.

## 1. Prerequisites

Check what exists before installing anything:

```bash
tern --help          # CLI installed?
node --version       # npm install needs Node 24.22.1+ (or 26.12.1+)
java -version        # Java 17+
git --version
```

Also required: Android SDK with platform tools, build tools, accepted licenses and the NDK.

If `tern` is missing, ask the user to install it. The CLI is not on the public npm registry. They download `tern-cli-<version>.tgz` from the dashboard (**Getting started → Download npm package**) and run:

```bash
npm install -g ./tern-cli-0.2.0.tgz
```

On Windows there is also an installer (`TernSetup-<version>-windows-x64.exe`) with Node bundled. Reopen the terminal afterwards.

## 2. Sign in and install the toolchain

```bash
tern login --server https://tern.hatchmoon.cv   # user approves in the browser; --no-browser prints a link
tern setup                                        # downloads the pinned official Flutter into Tern's cache
tern doctor                                       # fix everything it reports before continuing
```

Use the user's own server URL if they self-host.

## 3. Connect the project

Pick the case that applies. Check first: look for `tern.yaml`, `.tern.json` and `cv.hatchmoon.tern.updater` in `android/app/src/main/AndroidManifest.xml`.

**A. New app (not on the Tern server yet).** Confirm the app name with the user, then run:

```bash
tern init --name "My app" --configure-runtime --server https://tern.hatchmoon.cv
```

This creates the app on the server and then does the following:
- writes `.tern.json`, `tern.yaml` (`runtime: tern-native-v1`) and a `tern-runtime.json` placeholder
- adds the `tern_updater` dependency, plus `tern-runtime.json` and `tern.yaml` as assets in `pubspec.yaml`
- sets `android:name="cv.hatchmoon.tern.updater.TernApplication"` and the Internet permission in the manifest
- raises `minSdk` to 26 (Kotlin Gradle scripts only)

Useful options:
- `--channel staging` uses the staging channel.
- `--manual-updates` writes `auto_update: false`, so the app downloads only when your code asks.
- `--update-url <url>` sets the address devices use, if it differs from the server URL.

**B. App already exists on the server, project already set up** (`tern.yaml` is present, for example on a new machine):

```bash
tern connect          # or: tern connect --app APP_ID   (tern apps lists IDs)
```

Patching existing releases on a new machine also needs the app's original patch-signing key. The user exports it on the old machine (`tern keys export --output app.pem`) and imports it here (`tern keys import --input app.pem`).

**C. App exists but doesn't use Tern's native runtime yet** (`tern.yaml` has no `runtime: tern-native-v1`):

```bash
tern integrate
```

Then bump the version/build in `pubspec.yaml`. The integration only works from a new baseline release.

**Custom `Application` class.** If the manifest names the app's own class (Firebase, DI frameworks and so on), `init`/`integrate` refuse to overwrite it. In that case:
- call `cv.hatchmoon.tern.updater.TernApplication.install(this)` first thing in that class's `onCreate()`, before anything starts Flutter
- add the dependency and the two assets by hand, as listed below

### Check the `tern_updater` dependency

Open `pubspec.yaml`. The dependency must be pinned to a published tag:

```yaml
dependencies:
  tern_updater:
    git:
      url: https://github.com/hatchmoon/tern.git
      ref: tern-updater-v0.3.0
      path: packages/tern_updater
```

- If `init`/`integrate` wrote a `path:` pointing into the CLI's install folder (for example `.../npm/node_modules/@hatchmoon/tern/packages/tern_updater`), replace it with the git dependency above. A path into one machine's install breaks on every other machine.
- That repository is private, so the build machine needs GitHub read access to it. Never put a token in `pubspec.yaml`.
- Ask the user which tag to use if a newer one exists.
- Keep the tag fixed for a release and all of its patches. Move to a newer tag only together with a new baseline release.

Then run `flutter pub get`.

## 4. Add the update UI

Wrap the app root once, above `MaterialApp`, in `lib/main.dart`:

```dart
import 'package:tern_updater/tern_updater.dart';

void main() {
  runApp(const TernUpdateScope(child: MyApp()));
}
```

Put the banner on a safe screen, usually Home, below the AppBar:

```dart
Scaffold(
  appBar: AppBar(title: const Text('Home')),
  body: Column(
    children: [
      const TernUpdateBanner(showProgress: true), // showProgress needs tern_updater 0.3.0+
      Expanded(child: existingBody),
    ],
  ),
)
```

Every file that uses these widgets needs `import 'package:tern_updater/tern_updater.dart';`.

Optional settings:
- **Unsaved-work guard:** `TernUpdateBanner(beforeRestart: () async => !hasUnsavedWork)`.
- **Another channel:** pass `TernUpdateScope(controller: TernUpdateController(channel: TernUpdateChannel.staging), ...)` and set the same `channel:` in `tern.yaml`. The default is `stable`.
- **Downloads only when the user asks:** use `TernUpdateController(autoDownload: false)` *and* set `auto_update: false` in `tern.yaml`. Then call `controller.downloadUpdate()` from your UI.

Debug builds always report `unavailable` and never show the banner. That's expected.

## 5. Verify the integration

Check each of these and fix whatever fails:

- `android/app/src/main/AndroidManifest.xml`: the `<application>` tag has `android:name="cv.hatchmoon.tern.updater.TernApplication"` (or a custom class that calls `TernApplication.install`), and the manifest has the `INTERNET` permission.
- `minSdk` is at least 26 in `android/app/build.gradle(.kts)`.
- `tern.yaml` contains `runtime: tern-native-v1`, `app_id`, `base_url` and `channel`.
- `pubspec.yaml` lists `tern-runtime.json` and `tern.yaml` under `flutter: assets:`, has an explicit `version: x.y.z+n`, and pins `tern_updater` to a tag.
- `.gitignore` contains `.tern.json` and `.tern-build/`.
- `flutter analyze` passes, and `tern doctor` passes.

## 6. First release and patch (confirm with the user first)

```bash
tern release                      # builds and uploads the baseline; prints the original APK path
```

The user installs **that APK** on the test device.

Then change some Dart code, keeping `version:` unchanged:

```bash
tern patch --notes "Describe the change"            # prints the patch id
tern deploy --patch PATCH_ID --channel stable --rollout 100
```

On the device:
1. Open the app. The patch downloads in the background, and the banner shows **Update ready**.
2. Tap **Restart now**. The new code runs after the restart.

Make the first test patch an obvious visible change, such as a text label.

If the change does not appear, check the device logs:

```bash
adb logcat -d | grep TernRuntime     # Windows: adb logcat -d | Select-String TernRuntime
```

- `Starting official Flutter; patch=N` shows which patch the runtime selected.
- `Flutter did not run patch N ...` (tern_updater 0.3.1 and later) means Flutter fell back to the APK's original code.
- On physical ARM phones, tern_updater 0.3.0 can show this fallback without logging it; the fix is in 0.3.2. If the change never appears on such a phone, tell the user rather than retrying blindly.

To undo a bad patch:

```bash
tern rollback --patch PATCH_ID
```

## Reference

- `tern --help`: all commands and options.
- Tern repository docs: `docs/INSTALLATION.md`, `docs/INDEPENDENT_RUNTIME.md` and `packages/tern_updater/README.md`.
