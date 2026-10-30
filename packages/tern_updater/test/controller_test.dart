import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:tern_updater/tern_updater.dart';
import 'fakes.dart';

void main() {
  test('unavailable runtime does not check or download', () async {
    final driver = FakeDriver()..available = false;
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    expect(controller.state.phase, TernUpdatePhase.unavailable);
    expect(driver.checks, 0);
    expect(driver.downloads, 0);
  });
  test(
    'stages the selected channel without automatically restarting',
    () async {
      final driver = FakeDriver()..result = TernUpdateAvailability.outdated;
      final controller = TernUpdateController(
        driver: driver,
        channel: TernUpdateChannel.beta,
      );
      addTearDown(controller.dispose);
      final phases = <TernUpdatePhase>[];
      controller.addListener(() => phases.add(controller.state.phase));
      await controller.checkForUpdates();
      expect(
        phases,
        containsAllInOrder([
          TernUpdatePhase.checking,
          TernUpdatePhase.downloading,
          TernUpdatePhase.restartRequired,
        ]),
      );
      expect(driver.checkedChannel, TernUpdateChannel.beta);
      expect(driver.downloadedChannel, TernUpdateChannel.beta);
      expect(driver.restarts, 0);
      expect(controller.state.nextPatch, 1);
    },
  );
  test('waits for a committed patch before announcing restart', () async {
    final driver =
        FakeDriver()
          ..result = TernUpdateAvailability.outdated
          ..commitDownload = false;
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    expect(controller.state.restartRequired, false);
    driver.patches = const TernPatchState(next: 1);
    await controller.checkForUpdates(force: false);
    expect(controller.state.restartRequired, true);
    expect(driver.checks, 1);
  });
  test('coalesces checks and supports rollback to the original', () async {
    final driver =
        FakeDriver()
          ..checkGate = Completer<void>()
          ..patches = const TernPatchState(current: 3, next: 0);
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    final first = controller.checkForUpdates(),
        second = controller.checkForUpdates();
    expect(driver.checks, 1);
    driver.checkGate!.complete();
    await Future.wait([first, second]);
    expect(controller.state.restartRequired, true);
    expect(controller.state.nextPatch, 0);
  });
  test(
    'Later retains the staged patch and a different patch shows again',
    () async {
      final driver = FakeDriver()..patches = const TernPatchState(next: 1);
      final controller = TernUpdateController(driver: driver);
      addTearDown(controller.dispose);
      await controller.checkForUpdates();
      controller.dismiss();
      await controller.checkForUpdates(force: false);
      expect(controller.state.dismissed, true);
      expect(driver.patches.next, 1);
      expect(driver.restarts, 0);
      driver.patches = const TernPatchState(next: 2);
      await controller.checkForUpdates(force: false);
      expect(controller.state.dismissed, false);
    },
  );
  test('network failure keeps an already downloaded patch available', () async {
    final driver =
        FakeDriver()
          ..patches = const TernPatchState(next: 2)
          ..checkError = Exception('offline');
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    expect(controller.state.restartRequired, true);
    expect(controller.state.error, isNotNull);
  });
  test(
    'restart rechecks readiness and restores state after native failure',
    () async {
      final driver =
          FakeDriver()
            ..patches = const TernPatchState(next: 1)
            ..restartError = Exception('no activity');
      final controller = TernUpdateController(driver: driver);
      addTearDown(controller.dispose);
      await controller.checkForUpdates();
      await expectLater(controller.restart(), throwsException);
      expect(controller.state.phase, TernUpdatePhase.restartRequired);
      expect(controller.state.error, isNotNull);
      driver.patches = const TernPatchState();
      await expectLater(controller.restart(), throwsStateError);
      expect(driver.restarts, 1);
    },
  );
  test('disposal during a check prevents a late download', () async {
    final driver =
        FakeDriver()
          ..result = TernUpdateAvailability.outdated
          ..checkGate = Completer<void>();
    final controller = TernUpdateController(driver: driver);
    final operation = controller.checkForUpdates();
    controller.dispose();
    driver.checkGate!.complete();
    await operation;
    expect(driver.downloads, 0);
    expect(driver.restarts, 0);
  });
  test('without automatic download a found patch waits as available', () async {
    final driver =
        FakeStatusDriver()
          ..result = TernUpdateAvailability.outdated
          ..status = const TernDownloadStatus(availablePatch: 1);
    final controller = TernUpdateController(
      driver: driver,
      autoDownload: false,
    );
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    expect(controller.state.phase, TernUpdatePhase.available);
    expect(controller.state.availablePatch, 1);
    expect(driver.downloads, 0);
    await controller.downloadUpdate();
    expect(driver.downloads, 1);
    expect(controller.state.phase, TernUpdatePhase.restartRequired);
    expect(controller.state.availablePatch, 0);
  });
  test('available state also works for drivers without status', () async {
    final driver = FakeDriver()..result = TernUpdateAvailability.outdated;
    final controller = TernUpdateController(
      driver: driver,
      autoDownload: false,
    );
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    expect(controller.state.phase, TernUpdatePhase.available);
    expect(driver.downloads, 0);
  });
  test('reports progress of a download the native runtime started', () async {
    final driver = FakeStatusDriver();
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.start();
    expect(controller.state.phase, TernUpdatePhase.upToDate);
    driver.publish(
      const TernDownloadStatus(
        availablePatch: 1,
        downloadingPatch: 1,
        receivedBytes: 50,
        totalBytes: 200,
      ),
    );
    expect(controller.state.phase, TernUpdatePhase.downloading);
    expect(controller.state.downloadingPatch, 1);
    expect(controller.state.downloadProgress, 0.25);
    await expectLater(controller.restart(), throwsStateError);
    driver.patches = const TernPatchState(next: 1);
    driver.publish(const TernDownloadStatus());
    await pumpEventQueue();
    expect(controller.state.phase, TernUpdatePhase.restartRequired);
    expect(controller.state.downloadProgress, isNull);
    expect(driver.checks, 1);
  });
  test('reading state during a native download keeps it downloading', () async {
    final driver =
        FakeStatusDriver()
          ..patches = const TernPatchState(next: 1)
          ..status = const TernDownloadStatus(downloadingPatch: 2);
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.checkForUpdates(force: false);
    expect(controller.state.phase, TernUpdatePhase.downloading);
    expect(controller.state.downloadProgress, isNull);
    expect(controller.state.restartRequired, true);
  });
  test('Later hides an available patch until a different one', () async {
    final driver =
        FakeStatusDriver()
          ..result = TernUpdateAvailability.outdated
          ..status = const TernDownloadStatus(availablePatch: 1);
    final controller = TernUpdateController(
      driver: driver,
      autoDownload: false,
    );
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    controller.dismiss();
    expect(controller.state.dismissed, true);
    await controller.checkForUpdates();
    expect(controller.state.dismissed, true);
    driver.status = const TernDownloadStatus(availablePatch: 2);
    await controller.checkForUpdates();
    expect(controller.state.dismissed, false);
  });
}
