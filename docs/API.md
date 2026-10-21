# API contract

All JSON requests use `Content-Type: application/json`. Management routes require `Authorization: Bearer ADMIN_KEY` or a valid dashboard session cookie. Cross-origin browser requests are rejected. Errors return `{ "error": "message" }` with the corresponding status code.

## Management

| Method | Route | Body / purpose |
| --- | --- | --- |
| GET | `/health` | Public readiness and version |
| GET | `/api/auth/status` | Public `{password_sign_in}` setup readiness; no account details |
| POST | `/api/session` | `{email,password}`; creates a 12-hour HttpOnly session |
| DELETE | `/api/session` | Invalidates session |
| POST | `/api/auth/setup/status` | `{token}`; private one-time setup ticket returns bound email and expiry |
| POST | `/api/auth/setup` | `{token,password}`; consumes setup/recovery ticket and creates a session |
| POST | `/api/account/password` | `{current_password,new_password}`; changes password and revokes other sessions |
| GET | `/api/snapshot` | Apps, releases, patches, deployments, fleet counts, latest 50 events |
| POST | `/api/apps` | `{name}` |
| DELETE | `/api/apps/:id` | `{confirm_name}`; exact application name required; permanently removes the app and all dependent data |
| POST | `/api/releases` | `{app_id,version,platform,engine_version,artifacts}` |
| GET | `/api/releases/:id/artifacts/:arch` | Private original binary |
| POST | `/api/patches` | `{release_id,engine_version,notes?,artifacts}` |
| POST | `/api/patches/:id/deploy` | `{channel,rollout:0..100}`; default rollout 100 |
| POST | `/api/patches/:id/rollback` | `{}`; permanent, idempotent revocation |

Artifact input is `{arch,data}` with strict base64 `data`. Releases accept raw original binaries. Patches default to raw target binaries; the server generates a compatible diff. Alternatively, a patch artifact can contain `{arch,data,format:"bidiff-v1-zstd",target_hash,hash_signature?}` for a prebuilt delta. The original is used to verify reconstruction. Combined binary input limit: 64 MiB; JSON body limit: 90 MiB. Every patch must include all original architectures.

There is one administrator account and no public registration. Issue a private setup/recovery link from the server with `node server/admin.mjs setup --email you@example.com --origin https://updates.example.com` (add `--reset` for recovery). The URL is saved privately in the data directory as `admin-setup-url`; it is not printed by the utility. Tickets expire in one hour, are stored as hashes, and can be used once. Passwords accept 15–128 Unicode characters and are stored using salted scrypt. Password changes and recovery revoke existing browser sessions. Sessions are held in memory and server restarts require signing in again; credentials persist in SQLite. HTTPS enables Secure cookies. Legacy `{token}` browser sign-in is accepted only before an administrator account exists; API Bearer keys continue working for CLI/automation after setup.

Application deletion removes releases, manifests, patches, deployments, devices, and events in one transaction. Unreferenced artifact files are removed afterward; artifacts shared with other applications are retained. The response is `{deleted:true,app_id,removed_artifacts,artifact_cleanup_pending}`. A nonzero cleanup count means files could not be removed and details are logged on the server. Deletion stops future update offers; it does not uninstall an app or revoke code already installed on a device. Revoke patches and allow devices to check for rollback before deleting if rollback is needed.

Android project builds also include `build_manifest`, with format `tern-android-v1` (APK) or `tern-android-aab-v1` (app bundle, paths under `base/`), `flutter_revision`, `engine_revision`, `target`, and a `files` map of native/bundled-asset paths to SHA-256 hashes. The release's manifest is persisted and returned in snapshots. Every patch targeting a managed release must supply a manifest with the same format, runtime, entry point, and file fingerprints. Missing or changed fingerprints return 409. The project CLI generates this automatically; the native dashboard upload form accepts its generated JSON file. Manifest metadata is an administrator-supplied compatibility guard, not a cryptographic build attestation.

Patch numbers increase per release, which is scoped to app + version + platform. They are not reused after rollback. A deployment points one release/channel to one active patch and rollout percentage. Deploying to one channel does not remove deployments on other channels. The server rejects lower patch numbers while a newer patch is deployed in that channel, because native updaters are monotonic until a revocation.

## Public updater routes

### POST `/api/v1/patches/check`

```json
{
  "app_id": "application-uuid",
  "release_version": "1.0.0+1",
  "platform": "android",
  "arch": "aarch64",
  "channel": "stable",
  "client_id": "persistent-random-install-uuid",
  "current_patch_number": 0
}
```

`channel` defaults to `stable`; a null/missing current patch means 0. Legacy `patch_number` is also accepted. A client without an ID is eligible only for a 100% rollout and does not contribute fleet metrics. Unknown app/release/architecture returns no patch. Invalid field values return 400.

```json
{
  "patch_available": true,
  "patch": {
    "number": 1,
    "hash": "sha256-of-reconstructed-target",
    "download_url": "https://updates.example.com/artifacts/content-hash",
    "hash_signature": null
  },
  "rolled_back_patch_numbers": []
}
```

No patch: `patch_available:false`, `patch:null`. Revoked numbers are always included even when no replacement is available or the current patch is newer. A rollback is not immediate remote process termination; clients act on their next check and restart.

Cohorts hash app/release/channel/client ID to a stable bucket out of 10,000. Growing the rollout preserves existing cohort members. Reducing the percentage or setting 0 only prevents new downloads. To remove a patch already installed, revoke it. Devices with a patch number equal to or greater than the channel's current target are not offered that target again.

### POST `/api/v1/patches/events`

```json
{
  "event": {
    "app_id": "application-uuid",
    "release_version": "1.0.0+1",
    "platform": "android",
    "arch": "aarch64",
    "client_id": "persistent-random-install-uuid",
    "patch_number": 1,
    "type": "__patch_install__",
    "timestamp": 1792540800
  }
}
```

Types: `__patch_download__`, `__patch_install__`, `__patch_install_failure__`, `__patch_update_failure__`. Returns 201 `{accepted:true}`. Duplicates collapse by patch/type/hashed install/architecture. Timestamps in stored activity use server receipt time, not untrusted client time. Optional messages are truncated to 500 characters. Unknown releases/patches/architectures are rejected. Public telemetry is not authenticated and can be fabricated by a caller; do not use it for automatic safety decisions.

Fleet counts come from the latest check per app/hashed install/release/architecture seen within 30 days. Install outcomes are lifetime unique event counts and may include the same install reporting a failure then success. They are not crash-free session percentages. Demo simulations appear in those same counts under the explicitly named demo application. Raw install identifiers are hashed with a server secret before persistence and excluded from dashboard snapshots.

### GET / HEAD `/artifacts/:sha256`

Only published patch blobs are downloadable through this public path. SHA-256 content addressing, immutable caching, byte-range resume, and suffix ranges are supported. A release's original binary is not exposed here unless those exact bytes also independently exist as a patch blob.

Rate limits per remote IP/minute: 30 login requests (five failed attempts also block login for one minute), 10 setup attempts, six password changes; 1,200 patch checks and 1,200 telemetry requests. Password derivations are limited to two concurrent operations. These in-memory limits are per process; reverse proxies should apply their own limits when deployed. A shared NAT can contain many clients. Forwarded-IP headers are ignored by default. `TERN_TRUST_PROXY=true` trusts the first validated address in `X-Forwarded-For`; use it only behind a proxy that replaces that header and prevents direct backend access.
