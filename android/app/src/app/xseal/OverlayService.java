package app.xseal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** 画面上に常駐するボタン（オーバーレイ）。押すとパネルが出て封印/復号できる。 */
public final class OverlayService extends Service {

    public static final String CH_ID = "xseal";
    public static final int NOTI_ID = 1001;

    private WindowManager wm;
    private CoreBridge core;
    private View bubble;
    private View panel;
    private TextView status;
    private WindowManager.LayoutParams lpBubble, lpPanel;

    private float touchX, touchY;
    private int startX, startY;
    private boolean moved;
    private long downAt;
    private boolean busy;

    @Override public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        core = new CoreBridge(this);
        startForegroundSafe();
        addBubble();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        try { if (panel != null) wm.removeView(panel); } catch (Throwable ignored) {}
        try { if (bubble != null) wm.removeView(bubble); } catch (Throwable ignored) {}
        if (core != null) core.destroy();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void startForegroundSafe() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_ID, "xseal", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class),
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        b.setContentTitle("xseal 稼働中")
                .setContentText("画面のボタンから封印/復号できます")
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true);
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTI_ID, n);
            }
        } catch (Throwable t) {
            try { startForeground(NOTI_ID, n); } catch (Throwable ignored) {}
        }
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void addBubble() {
        TextView v = new TextView(this);
        v.setText("xo");
        v.setTextColor(Color.WHITE);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        v.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(0xFF1D9BF0);
        g.setStroke(dp(1), 0x66000000);
        v.setBackground(g);
        v.setElevation(dp(6));

        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        lpBubble = new WindowManager.LayoutParams(dp(54), dp(54),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, flags, PixelFormat.TRANSLUCENT);
        lpBubble.gravity = Gravity.TOP | Gravity.START;

        SharedPreferences sp = getSharedPreferences("xseal", MODE_PRIVATE);
        lpBubble.x = sp.getInt("bx", dp(12));
        lpBubble.y = sp.getInt("by", dp(240));

        v.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View view, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        touchX = e.getRawX();
                        touchY = e.getRawY();
                        startX = lpBubble.x;
                        startY = lpBubble.y;
                        moved = false;
                        downAt = System.currentTimeMillis();
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (e.getRawX() - touchX);
                        int dy = (int) (e.getRawY() - touchY);
                        if (Math.abs(dx) + Math.abs(dy) > dp(6)) moved = true;
                        lpBubble.x = startX + dx;
                        lpBubble.y = startY + dy;
                        try { wm.updateViewLayout(bubble, lpBubble); } catch (Throwable ignored) {}
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        getSharedPreferences("xseal", MODE_PRIVATE).edit()
                                .putInt("bx", lpBubble.x).putInt("by", lpBubble.y).apply();
                        if (!moved && System.currentTimeMillis() - downAt < 700) togglePanel();
                        return true;
                    default:
                        return false;
                }
            }
        });
        bubble = v;
        try { wm.addView(bubble, lpBubble); } catch (Throwable t) { toast("オーバーレイを出せません: " + t); }
    }

    private void togglePanel() {
        if (panel != null) { closePanel(); return; }
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(14));
        g.setColor(0xF00B0D0F);
        g.setStroke(dp(1), 0x552F8FD8);
        box.setBackground(g);
        box.setElevation(dp(10));

        TextView title = new TextView(this);
        title.setText("xseal  —  投稿欄に直接入れる");
        title.setTextColor(0xFFE7E9EA);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(10), 0, dp(6));
        Button sealBtn = mkBtn("封印");
        Button unsealBtn = mkBtn("復号");
        Button closeBtn = mkBtn("閉じる");
        row.addView(sealBtn);
        row.addView(unsealBtn);
        row.addView(closeBtn);
        box.addView(row);

        status = new TextView(this);
        status.setTextColor(0xFF9AA4AE);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        status.setPadding(0, dp(4), 0, 0);
        status.setText(XsealA11y.available()
                ? "準備OK。X の投稿欄をタップしてから封印を押す"
                : "アクセシビリティが未許可。コピー経由で動きます");
        box.addView(status);

        sealBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doSeal(); }
        });
        unsealBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doUnseal(); }
        });
        closeBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { closePanel(); }
        });

        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lpPanel = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, flags, PixelFormat.TRANSLUCENT);
        lpPanel.gravity = Gravity.CENTER;
        lpPanel.width = dp(300);

        panel = box;
        try { wm.addView(panel, lpPanel); } catch (Throwable t) { toast("パネルを出せません: " + t); }
    }

    private Button mkBtn(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setTextColor(0xFFE7E9EA);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(9));
        g.setColor(0xFF1D2B36);
        g.setStroke(dp(1), 0x552F8FD8);
        b.setBackground(g);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(40), 1f);
        lp.setMargins(dp(3), 0, dp(3), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private void closePanel() {
        try { if (panel != null) wm.removeView(panel); } catch (Throwable ignored) {}
        panel = null;
        status = null;
    }

    private void say(String s) {
        if (status != null) status.setText(s);
        else toast(s);
    }

    private void toast(String s) {
        try { Toast.makeText(getApplicationContext(), s, Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {}
    }

    private void copy(String s) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("xseal", s));
        } catch (Throwable ignored) {}
    }

    private String paste() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData c = cm.getPrimaryClip();
            if (c == null || c.getItemCount() == 0) return null;
            CharSequence t = c.getItemAt(0).coerceToText(this);
            return t == null ? null : t.toString();
        } catch (Throwable t) { return null; }
    }

    private void doSeal() {
        if (busy) return;
        String direct = XsealA11y.available() ? XsealA11y.read() : null;
        final boolean canDirect = direct != null && direct.trim().length() > 0;
        final String src = canDirect ? direct : paste();
        if (src == null || src.trim().isEmpty()) {
            say("入力欄もクリップボードも空だよ");
            return;
        }
        busy = true;
        say("封印中…");
        core.seal(src, new CoreBridge.Callback() {
            @Override public void done(boolean ok, String value, String error) {
                busy = false;
                if (!ok) { say("失敗: " + error); return; }
                final String env = value;
                core.weights(env, new CoreBridge.Callback() {
                    @Override public void done(boolean ok2, String w, String e2) {
                        String wl = ok2 ? " / 280中 " + w : "";
                        if (canDirect && XsealA11y.write(env)) {
                            say("封印した（" + env.length() + "字" + wl + "）");
                            bubble.postDelayed(new Runnable() {
                                @Override public void run() { closePanel(); }
                            }, 900);
                        } else {
                            copy(env);
                            say("コピーした（" + env.length() + "字" + wl + "）。長押しで貼り付け");
                        }
                    }
                });
            }
        });
    }

    private void doUnseal() {
        if (busy) return;
        String direct = XsealA11y.available() ? XsealA11y.read() : null;
        final boolean canDirect = direct != null && direct.contains("xo");
        final String src = canDirect ? direct : paste();
        if (src == null || src.trim().isEmpty()) {
            say("入力欄もクリップボードも空だよ");
            return;
        }
        busy = true;
        say("復号中…");
        core.unseal(src, new CoreBridge.Callback() {
            @Override public void done(boolean ok, String value, String error) {
                busy = false;
                if (!ok) { say("復号できない: " + error); return; }
                if (canDirect && XsealA11y.write(value)) {
                    say("戻した（" + value.length() + "字）");
                    bubble.postDelayed(new Runnable() {
                        @Override public void run() { closePanel(); }
                    }, 900);
                } else {
                    copy(value);
                    say("コピーした（" + value.length() + "字）。長押しで貼り付け");
                }
            }
        });
    }
}
