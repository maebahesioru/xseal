package app.xseal;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** 設定と動作確認。権限の付与とコアの実機テストをここで行う。 */
public final class MainActivity extends Activity {

    private TextView permStatus;
    private EditText input;
    private TextView out;
    private CoreBridge core;

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private Button btn(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(0xFFE7E9EA);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(10));
        g.setColor(0xFF16202A);
        g.setStroke(dp(1), 0x552F8FD8);
        b.setBackground(g);
        b.setSingleLine(false);
        b.setMaxLines(3);
        b.setMinHeight(dp(44));
        b.setPadding(dp(10), dp(6), dp(10), dp(6));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(5), 0, dp(5));
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private TextView label(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        core = new CoreBridge(this);

        ScrollView sc = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(28), dp(18), dp(28));
        root.setBackgroundColor(0xFF0B0D0F);

        root.addView(label("xseal for Android", 22, 0xFFE7E9EA, true));
        TextView sub = label("投稿欄の文を別の文字列に変換してから出す。変換はボタン1個。", 12, 0xFF8B98A5, false);
        sub.setPadding(0, dp(4), 0, dp(14));
        root.addView(sub);

        permStatus = label("", 12, 0xFF9AA4AE, false);
        permStatus.setPadding(0, 0, 0, dp(10));
        root.addView(permStatus);

        root.addView(btn("① オーバーレイ権限を許可", new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(MainActivity.this)) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + getPackageName())));
                } else {
                    toast("すでに許可されています");
                }
            }
        }));

        root.addView(btn("② アクセシビリティを有効にする", new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            }
        }));
        TextView a11yNote = label("　投稿欄に直接書き込むために必要（未許可ならコピー経由で動く）", 11, 0xFF6B7784, false);
        a11yNote.setPadding(dp(2), 0, 0, dp(6));
        root.addView(a11yNote);

        root.addView(btn("③ 画面にボタンを出す", new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(MainActivity.this)) {
                    toast("先にオーバーレイ権限を許可してね");
                    return;
                }
                Intent i = new Intent(MainActivity.this, OverlayService.class);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
                toast("ボタンを出しました");
                finish();
            }
        }));

        root.addView(btn("ボタンを止める", new View.OnClickListener() {
            @Override public void onClick(View v) {
                stopService(new Intent(MainActivity.this, OverlayService.class));
                toast("止めました");
            }
        }));

        root.addView(label("─ 動作確認 ─", 12, 0xFF6B7784, false));

        input = new EditText(this);
        input.setHint("ここに日本語を入れてテスト");
        input.setTextColor(0xFFE7E9EA);
        input.setHintTextColor(0xFF5C6670);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(3);
        input.setGravity(Gravity.TOP | Gravity.START);
        GradientDrawable ig = new GradientDrawable();
        ig.setCornerRadius(dp(10));
        ig.setColor(0xFF11181F);
        ig.setStroke(dp(1), 0x332F8FD8);
        input.setBackground(ig);
        input.setPadding(dp(10), dp(10), dp(10), dp(10));
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(110));
        ilp.setMargins(0, dp(6), 0, dp(6));
        input.setLayoutParams(ilp);
        root.addView(input);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        Button seal = btn("封印", new View.OnClickListener() {
            @Override public void onClick(View v) { runSeal(); }
        });
        Button unseal = btn("復号", new View.OnClickListener() {
            @Override public void onClick(View v) { runUnseal(); }
        });
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, dp(44), 1f);
        half.setMargins(0, dp(5), dp(4), dp(5));
        seal.setLayoutParams(half);
        LinearLayout.LayoutParams half2 = new LinearLayout.LayoutParams(0, dp(44), 1f);
        half2.setMargins(dp(4), dp(5), 0, dp(5));
        unseal.setLayoutParams(half2);
        row.addView(seal);
        row.addView(unseal);
        root.addView(row);

        out = label("", 12, 0xFFB8C2CC, false);
        out.setTextIsSelectable(true);
        out.setTypeface(Typeface.MONOSPACE);
        out.setPadding(0, dp(8), 0, dp(8));
        root.addView(out);

        root.addView(btn("結果をコピー", new View.OnClickListener() {
            @Override public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("xseal", String.valueOf(out.getText())));
                toast("コピーした");
            }
        }));

        root.addView(btn("入力欄の診断（X で押すと中身が見える）", new View.OnClickListener() {
            @Override public void onClick(View v) {
                out.setText(XsealA11y.available() ? XsealA11y.dump() : "アクセシビリティサービスが無効です");
            }
        }));

        TextView foot = label("この形式は暗号ではなく難読化です。鍵なしで誰でも戻せます。", 11, 0xFF6B7784, false);
        foot.setPadding(0, dp(14), 0, 0);
        root.addView(foot);

        sc.addView(root);
        setContentView(sc);
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        boolean ov = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this);
        boolean ax = XsealA11y.available();
        permStatus.setText("オーバーレイ: " + (ov ? "OK" : "未許可")
                + "　／　アクセシビリティ: " + (ax ? "OK" : "未許可")
                + "\nアクセシビリティが無いと、コピー＆貼り付けでの運用になります。");
        permStatus.setTextColor(ov && ax ? 0xFF6FD08C : 0xFFE0A44A);
    }

    private void runSeal() {
        String s = input.getText().toString();
        if (s.trim().isEmpty()) { toast("本文が空だよ"); return; }
        out.setText("…");
        core.seal(s, new CoreBridge.Callback() {
            @Override public void done(boolean ok, String v, String e) {
                if (!ok) { out.setText("失敗: " + e); return; }
                core.weights(v, new CoreBridge.Callback() {
                    @Override public void done(boolean ok2, String w, String e2) {
                        out.setText(v + "\n\n重み: " + (ok2 ? w : "?") + " / 280　文字数: " + v.length());
                    }
                });
            }
        });
    }

    private void runUnseal() {
        String s = out.getText().toString();
        int nl = s.indexOf('\n');
        if (nl > 0) s = s.substring(0, nl);
        if (s.trim().isEmpty()) s = input.getText().toString();
        out.setText("…");
        core.unseal(s, new CoreBridge.Callback() {
            @Override public void done(boolean ok, String v, String e) {
                out.setText(ok ? v : "復号できない: " + e);
            }
        });
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    @Override protected void onDestroy() {
        if (core != null) core.destroy();
        super.onDestroy();
    }
}
