# Roadmap

This roadmap closes the gaps between Tern and hosted Shorebird. Phases are ordered by what blocks real users first. Each item ends with an exit criterion that belongs in [VALIDATION.md](VALIDATION.md) once met.

Current verified scope: Android x86_64 emulator, APK builds, single admin, single process.

Runtime independence is now the priority: new apps use Tern's own native updater on pinned official Flutter. See [the independent runtime guide](INDEPENDENT_RUNTIME.md). Shorebird artifact mirroring and upstream tracking below apply only to maintaining legacy releases. Physical-device and store validation remain outstanding for the new runtime.

## Phase 1 — Production-ready Android

Goal: a real Android app shipped through Google Play can receive Tern patches safely.

1. **AAB release builds.** `tern release` emits APKs only. Add `--artifact aab`, archive the bundle, and extract per-ABI `libapp.so` baselines from it so patches diff against what Play actually installs.
   *Exit:* a bundle uploaded to a Play internal testing track installs, then executes a Tern patch.
2. **Physical ARM devices.** Run `scripts/android-e2e.mjs` against `aarch64` and `arm` hardware, not only the x86_64 emulator.
   *Exit:* patch execution and rollback recorded on at least one arm64 phone and one 32-bit ARM device.
3. **Release signing.** Validate builds with a real upload/app-signing key (not the debug key), including Play App Signing.
   *Exit:* signed release → patch → rollback passes; the APK signature is unchanged after patching.
4. **Patch signing.** The server already stores and serves `hash_signature` but nothing produces it. Add `tern keys create`, sign each patch's `target_hash` in `tern patch`, embed the public key at `tern release`, and reject unsigned patches for releases that carry a key.
   *Exit:* a device rejects a patch with a tampered signature and stays on its current code.
5. **Remote-URL native run.** Repeat the emulator proof against the public HTTPS server instead of `adb reverse`.
   *Exit:* native execution logged against `TERN_PUBLIC_URL`.

## Phase 2 — Operations and scale

Goal: Tern survives real traffic and real outages.

1. **Streaming uploads.** Replace base64 JSON bodies with streamed multipart/binary uploads written straight to disk, and move diff generation to a `worker_threads` pool so it no longer blocks the event loop. Raise or remove the 64 MiB limit.
   *Exit:* a 200 MiB release uploads while `/health` keeps answering under 100 ms.
2. **Object storage and CDN.** Add an S3-compatible artifact backend (S3, R2, MinIO) behind the existing content-addressed `Store.put`, with patch downloads redirected to signed CDN URLs. Keep local disk as the default.
   *Exit:* the same test suite passes against both backends.
3. **Backups.** Add `tern backup` using SQLite's online backup API plus an artifact manifest, and a matching restore. Document a schedule for the VPS guide.
   *Exit:* restore into a fresh container reproduces app/release/patch counts and download hashes.
4. **Persistent sessions.** Sessions live in memory, so restarts sign everyone out. Store hashed session IDs in SQLite.
5. **Monitoring.** Add a `/metrics` endpoint (request counts, check latency, download bytes, install failures) and structured JSON logs.

## Phase 3 — Teams and automation

Goal: more than one person, and CI, can use Tern without sharing the admin key.

1. **Multiple users and roles.** Owner, developer (release/patch), and viewer roles, with invitation links that reuse the existing setup-ticket flow.
2. **Scoped API keys.** Per-app keys limited to `release`, `patch`, or `deploy`, stored hashed, revocable, and with last-used timestamps. `TERN_TOKEN` accepts them.
3. **Audit log.** Record who created, deployed, rolled back, or deleted what, with a retention setting.
4. **CI integration.** A GitHub Actions workflow and a Codemagic example that run `tern release` / `tern patch` with a scoped key.
   *Exit:* a pushed tag produces a patch on staging with no local machine involved.
5. **Promotion command.** `tern promote --patch ID --from staging --to stable --rollout 10`, matching Shorebird's `patches promote`.

## Phase 4 — Safer rollouts

Goal: use Tern's server-side rollouts as an advantage over Shorebird.

1. **Automatic rollback.** Revoke a patch, or pause its rollout, when `__patch_install_failure__` events exceed a threshold within a window. Off by default; configured per deployment.
2. **Rollout schedules.** Step a deployment through percentages (for example 1 → 10 → 50 → 100) over time, holding if the failure threshold trips.
3. **Trusted telemetry.** Optionally sign client events with a per-install key so failure counts can drive automation without being trivially spoofed.
4. **Dashboard charts.** Install, failure, and adoption curves per patch and channel.

## Phase 5 — iOS

Goal: parity with Shorebird's most valuable platform. Highest effort and highest risk, so it comes after Android is solid.

1. **Feasibility spike.** Determine whether the pinned open-source runtime's iOS path (interpreter/linker artifacts from `download.shorebird.dev`) can be built and run without a Shorebird account, and check the licenses involved.
   *Exit:* a written go/no-go in this document.
2. **iOS build pipeline.** `tern release --platform ios` producing an IPA/xcarchive, plus an iOS compatibility manifest equivalent to `tern-android-v1`.
3. **Simulator and device validation.** Patch execution and rollback on the iOS simulator, then on a physical device through TestFlight.
4. **App Store compliance notes.** Document what a patch may change while staying inside App Store Review Guideline 3.3.2 (interpreted code, no new features that change the app's purpose).
5. **`tern_updater` on iOS.** The package's restart flow is Android-only; provide an iOS equivalent (prompt to relaunch, since iOS apps cannot restart themselves).

## Phase 6 — Desktop and independence

1. **macOS, Windows, Linux.** The API already accepts these platforms; add build pipelines and validation for each.
2. **Runtime mirroring.** Mirror the pinned engine artifacts into Tern's own storage so setup does not depend on `download.shorebird.dev` being available.
3. **Upstream tracking.** A script that checks new open-source Shorebird Flutter releases, runs the compatibility and emulator suites against them, and proposes a `runtime/toolchain.json` bump.

## Not planned

- Billing and per-install metering (Tern is self-hosted).
- A hosted multi-tenant service.
