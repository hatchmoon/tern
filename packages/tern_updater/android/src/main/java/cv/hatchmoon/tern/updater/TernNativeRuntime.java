package cv.hatchmoon.tern.updater;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Process;
import android.util.Base64;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.UUID;

/** Tern's Android AOT update runtime. Uses only Android and official Flutter APIs. */
public final class TernNativeRuntime {
    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static TernNativeRuntime instance;
    private final Context context;
    private final SharedPreferences state;
    private final JSONObject config;
    private final File directory;
    private volatile int running;
    private JSONObject offered;
    /** Download status published to Dart without waiting for the runtime lock. */
    public interface StatusListener { void onStatus(int available, int downloading, long received, long total); }
    private static volatile StatusListener listener;
    private volatile int availableNumber, downloadingNumber;
    private volatile long receivedBytes, totalBytes = -1;
    private long statusSentAt;

    public static synchronized TernNativeRuntime get(Context context) {
        if (instance == null) instance = new TernNativeRuntime(context.getApplicationContext());
        return instance;
    }

    private TernNativeRuntime(Context context) {
        this.context = context;
        JSONObject loaded = null;
        try (InputStream in = context.getAssets().open("flutter_assets/tern-runtime.json")) {
            loaded = new JSONObject(new String(readLimited(in, 32768), StandardCharsets.UTF_8));
        } catch (Exception error) { Log.i("TernRuntime", "No independent runtime configuration"); }
        config = loaded;
        String identity = config == null ? "unconfigured" : config.optString("app_id") + "-" + config.optString("release_version") + "-" + config.optString("engine_revision");
        // An APK update, a different release, and a different engine never share update state.
        String scope = hex(digest(identity.getBytes(StandardCharsets.UTF_8)));
        state = context.getSharedPreferences("tern-native-" + scope, Context.MODE_PRIVATE);
        directory = new File(context.getFilesDir(), "tern-runtime/" + scope);
        if (!directory.isDirectory() && !directory.mkdirs()) Log.e("TernRuntime", "Cannot create private update directory");
        if (!state.contains("client")) commit(state.edit().putString("client", UUID.randomUUID().toString()));
    }

