import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tern_updater/tern_updater.dart';
import 'fakes.dart';

void main() {
  Future<TernUpdateController> ready(FakeDriver driver) async {
    final controller = TernUpdateController(driver: driver);
    addTearDown(controller.dispose);
    await controller.checkForUpdates();
    return controller;
  }

  Widget app(
    TernUpdateController controller, {
    Future<bool> Function()? guard,
  }) => MaterialApp(
    home: Scaffold(
      body: Column(
        children: [
          TernUpdateBanner(controller: controller, beforeRestart: guard),
          const TextField(
            decoration: InputDecoration(labelText: 'Order notes'),
          ),
        ],
      ),
    ),
  );
  testWidgets('Later preserves staged update and unfinished form', (
    tester,
  ) async {
    final driver = FakeDriver();
    final controller = await ready(driver);
    await tester.pumpWidget(app(controller));
    expect(find.text('Update ready'), findsNothing);
    await tester.enterText(find.byType(TextField), 'unfinished order');
    driver.patches = const TernPatchState(next: 1);
    await controller.checkForUpdates();
    await tester.pump();
    expect(find.text('Update ready'), findsOneWidget);
    await tester.tap(find.text('Later'));
    await tester.pump();
    expect(find.text('Update ready'), findsNothing);
    expect(find.text('unfinished order'), findsOneWidget);
    expect(driver.restarts, 0);
  });
  testWidgets('Cancel and unsaved-work guard prevent restart', (tester) async {
    final driver = FakeDriver()..patches = const TernPatchState(next: 1);
    final controller = await ready(driver);
    await tester.pumpWidget(app(controller));
    await tester.tap(find.text('Restart now'));
    await tester.pumpAndSettle();
    expect(find.text('Restart app?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(driver.restarts, 0);
    await tester.pumpWidget(app(controller, guard: () async => false));
    await tester.tap(find.text('Restart now'));
    await tester.pumpAndSettle();
    expect(find.text('Restart app?'), findsNothing);
    expect(driver.restarts, 0);
  });
  testWidgets('confirmation invokes native restart once', (tester) async {
    final driver = FakeDriver()..patches = const TernPatchState(next: 1);
    final controller = await ready(driver);
    await tester.pumpWidget(app(controller));
    await tester.tap(find.text('Restart now'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Restart'));
    await tester.pumpAndSettle();
    expect(driver.restarts, 1);
    expect(find.text('Restarting…'), findsOneWidget);
  });
  testWidgets('missing native helper offers manual instructions', (
    tester,
  ) async {
    final driver =
        FakeDriver()
          ..patches = const TernPatchState(next: 1)
          ..restartSupported = false;
    final controller = await ready(driver);
    await tester.pumpWidget(app(controller));
    expect(find.text('Restart now'), findsNothing);
    expect(find.textContaining('Close the app completely'), findsOneWidget);
  });
  testWidgets('fits a narrow screen with large accessible text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final driver = FakeDriver()..patches = const TernPatchState(next: 1);
    final controller = await ready(driver);
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(320, 800),
            textScaler: TextScaler.linear(1.8),
          ),
          child: Scaffold(body: TernUpdateBanner(controller: controller)),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Restart now'), findsOneWidget);
  });
}
