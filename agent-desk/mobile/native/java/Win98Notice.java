package app.agentdesk.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.fonts.Font;
import android.graphics.fonts.FontFamily;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.util.DisplayMetrics;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Notifications that look like a Windows 98 message window: silver frame, navy title bar, 32x32
 * icon, the 98.css pixel font with our Cyrillic, drawn pixel by pixel as a picture. The sound is
 * the app's own chime (res/raw/ad_chime.wav, made by mobile/scripts/patch-android.js).
 */
final class Win98Notice {
    static final String CHANNEL = "ad.alerts.2";
    static final String WATCH_CHANNEL = "ad.watch";
    static final String ACTION_OPEN = "app.agentdesk.mobile.OPEN_ALERT";
    static final String EXTRA_PROJECT = "ad_project";
    static final String EXTRA_TODO = "ad_todo";

    private static final int SILVER = 0xFFC0C0C0, WHITE = 0xFFFFFFFF, LIGHT = 0xFFDFDFDF, GRAY = 0xFF808080;
    private static final int BLACK = 0xFF0A0A0A, TEXT = 0xFF000000, DIM = 0xFF404040, NAVY = 0xFF000080, BLUE = 0xFF1084D0;
    private static final long[] BUZZ = {0, 120, 60, 120};
    private static final String[] CROSS = {"##....##", ".##..##.", "..####..", "...##...", "..####..", ".##..##.", "##....##"};
    private static Typeface regular;
    private static Typeface bold;

    private Win98Notice() {}

