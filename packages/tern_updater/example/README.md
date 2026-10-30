# Tern integration example

See [the package guide](../README.md) for installation, a home-screen banner,
restart confirmation, and the unsaved-work guard demonstrated here.

Initialize this app with `tern init --configure-runtime --channel staging
--manual-updates --server YOUR_TERN_ORIGIN`, then create a baseline with
`tern release`. Install that original APK once; compatible Dart changes can
then be patched. The manifest allows cleartext for local emulator testing.

The banner shows available, downloading and ready updates (`showProgress: true`)
and its restart confirmation dialog.