    public boolean available() { return config != null && config.optString("runtime").equals("tern-native-v1") && Build.VERSION.SDK_INT >= 26 && (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0; }
    public int current() { return running; }
    public int next() { return state.getInt("next", 0); }
    public static synchronized void setStatusListener(StatusListener value) { listener = value; }
    public static synchronized void clearStatusListener(StatusListener value) { if (listener == value) listener = null; }
    /** Offered-but-not-staged patch, the patch being downloaded, and its byte counts; total is -1 when unknown. */
    public long[] status() { return new long[] { availableNumber, downloadingNumber, receivedBytes, totalBytes }; }

    /** Called once by the loader, before the Dart VM exists. Never fetches over the network. */
    public synchronized String selectForLaunch() {
        if (!available()) return null;
        int unfinished = state.getInt("booting", 0);
        if (unfinished > 0) {
            int good = state.getInt("good", 0);
            if (good == unfinished) good = 0;
            commit(state.edit().putBoolean("bad-" + unfinished, true).putInt("next", good).putInt("booting", 0).putInt("failed", unfinished));
            Log.w("TernRuntime", "Previous patch did not confirm its first frame; reverting patch " + unfinished);
        }
        int selected = next();
        if(state.getBoolean("bad-" + selected, false)) { commit(state.edit().putInt("next", 0)); selected=0; }
        if (selected == 0) { running = 0; return null; }
        try {
            JSONObject descriptor = new JSONObject(state.getString("descriptor-" + selected, "{}"));
            File library = library(selected);
            verify(library, descriptor);
            // On a physical Android 11 ARM device, Flutter silently ignored a patch it loaded first
            // itself, but used it when the app had already loaded it. Keep it resident for the engine.
            System.load(library.getAbsolutePath());
            commit(state.edit().putInt("booting", selected));
            running = selected;
            return library.getAbsolutePath();
        } catch (Exception | UnsatisfiedLinkError error) {
            Log.e("TernRuntime", "Rejecting stored patch " + selected, error);
            commit(state.edit().putBoolean("bad-" + selected, true).putInt("next", 0).putInt("booting", 0));
            running = 0;
            return null;
        }
    }

    /** Dart calls this only after the first frame has rendered. */
    public synchronized void markHealthy() {
        String fallback = running > 0 ? fallbackReason() : null;
        if (fallback != null) {
            // Flutter silently uses the APK's libapp.so when it cannot use the patch, so the
            // first frame alone does not prove the patch is running.
            int patch = running, good = state.getInt("good", 0);
            if (good == patch) good = 0;
            Log.e("TernRuntime", "Flutter did not run patch " + patch + " and started the original code instead: " + fallback);
            commit(state.edit().putBoolean("bad-" + patch, true).putInt("next", good).putInt("good", good).putInt("booting", 0));
            running = 0;
            event("__patch_install_failure__", patch, "Flutter ran the original code instead of the patch: " + fallback);
        }
        if (running > 0 && state.getInt("booting", 0) == running) {
            commit(state.edit().putInt("booting", 0).putInt("good", running));
            event("__patch_install__", running, "Tern native runtime rendered its first frame");
        }
        int failed=state.getInt("failed",0);
        if(failed>0) { event("__patch_install_failure__",failed,"Patch did not confirm its first frame; reverted on next launch"); commit(state.edit().putInt("failed",0)); }
    }

    static String maps = "/proc/self/maps";

    /** Null unless Flutter mapped the APK's own libapp.so, which it loads only when it cannot use the patch. */
    private String fallbackReason() {
        String name;
        try { name = "lib/" + abi() + "/libapp.so"; } catch (IOException error) { return null; }
        android.content.pm.ApplicationInfo info = context.getApplicationInfo();
        String extracted = canonical(info.nativeLibraryDir + "/libapp.so");
        java.util.Map<String, long[]> stored = new java.util.HashMap<>();
        java.util.List<String> apks = new java.util.ArrayList<>(java.util.Collections.singletonList(info.sourceDir));
        if (info.splitSourceDirs != null) apks.addAll(java.util.Arrays.asList(info.splitSourceDirs));
        for (String apk : apks) {
            long[] range = storedEntry(apk, name);
            if (range != null) stored.put(canonical(apk), range);
        }
        try (BufferedReader reader = new BufferedReader(new FileReader(maps))) {
            for (String line; (line = reader.readLine()) != null;) {
                String[] field = line.trim().split("\\s+", 6);
                if (field.length < 6) continue;
                if (field[5].equals(extracted)) return "Flutter loaded " + extracted;
                long[] range = stored.get(field[5]);
                long offset = range == null ? -1 : Long.parseLong(field[2], 16);
                if (range != null && offset >= range[0] && offset < range[1]) return "Flutter loaded " + name + " from " + new File(field[5]).getName();
            }
        } catch (IOException | RuntimeException error) {
            Log.w("TernRuntime", "Cannot confirm which Dart library is running", error);
        }
        return null;
    }

    private static String canonical(String path) {
        try { return new File(path).getCanonicalPath(); } catch (IOException error) { return path; }
    }

    /** File offsets [start, end) of an uncompressed ZIP entry, or null. */
    static long[] storedEntry(String zip, String name) {
        try (RandomAccessFile file = new RandomAccessFile(zip, "r")) {
            int tail = (int) Math.min(file.length(), 65557);
            byte[] end = new byte[tail];
            file.seek(file.length() - tail); file.readFully(end);
            java.nio.ByteBuffer e = java.nio.ByteBuffer.wrap(end).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            int eocd = -1;
            for (int p = tail - 22; p >= 0 && eocd < 0; p--) if (e.getInt(p) == 0x06054b50) eocd = p;
            if (eocd < 0) return null;
            int count = e.getShort(eocd + 10) & 0xffff;
            byte[] directory = new byte[e.getInt(eocd + 12)];
            file.seek(e.getInt(eocd + 16) & 0xffffffffL); file.readFully(directory);
            java.nio.ByteBuffer d = java.nio.ByteBuffer.wrap(directory).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            byte[] wanted = name.getBytes(StandardCharsets.UTF_8);
            for (int p = 0, i = 0; i < count && p + 46 <= directory.length; i++) {
                if (d.getInt(p) != 0x02014b50) return null;
                int length = d.getShort(p + 28) & 0xffff;
                if ((d.getShort(p + 10) & 0xffff) == 0 && java.util.Arrays.equals(java.util.Arrays.copyOfRange(directory, p + 46, p + 46 + length), wanted)) {
                    long local = d.getInt(p + 42) & 0xffffffffL, size = d.getInt(p + 20) & 0xffffffffL;
                    byte[] header = new byte[30];
                    file.seek(local); file.readFully(header);
                    java.nio.ByteBuffer h = java.nio.ByteBuffer.wrap(header).order(java.nio.ByteOrder.LITTLE_ENDIAN);
                    if (h.getInt(0) != 0x04034b50) return null;
                    long start = local + 30 + (h.getShort(26) & 0xffff) + (h.getShort(28) & 0xffff);
                    return new long[] { start, start + size };
                }
                p += 46 + length + (d.getShort(p + 30) & 0xffff) + (d.getShort(p + 32) & 0xffff);
            }
        } catch (IOException | RuntimeException error) {
            Log.w("TernRuntime", "Cannot read " + zip, error);
        }
        return null;
    }

    public synchronized void automaticUpdate() {
        if(!available()||!config.optBoolean("auto_update",true))return;
        try { String channel=config.optString("channel","stable"); if(check(channel).equals("outdated"))download(channel); }
        catch(Exception error) { Log.w("TernRuntime","Automatic update unavailable; retaining current code",error); }
    }

    public synchronized String check(String channel) throws Exception {
        if (!available()) return "unavailable";
        requireChannel(channel);
        JSONObject request = request(channel);
        request.put("runtime", "tern-native-v1");
        JSONObject response = post("/api/v1/patches/check", request);
        JSONArray revoked = response.getJSONArray("rolled_back_patch_numbers");
        SharedPreferences.Editor update = state.edit();
        for (int i = 0; i < revoked.length(); i++) {
            int number = revoked.getInt(i);
            update.putBoolean("bad-" + number, true);
            if (number == next()) update.putInt("next", 0);
            if (number == state.getInt("good", 0)) update.putInt("good", 0);
        }
        commit(update);
        offered = null;
        availableNumber = 0;
        if (response.optBoolean("patch_available")) {
            JSONObject patch = response.getJSONObject("patch");
            int number = patch.getInt("number");
            if (!state.getBoolean("bad-" + number, false) && number > 0 && number != next()) {
                if (!patch.getString("format").equals("tern-full-v1") || !patch.getString("engine_revision").equals(config.getString("engine_revision"))) throw new IOException("Incompatible Tern runtime response");
                verifySignature(patch);
                offered = patch;
                availableNumber = number;
                publishStatus(true);
                return "outdated";
            }
        }
        publishStatus(true);
        return current() != next() ? "restartRequired" : "upToDate";
    }

    public synchronized void download(String channel) throws Exception {
        if (offered == null && !check(channel).equals("outdated")) return;
        JSONObject patch = offered;
        if (patch == null) return;
        int number = patch.getInt("number");
        File destination = library(number), partial = new File(directory, "download.part");
        if (partial.exists() && !partial.delete()) throw new IOException("Cannot clear interrupted download");
        downloadingNumber = number; receivedBytes = 0; totalBytes = -1;
        publishStatus(true);
        HttpURLConnection connection = null;
        try {
            connection = open(new URL(patch.getString("download_url")));
            if (connection.getResponseCode() != 200) throw new IOException("Patch download returned " + connection.getResponseCode());
            if (connection.getContentLengthLong() > MAX_BYTES) throw new IOException("Patch exceeds 64 MiB");
            totalBytes = connection.getContentLengthLong();
            publishStatus(true);
            try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
                byte[] bytes = new byte[65536]; long size = 0; int count;
                while ((count = in.read(bytes)) != -1) {
                    size += count; if (size > MAX_BYTES) throw new IOException("Patch exceeds 64 MiB");
                    out.write(bytes, 0, count);
                    receivedBytes = size;
                    publishStatus(false);
                }
                out.getFD().sync();
            }
            verify(partial, patch);
            // Downloaded executable code is immutable before publication, including on Android 14+.
            if (!partial.setReadOnly()) throw new IOException("Cannot make patch read-only");
            if (destination.exists() && !destination.delete()) throw new IOException("Cannot replace staged patch");
            if (!partial.renameTo(destination)) throw new IOException("Cannot atomically publish patch");
            commit(state.edit().putString("descriptor-" + number, patch.toString()).putInt("next", number));
            offered = null;
            availableNumber = 0; downloadingNumber = 0;
            publishStatus(true);
            event("__patch_download__", number, "Signed Tern AOT library staged");
        } finally {
            if (connection != null) connection.disconnect();
            if (partial.exists()) partial.delete();
            downloadingNumber = 0; receivedBytes = 0; totalBytes = -1;
            publishStatus(true);
        }
    }

