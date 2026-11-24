package app.fitsup.android;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/** Notifiche di FitSup: timer di recupero, fine recupero e promemoria settimanali. */
final class Notify {
    static final String CH_LIVE = "rest_timer", CH_END = "rest_end", CH_REM = "reminders";
    static final int ID_LIVE = 1, ID_END = 2, ID_REM = 100;
    static final String ACT_END = "app.fitsup.android.REST_END", ACT_REM = "app.fitsup.android.REMINDER";
    private static final String PREFS = "fitsup";

    private Notify() {}

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        // Importanza normale ma muta: con «bassa» Android la nasconde tra le silenziose e non la mostra sul blocco schermo.
        nm.deleteNotificationChannel("rest_live");
        NotificationChannel live = new NotificationChannel(CH_LIVE, "Recupero in corso", NotificationManager.IMPORTANCE_DEFAULT);
        live.setDescription("Il conto alla rovescia del recupero, fisso tra le notifiche e sul blocco schermo.");
        live.setSound(null, null);
        live.enableVibration(false);
        live.setShowBadge(false);
        live.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel end = new NotificationChannel(CH_END, "Fine recupero", NotificationManager.IMPORTANCE_HIGH);
        end.setDescription("Suona quando il recupero è finito.");
        end.enableVibration(true);
        NotificationChannel rem = new NotificationChannel(CH_REM, "Promemoria allenamento", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(live);
        nm.createNotificationChannel(end);
        nm.createNotificationChannel(rem);
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent endIntent(Context c, String title, String body) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction(ACT_END).putExtra("title", title).putExtra("body", body);
        return PendingIntent.getBroadcast(c, ID_END, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Equivalente della Live Activity: notifica fissa con il conto alla rovescia, più l'allarme di fine. */
    static void startRest(Context c, long ms, String title, String body, String exercise) {
        long end = System.currentTimeMillis() + ms;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.cancel(ID_END);
        Notification.Builder b = new Notification.Builder(c, CH_LIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Recupero · " + exercise)
            .setContentText("Poi la prossima serie")
            .setWhen(end)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_STOPWATCH)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setColor(0xFF2BB673)
            .setTimeoutAfter(ms)
            .setContentIntent(openApp(c));
        if (Build.VERSION.SDK_INT >= 24) b.setChronometerCountDown(true);
        // Android 16: «Live Update», il timer compare come pillola nella barra di stato (come la Live Activity).
        android.os.Bundle ex = new android.os.Bundle();
        ex.putBoolean("android.requestPromotedOngoing", true);
        b.addExtras(ex);
        try { nm.notify(ID_LIVE, b.build()); } catch (SecurityException ignored) { }

        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = endIntent(c, title, body);
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, end, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, end, pi);
    }

    static void cancelRest(Context c) {
        c.getSystemService(AlarmManager.class).cancel(endIntent(c, "", ""));
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.cancel(ID_LIVE);
    }

    static void showEnd(Context c, String title, String body) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.cancel(ID_LIVE);
        Notification n = new Notification.Builder(c, CH_END)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title == null ? "Recupero finito" : title)
            .setContentText(body == null ? "Vai con la prossima serie." : body)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(openApp(c))
            .build();
        try { nm.notify(ID_END, n); } catch (SecurityException ignored) { }
    }

    // ---- Promemoria settimanali (weekday: 1 = domenica … 7 = sabato, come Calendar) ----

    static void saveReminders(Context c, JSONArray items) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int old = p.getInt("remCount", 0);
        AlarmManager am = c.getSystemService(AlarmManager.class);
        for (int i = 0; i < old; i++) am.cancel(remIntent(c, i, null));
        p.edit().putString("rem", items.toString()).putInt("remCount", items.length()).apply();
    }

    private static PendingIntent remIntent(Context c, int i, JSONObject it) {
        Intent in = new Intent(c, AlarmReceiver.class).setAction(ACT_REM).putExtra("i", i);
        if (it != null) in.putExtra("title", it.optString("title", "FitSup")).putExtra("body", it.optString("body", "È l'ora dell'allenamento."));
        return PendingIntent.getBroadcast(c, ID_REM + i, in, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void scheduleReminders(Context c) {
        try {
            JSONArray items = new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("rem", "[]"));
            for (int i = 0; i < items.length(); i++) scheduleOne(c, i, items.getJSONObject(i));
        } catch (Exception ignored) { }
    }

    /** Prossima occorrenza del promemoria i; quando suona, AlarmReceiver lo riprogramma per la settimana dopo. */
    static void scheduleOne(Context c, int i, JSONObject it) {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.DAY_OF_WEEK, it.optInt("weekday", 2));
        cal.set(Calendar.HOUR_OF_DAY, it.optInt("hour", 18));
        cal.set(Calendar.MINUTE, it.optInt("minute", 0));
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        while (cal.getTimeInMillis() <= System.currentTimeMillis()) cal.add(Calendar.WEEK_OF_YEAR, 1);
        AlarmManager am = c.getSystemService(AlarmManager.class);
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), remIntent(c, i, it));
    }

    static void showReminder(Context c, int i, String title, String body) {
        Notification n = new Notification.Builder(c, CH_REM)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(openApp(c))
            .build();
        try { c.getSystemService(NotificationManager.class).notify(ID_REM + i, n); } catch (SecurityException ignored) { }
        try {
            JSONArray items = new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("rem", "[]"));
            if (i < items.length()) scheduleOne(c, i, items.getJSONObject(i));
        } catch (Exception ignored) { }
    }
}
