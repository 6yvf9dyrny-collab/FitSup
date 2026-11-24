package app.fitsup.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Suona a fine recupero e all'ora dei promemoria, anche con l'app chiusa. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        Notify.channels(c);
        if (Notify.ACT_END.equals(i.getAction())) Notify.showEnd(c, i.getStringExtra("title"), i.getStringExtra("body"));
        else if (Notify.ACT_REM.equals(i.getAction()))
            Notify.showReminder(c, i.getIntExtra("i", 0), i.getStringExtra("title"), i.getStringExtra("body"));
    }
}
