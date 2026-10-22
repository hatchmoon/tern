import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

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
  TernRuntimeDriver();
  static const _channel = MethodChannel('cv.hatchmoon.tern/updater');

  @override
  bool get isAvailable => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  @override
  Future<TernPatchState> readPatches() async {
    final patches = await _channel.invokeMapMethod<String, dynamic>('readPatches');
    return TernPatchState(
      current: patches?['current'] as int? ?? 0,
      next: patches?['next'] as int? ?? 0,
    );
  }

  @override
  Future<TernUpdateAvailability> check(TernUpdateChannel channel) async =>
      switch (await _channel.invokeMethod<String>('check', {'channel': channel.name})) {
        'upToDate' => TernUpdateAvailability.upToDate,
        'outdated' => TernUpdateAvailability.outdated,
        'restartRequired' => TernUpdateAvailability.restartRequired,
        _ => TernUpdateAvailability.unavailable,
      };
  @override
  Future<void> download(TernUpdateChannel channel) =>
      _channel.invokeMethod<void>('download', {'channel': channel.name});
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
