package app.agentdesk.mobile;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * Capacitor.Plugins.AgentDesk (web/host.js): starts and stops the background watcher, reports its
 * state, opens the Android settings the phone needs, shows a test notification and passes taps on
 * notifications to the page ("tap" event).
 */
@CapacitorPlugin(name = "AgentDesk")
public class AgentDeskPlugin extends Plugin {
    @Override
    public void load() {
        if (getActivity() != null) deliverTap(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliverTap(intent);
    }

    private void deliverTap(Intent intent) {
        if (intent == null || !Win98Notice.ACTION_OPEN.equals(intent.getAction())) return;
        JSObject e = new JSObject();
        e.put("project", intent.getStringExtra(Win98Notice.EXTRA_PROJECT));
        e.put("todo", intent.getIntExtra(Win98Notice.EXTRA_TODO, -1));
        intent.setAction(Intent.ACTION_MAIN); // not again after a screen rotation
        notifyListeners("tap", e, true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String base = call.getString("base", "");
        String key = call.getString("key", "");
        if (base == null || key == null || key.isEmpty() || !base.matches("https?://[^/\\s]+")) {
            call.reject("Нет адреса ПК или ключа");
            return;
        }
        Context ctx = getContext();
        SharedPreferences p = WatchService.prefs(ctx);
        boolean same = base.equals(p.getString("base", "")) && key.equals(p.getString("key", ""));
        SharedPreferences.Editor ed = p.edit().putBoolean("enabled", true).putString("base", base).putString("key", key);
        if (!same) ed.putLong("after", -1); // another PC: start from its newest alert
        ed.apply();
        WatchService.start(ctx);
        call.resolve(state(ctx));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        WatchService.prefs(ctx).edit().putBoolean("enabled", false).apply();
        ctx.stopService(new Intent(ctx, WatchService.class));
        call.resolve(state(ctx));
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state(getContext()));
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean free = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        // Not exempt yet: Android's own question. Exempt: the app page (Nubia keeps autostart and "Без ограничений" there).
        if (free || !open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName())))) {
            if (!open(appDetails(ctx))) open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        open(appDetails(getContext()));
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i = Build.VERSION.SDK_INT >= 26
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName())
            : appDetails(ctx);
        if (!open(i)) open(appDetails(ctx));
        call.resolve();
    }

    /** A sample notification after a few seconds: turn the screen off and listen. */
    @PluginMethod
    public void test(PluginCall call) {
        final Context ctx = getContext().getApplicationContext();
        Integer d = call.getInt("delay", 10);
        long delay = Math.max(0, Math.min(d == null ? 10 : d, 60)) * 1000L;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                JSONObject a = new JSONObject();
                a.put("id", 999999);
                a.put("project", "");
                a.put("title", "Opus (3): переслать → Astra");
                a.put("action", "Перешлите результат агенту Astra");
                a.put("body", "Проверка: так выглядит уведомление, когда агент закончил и результат нужно переслать.");
                a.put("icon", "envelope_closed-0");
                Win98Notice.show(ctx, a, true);
            } catch (Exception ignored) {
                // nothing to show
            }
        }, delay);
        call.resolve();
    }

    private boolean open(Intent i) {
        try {
            getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }

    private static Intent appDetails(Context ctx) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
    }

    static JSObject state(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("enabled", WatchService.prefs(ctx).getBoolean("enabled", false));
        r.put("running", WatchService.running);
        r.put("lastOk", WatchService.lastOk);
        r.put("lastError", WatchService.lastError);
        r.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        r.put("unrestricted", pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        return r;
    }
}
