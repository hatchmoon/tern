# Tern's independent Android runtime

Tern native v1 uses the official Flutter compiler and Android engine. Tern owns the update downloader, patch verification, persistent activation state, early AOT-library selection, first-frame confirmation, rollback, and Dart API. It does not download or link Shorebird's engine, updater, Dart package, or private compiler. Flutter itself remains an upstream dependency.

This is an Android implementation, not an iOS interpreter or a new Dart VM. It uses the Android embedding's supported AOT-library argument to select an authenticated compiled Dart library from the application's private files directory before Flutter initializes. No engine source fork is necessary for this implementation. The integration is pinned and tested against official Flutter 3.44.8; the pin is in `runtime/toolchain.json`.

## New Android application

Install Java 17+, Android SDK/NDK and platform tools, then link the CLI and install its pinned SDK:

```powershell
npm link
tern setup

cd C:\path\to\flutter_app
tern init --name "My app" --configure-runtime --server https://tern.hatchmoon.cv
```

CLI management authentication still uses `TERN_TOKEN` or `--token-file`. No administrator credential is embedded in the app.

Initialization adds the local `tern_updater` package, Internet permission, the early `TernApplication` loader, and runtime assets. The Android minimum is API 26. The CLI supports standard Kotlin Gradle scaffolds; inspect an existing Groovy Gradle project's `minSdkVersion` and set it to at least 26 yourself. Custom Android Application classes are never overwritten: call `TernApplication.install(this)` before Flutter initialization and add the package and assets manually.

Wrap the app root with `TernUpdateScope` and put `TernUpdateBanner` on an appropriate screen. See [the Flutter package guide](../packages/tern_updater/README.md) for the full integration.

```dart
void main() => runApp(const TernUpdateScope(child: MyApp()));
```

Use an explicit version/build, for example `version: 1.0.0+1`, then:

```powershell
tern release
# Distribute/install the original APK reported by this command.
# Change Dart code, keeping the release version and build number unchanged.
tern patch --notes "Fix checkout"
tern deploy --patch PATCH_ID --channel staging --rollout 100
tern deploy --patch PATCH_ID --channel stable --rollout 100
```

For staging tests, select staging in both the YAML and app controller. A downloaded patch becomes executable only on a fresh app process. The reusable banner offers a confirmed cold restart; Tern never forcibly restarts the user during work.

## Compatibility and signatures

The CLI generates an RSA-3072 signing key per application under `.tern-data/signing/APP_ID.private.pem`. Back it up securely. A new build machine must restore the original signing key to patch its existing releases. Private keys never enter APKs, project configuration, uploads, or Git. The APK contains the public key in generated `tern-runtime.json`.

Every patch is signed over its application ID, release version, exact engine revision, architecture and target SHA-256. Both the server and device verify this context. The device also verifies the complete library hash and ELF architecture before staging and again before launch. A matching hash alone is not authorization. Update requests and binaries use HTTPS; loopback HTTP is explicitly restricted to local testing. Redirects and cross-origin downloads are rejected in v1.

The existing compatibility manifest rejects changes to native libraries, DEX, Android resources, bundled Flutter assets, the engine, the entry point or signing configuration. Those changes need a new baseline APK. Native rollback marks revoked patches unusable. If a patch does not reach its first rendered frame, its next launch falls back to a previous confirmed patch or the original APK. Exiting or being killed before that first frame also triggers this conservative recovery; it is not a general crash detector after successful startup.

For now devices download the complete signed `libapp.so`. The server retains its independently implemented binary delta and reconstructs the target for the native endpoint. This saves implementation dependencies but downloads more bytes and does reconstruction work on the server. Streaming, compressed native transport and caching are future improvements. The current artifact limit is 64 MiB. Native libraries, APK installation and signing, Flutter, Java and Android tools are still required.

## Existing Shorebird-runtime releases

An already installed engine cannot be replaced by a Dart patch. Keep `tern.yaml` without `runtime: tern-native-v1` and use `tern setup --runtime legacy` when building patches for those old releases. Its pin is retained separately in `runtime/legacy-toolchain.json`. The server isolates offers for the two runtimes.

To migrate, create a new release version/build, upgrade any existing `tern_updater` dependency to 0.2.0, then run `tern integrate` from the project folder. This preserves its app ID and server URL, selects `runtime: tern-native-v1`, and wires in the early loader and assets. Add the scope/banner to the app and run `tern release` to build/distribute a new baseline APK. The old 0.1.0 package tag remains available for older installations. Do not change the original release's runtime metadata or overwrite its binaries. Winstar's current production installation is not automatically migrated by this work.

## Verification

```powershell
# Optional reuse of an installed official SDK; revision must exactly match the pin.
$env:TERN_FLUTTER_ROOT = "C:\Users\DP\flutter"
npm run test:independent-runtime
```

The verifier uses a disposable local server and an x86_64 emulator. It checks a baseline APK, on-device rejection of a bad signature, execution of a signed downloaded Dart patch, banner-driven restart, server revocation, and recovery from a signed patch that exits before its first frame. It checks APK hash and installation timestamp to rule out reinstalling the patch APK. Evidence is saved in ignored `test-results/independent-runtime/`. It does not use production applications.

Physical ARM64/ARM32 execution, iOS, other Flutter versions, custom Application integrations and store distribution are separate validation work. A successful x86_64 emulator run does not establish those results.

Upstream implementation references: [FlutterLoader](https://github.com/flutter/flutter/blob/058e0af2c2b57e369d905a03ac9748b0ebf543c6/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/loader/FlutterLoader.java), [FlutterInjector](https://github.com/flutter/flutter/blob/058e0af2c2b57e369d905a03ac9748b0ebf543c6/engine/src/flutter/shell/platform/android/io/flutter/FlutterInjector.java). Tern's runtime implementation is original code using these APIs.
