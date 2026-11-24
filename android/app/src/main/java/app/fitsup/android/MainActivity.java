package app.fitsup.android;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.Collections;

/**
 * App FitSup per Android: mostra il sito FitSup (sempre aggiornato) dentro una WebView
 * e aggiunge quello che il browser non sa fare: notifica a fine recupero, timer tra le
 * notifiche, promemoria con l'app chiusa, salvataggio dei file.
 *
 * Il sito parla con l'app come con quella per iPhone: window.webkit.messageHandlers.fitsup.postMessage(...).
 * Qui quel ponte viene creato da SHIM e porta i messaggi a {@link Bridge#post(String)}.
 */
public class MainActivity extends Activity {
    static final String SITE = "https://fitme-2e0.pages.dev/";
    private static final String HOST = "fitme-2e0.pages.dev";
    private static final int REQ_FILE = 1, REQ_NOTIF = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCb;

    /** Ponte uguale a quello dell'iPhone + download dei file creati dal sito (blob:). */
    private static final String SHIM =
        "(function(){if(window.__fitsupAndroid)return;window.__fitsupAndroid=1;"
      + "window.webkit=window.webkit||{};window.webkit.messageHandlers=window.webkit.messageHandlers||{};"
      + "window.webkit.messageHandlers.fitsup={postMessage:function(o){FitSupAndroid.post(JSON.stringify(o))}};"
      + "var rv=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=function(u){setTimeout(function(){rv(u)},60000)};"
      + "var ck=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){"
      + "var h=this.href||'';if(this.download&&(h.indexOf('blob:')==0||h.indexOf('data:')==0)){var n=this.download;"
      + "fetch(h).then(function(r){return r.blob()}).then(function(b){var f=new FileReader();"
      + "f.onload=function(){FitSupAndroid.saveFile(n,b.type||'application/octet-stream',String(f.result))};f.readAsDataURL(b)});return}"
      + "return ck.apply(this,arguments)}})();";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Notify.channels(this);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1417);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // il bip a fine recupero
        s.setSupportMultipleWindows(false);           // window.open apre nella stessa vista, poi lo mandiamo fuori
        s.setAllowFileAccess(false);
        web.addJavascriptInterface(new Bridge(), "FitSupAndroid");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, SHIM, Collections.singleton("https://" + HOST));
        }

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sc = u.getScheme() == null ? "" : u.getScheme();
                if ((sc.equals("https") || sc.equals("http")) && HOST.equals(u.getHost())) return false;
                if (sc.equals("blob") || sc.equals("data") || sc.equals("about")) return false;
                openOutside(u); // WhatsApp, YouTube, immagini su Google…
                return true;
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) v.evaluateJavascript(SHIM, null);
            }
            @Override public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(SHIM, null); // per sicurezza: lo shim non si installa due volte
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "Scegli un file"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCb = null; return false; }
                return true;
            }
        });
        web.setDownloadListener((url, ua, cd, mime, len) -> openOutside(Uri.parse(url)));

        // Barre di sistema e tastiera: la pagina non ci finisce sotto.
        web.setOnApplyWindowInsetsListener((v, ins) -> {
            Insets b = Build.VERSION.SDK_INT >= 30
                ? ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime())
                : Insets.of(ins.getSystemWindowInsetLeft(), ins.getSystemWindowInsetTop(), ins.getSystemWindowInsetRight(), ins.getSystemWindowInsetBottom());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(web);

        if (saved != null) web.restoreState(saved); else web.loadUrl(SITE);
        askNotifications(); // subito all'apertura: se lo chiediamo al primo recupero, quel timer si perde
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE && fileCb != null) {
            Uri u = (res == RESULT_OK && data != null) ? data.getData() : null;
            fileCb.onReceiveValue(u == null ? null : new Uri[]{u});
            fileCb = null;
        }
    }

    private void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (ActivityNotFoundException ignored) { }
    }

    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    /** Messaggi dal sito. I metodi girano su un thread della WebView, non su quello dell'interfaccia. */
    final class Bridge {
        @JavascriptInterface public void post(String json) {
            try {
                JSONObject o = new JSONObject(json);
                String type = o.optString("type");
                switch (type) {
                    case "rest": {
                        double secs = o.optDouble("seconds", 0);
                        if (secs <= 0) return;
                        runOnUiThread(MainActivity.this::askNotifications);
                        String ex = o.optString("exercise", "");
                        Notify.startRest(MainActivity.this, (long) (secs * 1000),
                            o.optString("title", "Recupero finito"), o.optString("body", "Vai con la prossima serie."),
                            ex.isEmpty() ? "Prossima serie" : ex);
                        break;
                    }
                    case "restCancel":
                        Notify.cancelRest(MainActivity.this);
                        break;
                    case "schedule": {
                        boolean on = o.optBoolean("enabled", false);
                        JSONArray items = on ? o.optJSONArray("items") : new JSONArray();
                        if (on) runOnUiThread(MainActivity.this::askNotifications);
                        Notify.saveReminders(MainActivity.this, items == null ? new JSONArray() : items);
                        Notify.scheduleReminders(MainActivity.this);
                        break;
                    }
                }
            } catch (Exception ignored) { }
        }

        /** File creato dal sito (backup, scheda, calendario): si salva e si apre «Condividi». */
        @JavascriptInterface public void saveFile(String name, String mime, String dataUrl) {
            try {
                int c = dataUrl.indexOf(',');
                byte[] bytes = Base64.decode(dataUrl.substring(c + 1), Base64.DEFAULT);
                File dir = new File(getCacheDir(), "shared");
                dir.mkdirs();
                File f = new File(dir, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                Uri u = FileProvider.getUriForFile(MainActivity.this, "app.fitsup.android.files", f);
                Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, u)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, name)));
            } catch (Exception ignored) { }
        }
    }
}
