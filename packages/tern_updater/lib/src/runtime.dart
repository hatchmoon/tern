import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';

enum TernUpdateChannel { stable, beta, staging }

enum TernUpdateAvailability { upToDate, outdated, restartRequired, unavailable }

@immutable
class TernPatchState {
  const TernPatchState({this.current = 0, this.next = 0});

  /// Zero represents the original store release.
  final int current;
  final int next;

  /// Includes a rollback from a patch to the original store release.
  bool get restartRequired => current != next;
}

/// Implement to supply a test double or a custom runtime adapter.
abstract interface class TernUpdateDriver {
  bool get isAvailable;
  Future<TernPatchState> readPatches();
  Future<TernUpdateAvailability> check(TernUpdateChannel channel);
  Future<void> download(TernUpdateChannel channel);
  Future<bool> canRestart();
  Future<void> restart();
}

class TernRuntimeDriver implements TernUpdateDriver {
  TernRuntimeDriver() : _updater = ShorebirdUpdater();
  final ShorebirdUpdater _updater;
  static const _channel = MethodChannel('cv.hatchmoon.tern/updater');

  @override
  bool get isAvailable => _updater.isAvailable;
  UpdateTrack _track(TernUpdateChannel channel) => switch (channel) {
    TernUpdateChannel.stable => UpdateTrack.stable,
    TernUpdateChannel.beta => UpdateTrack.beta,
    TernUpdateChannel.staging => UpdateTrack.staging,
  };
  @override
  Future<TernPatchState> readPatches() async {
    final current = await _updater.readCurrentPatch();
    final next = await _updater.readNextPatch();
    return TernPatchState(
      current: current?.number ?? 0,
      next: next?.number ?? 0,
    );
  }

  @override
  Future<TernUpdateAvailability> check(TernUpdateChannel channel) async =>
      switch (await _updater.checkForUpdate(track: _track(channel))) {
        UpdateStatus.upToDate => TernUpdateAvailability.upToDate,
        UpdateStatus.outdated => TernUpdateAvailability.outdated,
        UpdateStatus.restartRequired => TernUpdateAvailability.restartRequired,
        UpdateStatus.unavailable => TernUpdateAvailability.unavailable,
      };
  @override
  Future<void> download(TernUpdateChannel channel) =>
      _updater.update(track: _track(channel));
  @override
  Future<bool> canRestart() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return false;
    try {
      return await _channel.invokeMethod<bool>('canRestart') ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  @override
  Future<void> restart() => _channel.invokeMethod<void>('restart');
}
