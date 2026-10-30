# Tern Updater for Flutter

The Flutter package for [Tern](https://tern.hatchmoon.cv), a self-hosted code-push service for Flutter apps. It contains Tern's Android update runtime, update status for your own UI, update-available, downloading and **Update ready** banners, and a confirmed **Restart now** action. It uses official Flutter and needs no Shorebird package. Updates need a Tern server and apps built with the Tern CLI. The package is not published to pub.dev.

## Install once per application

Add the package from this repository, pinned to a version tag:

```yaml
dependencies:
  tern_updater:
    git:
      url: https://github.com/hatchmoon/tern_updater.git
      ref: v0.3.0
```

`tern init --configure-runtime` and `tern integrate` add this dependency for you, together with the early Android loader, Internet permission and runtime assets. Adding the Dart package alone is not enough.

Keep the version tag pinned: releases and their patches must be built with the same native plugin source. Move to a newer tag only when you build a new baseline release. Apps released with 0.2.0 keep using 0.2.0 for their patches; 0.3.0 changes native code and needs a new baseline. Releases made before this repository existed used `ref: tern-updater-v0.2.0` with `path: packages/tern_updater` from Tern's own repository; those keep working unchanged.

Use the pinned official Flutter 3.44.8 SDK, Java 17+, Android API 26+ and a build setup compatible with AGP 8.11.1 and compile SDK 36. Tern releases and patches must continue using the same pin. Normal Flutter debug builds expose `unavailable` update state and show no update banner.

Never put administrator tokens, signing private keys or passwords in the app. The CLI builds public runtime configuration from `tern.yaml` and embeds the signing public key in `tern-runtime.json`. Patches are accepted only with a valid signature and SHA-256 hash.

## Wrap your application

```dart
import 'package:flutter/material.dart';
import 'package:tern_updater/tern_updater.dart';

void main() {
  runApp(const TernUpdateScope(child: MyApp()));
}
```

`MyApp` is your existing app widget. Put the scope above its `MaterialApp` so the controller survives navigation. By default it checks **stable** on startup and foreground resume, checks the server at most every five minutes, and inspects the local runtime every 15 seconds while foregrounded. It downloads available patches without blocking the UI. Backgrounding pauses the timer; it never restarts automatically.

For beta/staging or different intervals, supply an app-owned controller:

```dart
final updates = TernUpdateController(
  channel: TernUpdateChannel.staging,
  checkInterval: const Duration(minutes: 5),
);

// In your app root's build:
TernUpdateScope(controller: updates, child: const MyApp())

// Dispose updates when its owning app-root State is disposed.
```

The default channel is stable. If you select another channel, make the native automatic updater's configured channel match, or disable native automatic checks using `auto_update: false` before building a new baseline so this controller manages all checks. Do not change packaged YAML inside an existing release merely to change channels.

## Add the banner to your home screen

Place it below your AppBar, above your existing body:

```dart
Scaffold(
  appBar: AppBar(title: const Text('Home')),
  body: Column(
    children: [
      const TernUpdateBanner(),
      Expanded(child: existingHomeContent),
    ],
  ),
)
```

`existingHomeContent` is your current home-screen body. The banner occupies no space until the runtime reports a different patch staged for next launch. This includes rollback to the original store release. It inherits your Material theme, uses 16 px text, supports larger accessibility text, and has 48 px action targets.

- **Restart now** asks for confirmation, then uses the Android helper to stop the old application process and launch a fresh one. The updater loads the staged code on that new launch. It does not clear app data or reinstall the APK. In-memory state and unsaved edits are lost during restart.
- **Later** hides the banner for that staged patch for the controller's current lifetime. It leaves the downloaded patch on disk. A different pending patch shows the banner again; any ordinary fresh launch still applies the staged code.
- Without a native restart helper, the banner gives manual close/reopen instructions and omits Restart now. Automatic restart support in this package is Android-only.

Place the banner on a safe screen such as Home. It does not display itself over order/return forms or force an immediate update. For additional unsaved-work protection, return false from `beforeRestart`; the normal confirmation dialog is still shown when it returns true:

```dart
TernUpdateBanner(
  beforeRestart: () async {
    return !hasUnsavedWork;
  },
)
```

## Show available and downloading updates

By default the banner appears only when an update is downloaded and ready. Pass `showProgress: true` to also show the earlier states:

```dart
const TernUpdateBanner(showProgress: true)
```

- **Downloading update** with a progress bar and percentage while a patch downloads. This includes the download the native runtime starts on its own after launch. The percentage is omitted when the server does not report a size.
- **Update available** with **Later** and **Download** when a patch has been found but not downloaded. This only happens when automatic download is off (below).
- **Update ready** as before, once the patch is staged.

To let users choose when to download, turn off automatic download in both places, then build a new baseline:

```dart
final updates = TernUpdateController(autoDownload: false);
```

```yaml
# tern.yaml: stops the native runtime downloading after launch.
auto_update: false
```

With `autoDownload: false` alone, the controller only reports the patch as available, but the native runtime still downloads it after the next launch. `tern.yaml` is packaged into the APK, so changing `auto_update` requires a new baseline. Call `updates.downloadUpdate()` from your own UI to download an available patch.

## Custom UI and manual checks

```dart
final updates = TernUpdateScope.of(context);
final state = updates.state;

// On an explicit Check for updates button:
await updates.checkForUpdates();

// state.phase: checking, available, downloading, restartRequired, upToDate,
//              unavailable, failed, restarting (or idle before the first check).
// state.currentPatch / state.nextPatch: 0 means the original store release.
// state.availablePatch: found but not downloaded (0 for none or unknown).
// state.downloadingPatch, state.receivedBytes, state.totalBytes and
// state.downloadProgress (0–1, null when the size is unknown) while downloading.
// state.canRestart, state.dismissed, state.error are available for custom UI.

// With autoDownload: false, after the user chooses to download:
await updates.downloadUpdate();
```

Download progress arrives from the native runtime about four times per second. `restartRequired` can be true while a newer patch downloads; Restart now stays disabled until that download finishes.

Checks are coalesced so repeated taps do not start parallel downloads. A readiness banner waits for a committed next-patch value; a native download still in progress does not trigger a premature restart. Network errors are available in state and never block app use. Already-staged updates remain available offline. Direct calls to `updates.restart()` require your own user confirmation and saving work first.

## One new baseline APK is required

Adding this plugin changes Android native code and the manifest. Integrate it into a **new release version/build**, build with `tern release`, and distribute that original APK once. Do not upload the integration as a patch for an existing baseline: Tern's native compatibility guard correctly rejects it.

For an app already in use, keep its installed baseline and patch history intact. After wiring the scope into your app root and the banner into your home screen, bump the build number (for example `2.0.3+1` to `2.0.3+2`). The native restart helper is included in that new APK. Later compatible Dart-only updates use `tern patch` and the same restart flow.

No server migration is needed. Existing apps that have not integrated this package keep their current updater behavior.

## Example and checks

`example/` is a standalone Android app with the banner, running/next patch status, a manual check button, and an unsaved-note restart guard. Initialize it with your Tern server before a release. Its Android manifest permits cleartext **only for the local emulator example**; real applications should use HTTPS.

From this package: `flutter analyze` and `flutter test`.

Version 0.1.0 passed analysis and 13 controller/widget tests. Its native Android x86_64 emulator check also passed: original process → banner and confirmation → downloaded patch in a new process → banner and confirmation → original code after rollback. The APK was installed once and no external Force stop was used to apply either change. This validates the reusable package's Android restart path; physical-device/OEM validation is still needed when integrating a new baseline into your app.

Tern's own repository also runs this example on an Android x86_64 emulator against a temporary local server: it installs the original APK once, downloads a Dart patch, taps Restart now and confirms, then repeats after rollback.

Android OEM behavior and application-specific foreground services should also be tested on your target devices. The helper uses a non-exported activity in a `:tern_restart` process without alarm or extra Android permissions. Apps with a custom native `Application` class should avoid starting background work/Flutter engines in that helper process.

## Development

This repository is published from Tern's main repository, where the package is developed together with the CLI and server. Report issues here.

## License

MIT. See [LICENSE](LICENSE).
