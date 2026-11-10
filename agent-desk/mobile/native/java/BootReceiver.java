package app.agentdesk.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the background watcher again after a reboot or an app update, if it was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(a)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
            || "android.intent.action.QUICKBOOT_POWERON".equals(a);
        if (boot && WatchService.prefs(ctx).getBoolean("enabled", false)) WatchService.start(ctx);
    }
}
