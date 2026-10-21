# Flutter runtime integration

Tern now installs and uses a pinned open-source Shorebird Flutter engine/compiler for its Android project builds. Its own server implements release/patch distribution and the native updater's HTTP interface. Android native patch execution and rollback have passed on an x86_64 emulator. Start with the [Android quickstart](ANDROID.md). Adding only a Dart HTTP client to stock Flutter still does not enable executable Dart updates.

## Android first

For an Android proof of concept:

1. Run `npm run cli -- setup`. Tern downloads the exact Flutter commit and runtime artifacts pinned in `runtime/toolchain.json`, separately from your system SDK. The project build commands use it automatically.
2. Put this configuration in the Flutter app's `tern.yaml` before building the original APK. Replace the example ID and URL with real values. A physical device cannot reach your computer through `127.0.0.1`.

```yaml
app_id: YOUR_TERN_APPLICATION_ID
base_url: https://updates.example.com
channel: staging
auto_update: true
```

3. Include `tern.yaml` in the app's Flutter assets. Tern's build command temporarily generates the `shorebird.yaml` asset expected by the pinned native engine, then restores the project's `tern.yaml` entry, even if the build fails. Existing legacy project configuration migrates automatically on the next build. Keep the same application ID between the release and patch.
4. Build the store release using `tern release` from your app folder after installing the CLI with `npm link`. The command extracts `lib/<ABI>/libapp.so` from the actual APK and preserves the original APK. Map `arm64-v8a` to `aarch64`, `armeabi-v7a` to `arm`, and `x86_64` to `x86_64` for advanced raw uploads.
5. Register the release using the exact version string reported by the native updater, including its build number when applicable. Tern matches this field literally. Include every architecture you intend to patch.
6. Compile changed Dart code using the original engine, compiler flags, obfuscation settings, and entry point. Upload the resulting `libapp.so` for every registered architecture. The engine revision field is a metadata guard; Tern cannot prove from an arbitrary uploaded file that the claimed compiler was used.
7. Deploy the patch to `staging`. Install the original updater-enabled APK, launch it, and allow its update check and download to finish. Restart it to boot the new code. This execution sequence has passed on the local x86_64 emulator using the included sample. Physical-device verification remains specific to your app and hardware.
8. Revoke the patch, trigger another check, and restart again to verify fallback behavior on the actual engine.

Shorebird's stock CLI also communicates with its hosted build/control APIs. Pointing the embedded updater's `base_url` at Tern does not make the upstream CLI work against this server. Tern's `release --project PATH` and `patch --project PATH` commands build with the pinned SDK, inspect the actual packaged binaries, and upload to Tern directly. Raw artifact uploads remain available for advanced workflows.

## iOS

iOS requires the upstream-compatible Dart interpreter and compiler/linker pipeline as well as the updater. An arbitrary iOS AOT binary is not sufficient. The server can store and distribute iOS patch containers, but it does not produce an interpreted Dart program, reuse the signed base snapshot, or link patched functions. Do not describe an iOS patch as working until an actual compatible build has passed device testing.

The same distinction applies to desktop platforms: API platform names are supported, but native execution depends on the chosen engine and build.

## Artifact format

`lib/patch.mjs` independently implements the bidiff v1 format consumed by the upstream updater's `bipatch = 1.0.0` dependency, wrapped in a zstd frame. The response's `patch.hash` is the SHA-256 of the **reconstructed target**, not of the compressed download. All patches are relative to the original release artifact. Devices can skip intermediate patch numbers.

The built-in encoder uses a position-wise additive delta followed by a literal extension. It is valid bidiff v1 and compresses sparse changes efficiently, but does not implement suffix-array matching: compiler output with large moved sections may yield bigger patches than upstream's optimized generator. You can submit a more efficient prebuilt compatible diff via the API. The server applies it to the original binary and verifies the declared target hash before saving it.

The optional `tools/native-verifier` uses upstream `bipatch` and `zstd` to independently reconstruct a patch. This validates format interoperability; it still does not execute Flutter code.

## Signatures

Uploaded `bidiff-v1-zstd` artifacts may include `hash_signature`, passed through to the native updater unchanged. Signing and public-key provisioning are external: Tern does not generate keys, sign patches, or verify that signature against a configured public key. Configure the matching `patch_public_key` in your actual runtime if you use upstream signature verification. The server verifies reconstruction and SHA-256, and HTTPS protects delivery in transit. Do not assume an unsigned hash authenticates a patch against a compromised server.

The CLI simulator checks target hashes only. It neither verifies the optional signature nor validates whether reconstructed machine code will launch successfully.

## Protocol sources

- [Updater configuration and custom base URL](https://github.com/shorebirdtech/updater/blob/main/library/src/config.rs)
- [Configuration YAML fields](https://github.com/shorebirdtech/updater/blob/main/library/src/yaml.rs)
- [Patch check and response types](https://github.com/shorebirdtech/updater/blob/main/library/src/network.rs)
- [Native install/download/failure events](https://github.com/shorebirdtech/updater/blob/main/library/src/events.rs)
- [Upstream patch tool](https://github.com/shorebirdtech/updater/tree/main/patch)
- [Architecture, including compiler and engine changes](https://docs.shorebird.dev/code-push/system-architecture/)
