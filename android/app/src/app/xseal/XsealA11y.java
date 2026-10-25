package app.xseal;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * 他アプリ（X など）の入力欄を読み書きするためのサービス。
 * オーバーレイ自身は他アプリの入力欄に文字を入れられないので、ここが本体。
 */
public final class XsealA11y extends AccessibilityService {

    private static volatile XsealA11y inst;

    /** 直近に使った入力欄の素性（ノードは使い回せないので特徴だけ覚える） */
    private static volatile String memPkg = null;
    private static volatile String memId = null;
    private static volatile Rect memRect = null;

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        inst = this;
    }

    @Override public void onDestroy() {
        inst = null;
        super.onDestroy();
    }

    @Override public void onInterrupt() { }

    public static boolean available() { return inst != null; }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null) return;
        int t = e.getEventType();
        if (t != AccessibilityEvent.TYPE_VIEW_FOCUSED
                && t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        AccessibilityNodeInfo n = pickEdit();
        if (n != null && n.isFocused()) remember(n);
    }

    private static void remember(AccessibilityNodeInfo n) {
        try {
            memPkg = String.valueOf(n.getPackageName());
            memId = n.getViewIdResourceName();
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            memRect = r;
        } catch (Throwable ignored) {}
    }

    public static String read() {
        AccessibilityNodeInfo n = pickEdit();
        if (n == null) return null;
        CharSequence t = n.getText();
        return t == null ? "" : t.toString();
    }

    public static boolean write(String text) {
        AccessibilityNodeInfo n = pickEdit();
        if (n == null) return false;
        remember(n);
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = false;
        try { ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b); } catch (Throwable ignored) {}
        try { n.refresh(); } catch (Throwable ignored) {}
        CharSequence after = null;
        try { after = n.getText(); } catch (Throwable ignored) {}
        if (after != null && text.contentEquals(after)) return true;
        return ok;
    }

    /** 診断用: いま見えている入力欄の一覧 */
    public static String dump() {
        if (inst == null) return "アクセシビリティサービスが無効です";
        StringBuilder sb = new StringBuilder();
        int i = 0;
        for (AccessibilityNodeInfo n : allEditables()) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            CharSequence t = n.getText();
            sb.append('#').append(i++)
              .append(" pkg=").append(n.getPackageName())
              .append(" id=").append(n.getViewIdResourceName())
              .append(" focused=").append(n.isFocused())
              .append(" rect=").append(r.left).append(',').append(r.top).append(',')
              .append(r.width()).append('x').append(r.height())
              .append(" len=").append(t == null ? -1 : t.length())
              .append('\n');
        }
        if (i == 0) sb.append("入力欄が見つかりません\n");
        sb.append("remembered=").append(memPkg).append('/').append(memId);
        return sb.toString();
    }

    private static List<AccessibilityNodeInfo> allEditables() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        if (inst == null) return out;
        List<AccessibilityWindowInfo> wins = null;
        try { wins = inst.getWindows(); } catch (Throwable ignored) {}
        if (wins != null) {
            for (AccessibilityWindowInfo w : wins) {
                AccessibilityNodeInfo root = null;
                try { root = w.getRoot(); } catch (Throwable ignored) {}
                if (root == null) continue;
                if ("app.xseal".contentEquals(root.getPackageName())) continue;
                walk(root, out, 0);
            }
        }
        if (out.isEmpty()) {
            AccessibilityNodeInfo root = null;
            try { root = inst.getRootInActiveWindow(); } catch (Throwable ignored) {}
            if (root != null && !"app.xseal".contentEquals(root.getPackageName())) walk(root, out, 0);
        }
        return out;
    }

    private static void walk(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out, int depth) {
        if (node == null || depth > 40 || out.size() > 40) return;
        boolean editable = false;
        try { editable = node.isEditable() || node.isFocused() && node.isEditable(); } catch (Throwable ignored) {}
        CharSequence cls = node.getClassName();
        boolean textish = cls != null && (cls.toString().contains("EditText") || cls.toString().contains("TextField"));
        if (editable || textish) out.add(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo c = null;
            try { c = node.getChild(i); } catch (Throwable ignored) {}
            if (c != null) walk(c, out, depth + 1);
        }
    }

    private static AccessibilityNodeInfo pickEdit() {
        List<AccessibilityNodeInfo> eds = allEditables();
        if (eds.isEmpty()) return null;
        for (AccessibilityNodeInfo n : eds) {
            boolean f = false;
            try { f = n.isFocused(); } catch (Throwable ignored) {}
            if (f) return n;
        }
        if (memRect != null) {
            for (AccessibilityNodeInfo n : eds) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (memPkg != null && memPkg.contentEquals(String.valueOf(n.getPackageName()))
                        && Math.abs(r.width() - memRect.width()) <= 8
                        && Math.abs(r.height() - memRect.height()) <= 8) {
                    return n;
                }
            }
        }
        AccessibilityNodeInfo best = null;
        long bestArea = -1;
        for (AccessibilityNodeInfo n : eds) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            long a = (long) r.width() * r.height();
            if (a > bestArea) { bestArea = a; best = n; }
        }
        return best;
    }
}
