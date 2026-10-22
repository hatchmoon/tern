# Tern Updater for Flutter

Tern's independent Android update runtime, reusable update status, an **Update ready** banner, and a confirmed **Restart now** action. Version 0.2.0 uses official Flutter and has no Shorebird package dependency. It requires a new baseline APK and is not published to pub.dev. Read the [runtime setup and migration guide](../../docs/INDEPENDENT_RUNTIME.md) before upgrading an existing app.

## Install once per application

From the private GitHub repository, use the version tag and package subdirectory:

```yaml
dependencies:
  tern_updater:
    git:
      url: https://github.com/hatchmoon/tern.git
      ref: tern-updater-v0.2.0
      path: packages/tern_updater
```

Your development/build machine must have GitHub read access to that private repository. Authenticate Git outside the Flutter app; never put a GitHub token in pubspec.yaml. Keep the version tag pinned so builds use the same native plugin source. Obtain newer SDK versions by updating the tag when creating a new baseline release.

From a Flutter application on this development machine:

```powershell
flutter pub add tern_updater --path D:/HatchMoon/tern/packages/tern_updater
```

Use the pinned official Flutter 3.44.8 SDK, Java 17+, Android API 26+ and a build setup compatible with AGP 8.11.1 and compile SDK 36. `tern init --configure-runtime` connects the early Android loader and assets for a new app. Merely adding the Dart package is insufficient. Tern releases and patches must continue using the same pin. Normal Flutter debug builds expose `unavailable` update state and show no update banner.

Alternatively, copy this package or extract the supplied ZIP, then change the dependency path. Do not add administrator tokens, signing private keys or passwords to the app. The CLI builds public runtime configuration from `tern.yaml` and embeds the signing public key in `tern-runtime.json`.

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

The default channel is stable, matching existing Winstar releases. If you select another channel, make the native automatic updater's configured channel match, or disable native automatic checks using `auto_update: false` before building a new baseline so this controller manages all checks. Do not change packaged YAML inside an existing release merely to change channels.

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

## Custom UI and manual checks

```dart
final updates = TernUpdateScope.of(context);
final state = updates.state;

// On an explicit Check for updates button:
await updates.checkForUpdates();

// state.phase: checking, downloading, restartRequired, upToDate, unavailable,
//              failed, restarting (or idle before the first check).
// state.currentPatch / state.nextPatch: 0 means the original store release.
// state.canRestart, state.dismissed, state.error are available for custom UI.
```

Checks are coalesced so repeated taps do not start parallel downloads. A readiness banner waits for a committed next-patch value; a native download still in progress does not trigger a premature restart. Network errors are available in state and never block app use. Already-staged updates remain available offline. Direct calls to `updates.restart()` require your own user confirmation and saving work first.

## One new baseline APK is required

Adding this plugin changes Android native code and the manifest. Integrate it into a **new release version/build**, build with `tern release`, and distribute that original APK once. Do not upload the integration as a patch for an existing baseline: Tern's native compatibility guard correctly rejects it.

For Winstar, keep the installed `2.0.3+1` baseline and its patch history intact. After wiring the scope in `lib/main.dart` and the banner in `lib/homepage.dart`, use a new build such as `2.0.3+2`. The native restart helper will be included in that new APK. Later compatible Dart-only updates use `tern patch` and the same restart flow.

No server migration is needed. Existing apps that have not integrated this package keep their current updater behavior.

## Example and checks

`example/` is a standalone Android app with the banner, running/next patch status, a manual check button, and an unsaved-note restart guard. Initialize it with your Tern server before a release. Its Android manifest permits cleartext **only for the local emulator example**; real applications should use HTTPS.

From this package: `flutter analyze` and `flutter test`.

Version 0.1.0 passed analysis and 13 controller/widget tests. Its native Android x86_64 emulator check also passed: original process → banner and confirmation → downloaded patch in a new process → banner and confirmation → original code after rollback. The APK was installed once and no external Force stop was used to apply either change. This validates the reusable package's Android restart path; physical-device/OEM validation is still needed when integrating a new baseline into your app.

From the Tern repository, with an Android x86_64 emulator running: `node scripts/flutter-sdk-e2e.mjs`. The verifier creates a dedicated temporary app and local database, installs its original APK once, and uses the real package to download a Dart patch, tap Restart now and confirm, then repeat after rollback. It never uses the production server or installs Winstar. Evidence is saved in `test-results/flutter-sdk/`.

Android OEM behavior and application-specific foreground services should also be tested on your target devices. The helper uses a non-exported activity in a `:tern_restart` process without alarm or extra Android permissions. Apps with a custom native `Application` class should avoid starting background work/Flutter engines in that helper process.
