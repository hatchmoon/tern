import 'dart:async';
import 'package:tern_updater/tern_updater.dart';

class FakeDriver implements TernUpdateDriver {
  bool available = true, restartSupported = true, commitDownload = true;
  int checks = 0, downloads = 0, restarts = 0;
  TernUpdateChannel? checkedChannel, downloadedChannel;
  TernPatchState patches = const TernPatchState();
  TernUpdateAvailability result = TernUpdateAvailability.upToDate;
  Object? checkError, restartError;
  Completer<void>? checkGate;
  @override
  bool get isAvailable => available;
  @override
  Future<TernPatchState> readPatches() async => patches;
  @override
  Future<TernUpdateAvailability> check(TernUpdateChannel channel) async {
    checks++;
    checkedChannel = channel;
    await checkGate?.future;
    if (checkError != null) throw checkError!;
    return result;
  }

  @override
  Future<void> download(TernUpdateChannel channel) async {
    downloads++;
    downloadedChannel = channel;
    if (commitDownload) {
      patches = TernPatchState(
        current: patches.current,
        next: patches.current + 1,
      );
    }
  }

  @override
  Future<bool> canRestart() async => restartSupported;
  @override
  Future<void> restart() async {
    restarts++;
    if (restartError != null) throw restartError!;
  }
}

/// Reports native download status like the Android runtime does.
class FakeStatusDriver extends FakeDriver implements TernDownloadStatusSource {
  TernDownloadStatus status = const TernDownloadStatus();
  final _changes = StreamController<TernDownloadStatus>.broadcast(sync: true);
  void publish(TernDownloadStatus value) {
    status = value;
    _changes.add(value);
  }

  @override
  Future<void> download(TernUpdateChannel channel) async {
    await super.download(channel);
    if (commitDownload) status = const TernDownloadStatus();
  }

  @override
  Future<TernDownloadStatus> readStatus() async => status;
  @override
  Stream<TernDownloadStatus> get statusChanges => _changes.stream;
}
