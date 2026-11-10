package local.socratic.reader;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREF = "sr_prefs";
    private static final String KEY = "server_url";
    private WebView web;
    private FrameLayout root;
    private TextView gear;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root = new FrameLayout(this);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setBackgroundColor(Color.parseColor("#0f1012"));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return false;
            }
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                if (url != null && !url.startsWith("about:")) {
                    Toast.makeText(MainActivity.this, "连不上服务器：" + desc + "\n点右上角 ⚙ 改地址", Toast.LENGTH_LONG).show();
                    gear.setVisibility(View.VISIBLE);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                if (p > 60) gear.setAlpha(0.35f);
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        gear = new TextView(this);
        gear.setText("⚙");
        gear.setTextSize(20);
        gear.setTextColor(Color.argb(150, 255, 255, 255));
        gear.setGravity(Gravity.CENTER);
        gear.setOnClickListener(v -> askUrl());
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.TOP | Gravity.RIGHT);
        gp.topMargin = dp(8);
        gp.rightMargin = dp(4);
        root.addView(gear, gp);

        setContentView(root);
        String url = prefs().getString(KEY, "");
        if (url == null || url.isEmpty()) {
            askUrl();
        } else {
            load(url);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREF, MODE_PRIVATE);
    }

    private void load(String url) {
        web.loadUrl(url);
        Toast.makeText(this, "正在连接 " + url, Toast.LENGTH_SHORT).show();
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private void askUrl() {
        String cur = prefs().getString(KEY, "");
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.5:3777");
        input.setText(cur != null ? cur : "");
        input.setSingleLine(true);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(12), dp(20), 0);

        TextView tip = new TextView(this);
        tip.setText("填电脑的地址（同一 WiFi）\n格式：http://电脑IP:3777\n电脑上运行阅读器后，我这里能连上就能用。");
        tip.setTextSize(12);
        tip.setPadding(0, 0, 0, dp(10));
        box.addView(tip);
        box.addView(input);

        new AlertDialog.Builder(this)
            .setTitle("连接苏格拉底阅读器")
            .setView(box)
            .setCancelable(cur != null && !cur.isEmpty())
            .setPositiveButton("连接", (d, w) -> {
                String u = normalize(input.getText().toString());
                if (u.isEmpty()) { Toast.makeText(this, "地址不能为空", Toast.LENGTH_SHORT).show(); return; }
                prefs().edit().putString(KEY, u).apply();
                gear.setVisibility(View.VISIBLE);
                load(u);
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}
