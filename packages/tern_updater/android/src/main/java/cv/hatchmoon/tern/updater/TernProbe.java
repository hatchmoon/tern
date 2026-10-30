package cv.hatchmoon.tern.updater;

/** Diagnostic only: reports how Android resolves the Dart snapshot symbols in a patch library. */
final class TernProbe {
    private TernProbe() {}

    static String run(String path) {
        try {
            System.loadLibrary("tern_probe");
            return probe(path);
        } catch (Throwable error) {
            return "probe unavailable: " + error;
        }
    }

    private static native String probe(String path);
}
