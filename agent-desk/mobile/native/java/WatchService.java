package app.agentdesk.mobile;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Background watcher. Keeps one request to the PC open: GET /api/alerts waits up to 25 s for the
 * next alert, so a Win98 notification arrives within a second, also with the screen off. As a
 * foreground service it keeps network access and its wake lock in Doze; the quiet notification
 * "Связь с ПК" is what Android asks in return. (JavaScript in the page is frozen with the screen off.)
 */
public class WatchService extends Service {
    static final int WATCH_ID = 1;
    static volatile boolean running = false;
    static volatile boolean appVisible = false;
    static volatile long lastOk = 0;
    static volatile String lastError = null;

    private Thread worker;
    private volatile boolean alive = false;
    private volatile String target = "";
    private volatile HttpURLConnection current;
    private volatile boolean online = false;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("agentdesk.watch", Context.MODE_PRIVATE);
    }

    static void start(Context ctx) {
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, WatchService.class));
        } catch (RuntimeException e) { // Android 12+: no foreground service start from the background
            lastError = "Android не дал запуститься в фоне: откройте Agent Desk";
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = prefs(this);
        if (!p.getBoolean("enabled", false) || p.getString("base", "").isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Win98Notice.channels(this);
        try {
            Notification n = watchNotification();
            if (Build.VERSION.SDK_INT >= 34) startForeground(WATCH_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(WATCH_ID, n);
        } catch (RuntimeException e) {
            lastError = "Android не дал запустить фоновую службу (" + e.getClass().getSimpleName() + ")";
            stopSelf();
            return START_NOT_STICKY;
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentDesk:watch");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "AgentDesk:watch");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
        if (worker == null || !worker.isAlive()) {
            alive = true;
            running = true;
            worker = new Thread(this::loop, "agent-desk-watch");
            worker.start();
        } else if (!(p.getString("base", "") + " " + p.getString("key", "")).equals(target)) {
            worker.interrupt(); // another PC or key: drop the old request at once
            HttpURLConnection c = current;
            if (c != null) new Thread(c::disconnect).start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        alive = false;
        running = false;
        if (worker != null) worker.interrupt();
        HttpURLConnection c = current;
        if (c != null) new Thread(c::disconnect).start(); // may wait for the network: not on the main thread
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    private void loop() {
        SharedPreferences p = prefs(this);
        long backoff = 2000;
        while (alive) {
            String base = p.getString("base", "");
            String key = p.getString("key", "");
            long after = p.getLong("after", -1);
            target = base + " " + key;
            HttpURLConnection c = null;
            try {
                URL url = new URL(base + "/api/alerts?" + (after >= 0 ? "after=" + after + "&" : "") + "wait=25");
                c = (HttpURLConnection) url.openConnection();
                current = c;
                c.setConnectTimeout(8000);
                c.setReadTimeout(40000);
                c.setUseCaches(false);
                c.setRequestProperty("X-Agent-Desk-Key", key);
                c.setRequestProperty("Accept", "application/json");
                int code = c.getResponseCode();
                if (code == 403) throw new IllegalStateException("ПК не принял ключ: подключите телефон заново");
                if (code != 200) throw new IllegalStateException("ПК ответил " + code);
                JSONObject j = new JSONObject(read(c.getInputStream()));
                long seq = j.getLong("seq");
                JSONArray list = j.getJSONArray("alerts");
                if (after >= 0 && !appVisible) { // in the app the page shows its own toasts
                    int last = list.length() - 1;
                    for (int i = Math.max(0, last - 4); i <= last; i++) Win98Notice.show(this, list.getJSONObject(i), i == last);
                }
                if ((p.getString("base", "") + " " + p.getString("key", "")).equals(base + " " + key)) {
                    p.edit().putLong("after", seq).apply();
                }
                lastOk = System.currentTimeMillis();
                lastError = null;
                backoff = 2000;
                setOnline(true);
            } catch (Exception e) {
                if (!alive) break;
                lastError = e instanceof IllegalStateException ? e.getMessage() : "нет связи с ПК (" + e.getClass().getSimpleName() + ")";
                setOnline(false);
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException wake) {
                    if (!alive) break; // otherwise another PC or key: try at once
                }
                backoff = Math.min(backoff * 2, 60000);
            } finally {
                current = null;
                if (c != null) c.disconnect();
            }
        }
    }

    private void setOnline(boolean now) {
        if (now == online) return;
        online = now;
        try {
            NotificationManagerCompat.from(this).notify(WATCH_ID, watchNotification());
        } catch (RuntimeException ignored) {
            // no notification permission: the service works anyway
        }
    }

    private Notification watchNotification() {
        Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String err = lastError;
        return new NotificationCompat.Builder(this, Win98Notice.WATCH_CHANNEL)
            .setSmallIcon(R.drawable.ad_stat)
            .setColor(0xFF000080)
            .setContentTitle(online ? "На связи с ПК" : "Жду ПК…")
            .setContentText(online ? "Уведомления придут и с выключенным экраном" : err != null ? err : "ПК должен быть включён и в той же Wi-Fi сети")
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pi)
            .build();
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