    /** Progress is throttled to about four updates per second; state changes are always sent. */
    private void publishStatus(boolean force) {
        StatusListener target = listener;
        if (target == null) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (!force && now - statusSentAt < 250) return;
        statusSentAt = now;
        target.onStatus(availableNumber, downloadingNumber, receivedBytes, totalBytes);
    }

    private File library(int number) { return new File(directory, "patch-" + number + ".so"); }

    private void verify(File file, JSONObject patch) throws Exception {
        verifySignature(patch);
        if (!file.isFile() || file.length() < 64 || file.length() > MAX_BYTES) throw new IOException("Invalid patch size");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = in.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        if (!hex(hash.digest()).equals(patch.getString("hash"))) throw new IOException("Patch SHA-256 does not match");
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            byte[] header = new byte[20]; in.readFully(header);
            int machine = (header[18] & 255) | ((header[19] & 255) << 8);
            int expected = arch().equals("aarch64") ? 183 : arch().equals("arm") ? 40 : 62;
            if (header[0] != 127 || header[1] != 'E' || header[2] != 'L' || header[3] != 'F' || header[5] != 1 || machine != expected) throw new IOException("Patch is not an ELF library for this process");
        }
    }

    private void verifySignature(JSONObject patch) throws Exception {
        String hash = patch.getString("hash");
        if (!hash.matches("[a-f0-9]{64}")) throw new IOException("Invalid target hash");
        String message = "tern-native-v1\n" + config.getString("app_id") + "\n" + config.getString("release_version") + "\n" + config.getString("engine_revision") + "\n" + arch() + "\n" + hash;
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.decode(config.getString("public_key"), Base64.DEFAULT))));
        signature.update(message.getBytes(StandardCharsets.UTF_8));
        if (!signature.verify(Base64.decode(patch.getString("hash_signature"), Base64.DEFAULT))) throw new IOException("Patch signature rejected");
    }

    private String abi() throws IOException {
        switch (arch()) {
            case "aarch64": return "arm64-v8a";
            case "arm": return "armeabi-v7a";
            default: return "x86_64";
        }
    }

    private String arch() throws IOException {
        for (String abi : Build.SUPPORTED_ABIS) {
            if (Process.is64Bit() && abi.equals("arm64-v8a")) return "aarch64";
            if (Process.is64Bit() && abi.equals("x86_64")) return "x86_64";
            if (!Process.is64Bit() && abi.equals("armeabi-v7a")) return "arm";
        }
        throw new IOException("Unsupported process ABI");
    }

    private JSONObject request(String channel) throws Exception {
        return new JSONObject().put("app_id", config.getString("app_id")).put("release_version", config.getString("release_version")).put("platform", "android").put("arch", arch()).put("channel", channel).put("client_id", state.getString("client", "")).put("current_patch_number", running);
    }

    private HttpURLConnection open(URL url) throws Exception {
        URL server = new URL(config.getString("base_url"));
        boolean loopback = url.getHost().equals("127.0.0.1") || url.getHost().equals("localhost") || url.getHost().equals("[::1]");
        if (!url.getProtocol().equals("https") && !(config.optBoolean("allow_local_http") && url.getProtocol().equals("http") && loopback)) throw new IOException("Tern requires HTTPS (loopback HTTP is only for local testing)");
        if (url.getUserInfo() != null || !url.getProtocol().equals(server.getProtocol()) || !url.getHost().equals(server.getHost()) || url.getPort() != server.getPort()) throw new IOException("Cross-origin patch URL rejected");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
        return connection;
    }

    private JSONObject post(String path, JSONObject payload) throws Exception {
        HttpURLConnection connection = open(new URL(config.getString("base_url") + path));
        try {
            connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) throw new IOException("Tern returned " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) { return new JSONObject(new String(readLimited(in, 131072), StandardCharsets.UTF_8)); }
        } finally { connection.disconnect(); }
    }

    private void event(String type, int number, String message) {
        if (number <= 0) return;
        try {
            JSONObject event = request(config.optString("channel", "stable"));
            event.put("type", type).put("patch_number", number).put("message", message);
            post("/api/v1/patches/events", new JSONObject().put("event", event));
        } catch (Exception error) { Log.w("TernRuntime", "Telemetry unavailable", error); }
    }

    private static void requireChannel(String channel) throws IOException {
        if (!channel.equals("stable") && !channel.equals("beta") && !channel.equals("staging")) throw new IOException("Invalid update channel");
    }
    private static void commit(SharedPreferences.Editor editor) { if (!editor.commit()) throw new IllegalStateException("Cannot persist Tern update state"); }
    private static byte[] readLimited(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) { if (out.size() + count > limit) throw new IOException("Response too large"); out.write(buffer, 0, count); }
        return out.toByteArray();
    }
    private static byte[] digest(byte[] bytes) { try { return MessageDigest.getInstance("SHA-256").digest(bytes); } catch (Exception error) { throw new IllegalStateException(error); } }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte value : bytes) result.append(String.format("%02x", value & 255)); return result.toString(); }
}