    static Uri sound(Context ctx) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/ad_chime");
    }

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Что нужно сделать", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Агент закончил, ждёт ответа или пересылки. Звук как у Agent Desk на ПК.");
            ch.setSound(sound(ctx), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            ch.enableVibration(true);
            ch.setVibrationPattern(BUZZ);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(WATCH_CHANNEL) == null) {
            NotificationChannel w = new NotificationChannel(WATCH_CHANNEL, "Связь с ПК", NotificationManager.IMPORTANCE_MIN);
            w.setDescription("Тихое уведомление фоновой службы: без него Android рвёт связь с ПК при выключенном экране");
            w.setShowBadge(false);
            w.setSound(null, null);
            nm.createNotificationChannel(w);
        }
        if (nm.getNotificationChannel("todos") != null) nm.deleteNotificationChannel("todos"); // the old channel with the phone's sound
    }

    /** One alert from GET /api/alerts: {id, kind, project, title, action, body, icon, todo}. */
    static void show(Context ctx, JSONObject a, boolean loud) {
        channels(ctx);
        String title = a.optString("title", "Agent Desk");
        String action = a.optString("action", "");
        String body = a.optString("body", "");
        String project = a.isNull("project") ? "" : a.optString("project", "");
        int todo = a.isNull("todo") ? -1 : a.optInt("todo", -1);
        String icon = a.optString("icon", "");
        if (!icon.matches("[a-z0-9_]+-[0-9]")) icon = "msg_information-0";
        String line = action.isEmpty() ? body : action;
        int id = 1000 + (int) (Math.abs(a.optLong("id", 0)) % 1000000);

        Intent open = new Intent(ctx, MainActivity.class)
            .setAction(ACTION_OPEN)
            .putExtra(EXTRA_PROJECT, project)
            .putExtra(EXTRA_TODO, todo)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Painter p = new Painter(ctx);
        RemoteViews small = new RemoteViews(ctx.getPackageName(), R.layout.ad_notice);
        small.setImageViewBitmap(R.id.ad_image, p.small(title, line));
        small.setContentDescription(R.id.ad_image, title + ". " + line);
        RemoteViews big = new RemoteViews(ctx.getPackageName(), R.layout.ad_notice);
        big.setImageViewBitmap(R.id.ad_image, p.big(project, title, action, body, p.icon(icon)));
        big.setContentDescription(R.id.ad_image, title + ". " + action + " " + body);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ad_stat)
            .setColor(NAVY)
            .setContentTitle(title)
            .setContentText(line)
            .setTicker(title)
            .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(small)
            .setCustomHeadsUpContentView(small)
            .setCustomBigContentView(big)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setSound(sound(ctx)) // Android 7; from 8 on the channel has the sound
            .setVibrate(BUZZ)
            .setSilent(!loud);
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build());
        } catch (RuntimeException ignored) {
            // notifications are off for the app
        }
    }

    private static synchronized void fonts(Context ctx) {
        if (regular != null) return;
        regular = font(ctx, "w98", "ad_cyrillic", Typeface.NORMAL);
        bold = font(ctx, "w98_bold", "ad_cyrillic_bold", Typeface.BOLD);
    }

    /** The 98.css font for Latin, ours for Cyrillic (res/font, made by patch-android.js); the system font if missing. */
    private static Typeface font(Context ctx, String latin, String cyrillic, int style) {
        Resources res = ctx.getResources();
        int lat = res.getIdentifier(latin, "font", ctx.getPackageName());
        int cyr = res.getIdentifier(cyrillic, "font", ctx.getPackageName());
        try {
            if (lat != 0 && Build.VERSION.SDK_INT >= 29) {
                Typeface.CustomFallbackBuilder b = new Typeface.CustomFallbackBuilder(new FontFamily.Builder(new Font.Builder(res, lat).build()).build());
                if (cyr != 0) b.addCustomFallback(new FontFamily.Builder(new Font.Builder(res, cyr).build()).build());
                return b.setSystemFallback("sans-serif").build();
            }
            if (lat != 0 && Build.VERSION.SDK_INT >= 26) return res.getFont(lat);
        } catch (Exception e) {
            // a broken font file: the system font below
        }
        return Typeface.create(Typeface.SANS_SERIF, style);
    }

    /** Draws in Win98 pixels: one Win98 pixel is s x s screen pixels, no smoothing anywhere. */
    private static final class Painter {
        private final Context ctx;
        private final int s;
        private final int w;
        private final Paint fill = new Paint();
        private final Paint pixel = new Paint();
        private final Paint text = new Paint();

        Painter(Context ctx) {
            this.ctx = ctx;
            DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
            s = Math.max(1, Math.round(dm.density));
            int avail = Math.min(dm.widthPixels, Math.round(480 * dm.density)) - Math.round(64 * dm.density);
            w = Math.max(160, avail / s);
            fill.setAntiAlias(false);
            pixel.setAntiAlias(false);
            pixel.setFilterBitmap(false);
            text.setAntiAlias(false);
            text.setSubpixelText(false);
            text.setHinting(Paint.HINTING_OFF);
            text.setTextSize(11f * s);
            fonts(ctx);
        }

        Bitmap icon(String name) {
            try (InputStream in = ctx.getAssets().open("public/icons/" + name + ".png")) {
                return BitmapFactory.decodeStream(in);
            } catch (Exception e) {
                return null;
            }
        }

        /** Collapsed and pop-up: a small window, the alert in the title bar, what to do below. */
        Bitmap small(String title, String line) {
            int h = 40;
            Bitmap bm = Bitmap.createBitmap(w * s, h * s, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bm);
            window(c, h);
            titleBar(c, 16, title);
            text.setTypeface(regular);
            text.setColor(TEXT);
            c.drawText(fit(line, w - 14), 7 * s, 32 * s, text);
            return bm;
        }

        /** Expanded: a message box with the icon, the alert, what to do, the task text and "Открыть". */
        Bitmap big(String project, String title, String action, String body, Bitmap ico) {
            int tx = 3 + 10 + 32 + 10;
            int tw = w - tx - 13;
            text.setTypeface(bold);
            List<String> t1 = wrap(title, tw, 2);
            text.setTypeface(regular);
            List<String> t2 = wrap(action, tw, 3);
            List<String> t3 = wrap(body, tw, 3);
            int gap = t3.isEmpty() || t1.size() + t2.size() == 0 ? 0 : 5;
            int top = 3 + 18 + 10;
            int btnY = top + Math.max(32, (t1.size() + t2.size() + t3.size()) * 13 + gap) + 10;
            int h = btnY + 23 + 8 + 3;
            Bitmap bm = Bitmap.createBitmap(w * s, h * s, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bm);
            window(c, h);
            titleBar(c, 18, project.isEmpty() ? "Agent Desk" : "Agent Desk — " + project);
            if (ico != null) c.drawBitmap(ico, null, new Rect(13 * s, top * s, 45 * s, (top + 32) * s), pixel);
            int y = top;
            text.setColor(TEXT);
            text.setTypeface(bold);
            for (String l : t1) {
                c.drawText(l, tx * s, (y + 10) * s, text);
                y += 13;
            }
            text.setTypeface(regular);
            for (String l : t2) {
                c.drawText(l, tx * s, (y + 10) * s, text);
                y += 13;
            }
            y += gap;
            text.setColor(DIM);
            for (String l : t3) {
                c.drawText(l, tx * s, (y + 10) * s, text);
                y += 13;
            }
            // the default button of a Win98 message box (a tap anywhere opens the app)
            int bw = 75;
            int bx = w - 13 - bw;
            rect(c, bx, btnY, bw, 23, BLACK);
            rect(c, bx + 1, btnY + 1, bw - 2, 21, SILVER);
            bevel(c, bx + 1, btnY + 1, bw - 2, 21, WHITE, BLACK, LIGHT, GRAY);
            text.setColor(TEXT);
            String label = "Открыть";
            c.drawText(label, (bx + Math.round((bw - width(label)) / 2f)) * s, (btnY + 16) * s, text);
            return bm;
        }

        private void window(Canvas c, int h) {
            rect(c, 0, 0, w, h, SILVER);
            bevel(c, 0, 0, w, h, LIGHT, BLACK, WHITE, GRAY);
        }

        private void titleBar(Canvas c, int bh, String title) {
            int x = 3, y = 3, bw = w - 6;
            fill.setShader(new LinearGradient(x * s, 0, (x + bw) * s, 0, NAVY, BLUE, Shader.TileMode.CLAMP));
            c.drawRect(x * s, y * s, (x + bw) * s, (y + bh) * s, fill);
            fill.setShader(null);
            int bx = x + bw - 2 - 16;
            int by = y + (bh - 14) / 2;
            rect(c, bx, by, 16, 14, SILVER);
            bevel(c, bx, by, 16, 14, WHITE, BLACK, LIGHT, GRAY);
            for (int r = 0; r < CROSS.length; r++) {
                for (int k = 0; k < 8; k++) if (CROSS[r].charAt(k) == '#') rect(c, bx + 4 + k, by + 3 + r, 1, 1, TEXT);
            }
            text.setTypeface(bold);
            text.setColor(WHITE);
            c.drawText(fit(title, bx - 4 - (x + 3)), (x + 3) * s, (y + (bh - 14) / 2 + 11) * s, text);
        }

        private void rect(Canvas c, int x, int y, int rw, int rh, int color) {
            fill.setShader(null);
            fill.setColor(color);
            c.drawRect(x * s, y * s, (x + rw) * s, (y + rh) * s, fill);
        }

        /** 98.css bevel "inset -1px -1px br1, inset 1px 1px tl1, inset -2px -2px br2, inset 2px 2px tl2": the first on top. */
        private void bevel(Canvas c, int x, int y, int bw, int bh, int tl1, int br1, int tl2, int br2) {
            rect(c, x, y, bw, 2, tl2);
            rect(c, x, y, 2, bh, tl2);
            rect(c, x, y + bh - 2, bw, 2, br2);
            rect(c, x + bw - 2, y, 2, bh, br2);
            rect(c, x, y, bw, 1, tl1);
            rect(c, x, y, 1, bh, tl1);
            rect(c, x, y + bh - 1, bw, 1, br1);
            rect(c, x + bw - 1, y, 1, bh, br1);
        }

        private float width(String t) {
            return text.measureText(t) / s;
        }

        private String fit(String t, int max) {
            if (width(t) <= max) return t;
            int n = t.length();
            while (n > 0 && width(t.substring(0, n).trim() + "…") > max) n--;
            return t.substring(0, n).trim() + "…";
        }

        private List<String> wrap(String t, int max, int lines) {
            List<String> out = new ArrayList<>();
            String rest = t == null ? "" : t.replaceAll("\\s+", " ").trim();
            while (!rest.isEmpty() && out.size() < lines) {
                if (width(rest) <= max || out.size() == lines - 1) {
                    out.add(fit(rest, max));
                    break;
                }
                int cut = rest.length();
                while (cut > 1 && width(rest.substring(0, cut)) > max) cut--;
                int sp = rest.lastIndexOf(' ', cut);
                if (sp > 0) cut = sp;
                out.add(rest.substring(0, cut).trim());
                rest = rest.substring(cut).trim();
            }
            return out;
        }
    }
}
