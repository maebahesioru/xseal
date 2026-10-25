package app.xseal;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * 既存の拡張機能と同じ core.js をヘッドレス WebView で動かす。
 * 出力を 1 バイトも変えないための層（ネイティブ移植ではなく同一コードを再利用する）。
 */
public final class CoreBridge {

    public interface Callback {
        void done(boolean ok, String value, String error);
    }

    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Callback> pending = new HashMap<>();
    private int seq = 0;
    private volatile boolean loaded = false;

    public CoreBridge(Context ctx) {
        web = new WebView(ctx.getApplicationContext());
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setBlockNetworkLoads(true);
        web.setBackgroundColor(0x00000000);
        web.addJavascriptInterface(new Bridge(), "XsealBridge");
        web.loadUrl("file:///android_asset/index.html");
    }

    public void destroy() {
        try {
            ui.post(new Runnable() {
                @Override public void run() {
                    try { web.destroy(); } catch (Throwable ignored) {}
                }
            });
        } catch (Throwable ignored) {}
    }

    public void probe(final Callback cb) { call("probe", "", cb); }

    public void seal(final String text, final Callback cb) { call("seal", text, cb); }

    public void unseal(final String text, final Callback cb) { call("unseal", text, cb); }

    public void weights(final String text, final Callback cb) { call("weights", text, cb); }

    private void call(final String fn, final String arg, final Callback cb) {
        ui.post(new Runnable() {
            @Override public void run() {
                final String id = "r" + (++seq);
                pending.put(id, cb);
                ui.postDelayed(new Runnable() {
                    @Override public void run() {
                        Callback c = pending.remove(id);
                        if (c != null) c.done(false, "", "コアが応答しません（WebView の初期化失敗）");
                    }
                }, 25000);
                String js = "window.XsealNative." + fn + "(" + JSONObject.quote(arg) + "," + JSONObject.quote(id) + ")";
                try {
                    web.evaluateJavascript(js, null);
                } catch (Throwable t) {
                    pending.remove(id);
                    cb.done(false, "", "評価エラー: " + t);
                }
            }
        });
    }

    private final class Bridge {
        @JavascriptInterface
        public void ready() {
            loaded = true;
        }

        @JavascriptInterface
        public void resolve(String id, String payload) {
            final Callback cb = pending.remove(id);
            if (cb == null) return;
            boolean ok;
            String value = "", error = "";
            try {
                JSONObject o = new JSONObject(payload);
                ok = o.optBoolean("ok", false);
                value = o.optString("value", "");
                error = o.optString("error", "");
            } catch (Exception e) {
                ok = false;
                error = "結果の解析に失敗";
            }
            final boolean fok = ok;
            final String fv = value, fe = error;
            ui.post(new Runnable() {
                @Override public void run() { cb.done(fok, fv, fe); }
            });
        }
    }
}
