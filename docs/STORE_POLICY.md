# Tern and app store policies

Tern updates the Dart code of Android apps without a store release. This page explains what patches may change, where Tern can be used, and the safeguards it provides. It is guidance, not legal advice. Google decides what its policies allow.

## What a patch can change

A Tern patch replaces only the app's compiled Dart code. `tern patch` rejects a patch that changes anything else:

- native code (Java/Kotlin, DEX, native libraries other than the Dart code)
- Android resources, the manifest, bundled Flutter assets and fonts
- the Flutter engine, the entry point or the signing configuration

Those changes need a new version/build, a new `tern release`, and a normal store update.

## Rules for patches

- **Don't change what the app is for.** Patches are for fixes and improvements to the reviewed app, not new purposes or hidden features.
- **Don't use patches to avoid store review.** If a change would need review (new permissions, payments, account or data-handling changes), ship it as a store release.
- **Follow the store's policies in every patch.** Content, privacy and security rules apply to patched code exactly as they apply to the original app.
- **Don't deceive users.** Describe changes honestly in release notes and in the app.

## Google Play

Google Play's [Device and Network Abuse policy](https://support.google.com/googleplay/android-developer/answer/9888379) says an app distributed through Google Play may not modify, replace or update itself using any method other than Google Play's update mechanism. It lists downloading executable code, including native code, from outside Google Play as a violation, and applies this to SDKs as well. It exempts code that runs in a virtual machine or an interpreter with indirect access to Android APIs, and requires such code to follow all Play policies.

Tern patches are compiled Dart code that runs in the Dart runtime, the same model as other Flutter code-push tools such as Shorebird. Whether that falls under the exemption is Google's decision, and Tern has no review history on Google Play yet. Before relying on Tern in a Play-distributed app:

1. Publish a Tern-enabled build to an internal or closed testing track and confirm it passes review.
2. Keep patches within the rules above.
3. Keep a store-release path ready for every change.

Apps distributed outside Google Play (APK distribution, MDM/EMM, internal stores) are not subject to Play's policies. Check your organization's own device and security rules. Apps published as private apps through managed Google Play are still uploaded through the Play Console; assume Play's policies apply to them.

Tern does not support iOS.

## Safeguards

- **Signed patches.** Each patch is signed with the app's private key, held only on the build machine, over its app ID, release version, engine revision, architecture and SHA-256. Devices verify the signature and the complete file hash before using a patch.
- **HTTPS only.** Devices refuse plain HTTP (except loopback for local testing), redirects and cross-origin downloads.
- **Startup protection.** A patch that does not draw its first frame is rolled back on the next launch.
- **Crash protection.** A patch whose app stops while in use in two consecutive sessions is rolled back to the previous working patch or the original release, and the failure is reported to the server (tern_updater 0.3.2 and later).
- **Fallback detection.** If Flutter starts the original code instead of the selected patch, the patch is marked bad and the failure is reported (tern_updater 0.3.1 and later).
- **Staged rollout and rollback.** Deploy to `staging` first and use `--rollout` percentages. `tern rollback --patch PATCH_ID` revokes a patch on all devices at their next check.
- **No forced restarts.** A downloaded patch applies only on a fresh app start. The update banner asks before restarting.

## Your responsibilities

- Back up the patch-signing key securely and keep it out of source control and shared folders. Whoever holds it, together with a way to serve updates, can run code in your app.
- Protect your Tern dashboard account and revoke machines you no longer use.
- Never put secrets in Dart code. Anyone who knows the app ID can download its patches, just as anyone can unpack its APK.
