import 'dart:async';
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

/// What the native runtime is doing before a patch is staged.
@immutable
class TernDownloadStatus {
  const TernDownloadStatus({
    this.availablePatch = 0,
    this.downloadingPatch = 0,
    this.receivedBytes = 0,
    this.totalBytes,
  });

  /// A patch offered by the server that is not staged yet; zero for none.
  final int availablePatch;

  /// The patch being downloaded; zero when no download is running.
  final int downloadingPatch;
  final int receivedBytes;

  /// Null when the server did not report a size.
  final int? totalBytes;

  bool get downloading => downloadingPatch > 0;
}

/// Optional driver capability: report available patches and download progress,
/// including downloads the native runtime starts on its own.
abstract interface class TernDownloadStatusSource {
  Future<TernDownloadStatus> readStatus();
  Stream<TernDownloadStatus> get statusChanges;
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

class TernRuntimeDriver implements TernUpdateDriver, TernDownloadStatusSource {
  TernRuntimeDriver();
  static const _channel = MethodChannel('cv.hatchmoon.tern/updater');
  static final StreamController<TernDownloadStatus> _status =
      StreamController.broadcast(
        onListen: () => _channel.setMethodCallHandler((call) async {
          if (call.method == 'status') {
            _status.add(_parseStatus(call.arguments as Map<Object?, Object?>?));
          }
        }),
      );
  static TernDownloadStatus _parseStatus(Map<Object?, Object?>? value) {
    final total = value?['total'] as int? ?? -1;
    return TernDownloadStatus(
      availablePatch: value?['available'] as int? ?? 0,
      downloadingPatch: value?['downloading'] as int? ?? 0,
      receivedBytes: value?['received'] as int? ?? 0,
      totalBytes: total < 0 ? null : total,
    );
  }

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

  @override
  Future<TernDownloadStatus> readStatus() async {
    try {
      return _parseStatus(await _channel.invokeMapMethod<Object?, Object?>('readStatus'));
    } on MissingPluginException {
      return const TernDownloadStatus();
    }
  }

  @override
  Stream<TernDownloadStatus> get statusChanges => _status.stream;
}
