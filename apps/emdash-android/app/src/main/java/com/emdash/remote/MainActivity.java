package com.emdash.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONObject;

/**
 * Emdash on a phone: the computer's web page in a full-screen WebView. Each start signs in
 * again with the saved connect link, so being signed out by cleared cookies can't happen;
 * Back on the page's first screen opens the list of computers.
 */
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 1;
    private static final long RETRY_MS = 10_000;

    private enum Panel {
        NONE,
        ADD,
        UNREACHABLE,
        SIGNED_OUT
    }

    private Computers computers;
    private Computers.Computer current;
    private WebView web;
    private View panel;
    private TextView panelTitle;
    private TextView panelMessage;
    private EditText linkInput;
    private Button primaryButton;
    private Button secondaryButton;
    private Panel shown = Panel.NONE;
    private ValueCallback<Uri[]> pendingFiles;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean resumed;
    /** While a computer can't be reached and the app is open, it is tried again every few seconds. */
    private final Runnable retry = () -> {
        if (resumed && shown == Panel.UNREACHABLE) reconnect();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        drawBehindSystemBars();

        computers = new Computers(this);
        web = findViewById(R.id.web);
        panel = findViewById(R.id.panel);
        panelTitle = findViewById(R.id.panel_title);
        panelMessage = findViewById(R.id.panel_message);
        linkInput = findViewById(R.id.link_input);
        primaryButton = findViewById(R.id.primary_button);
        secondaryButton = findViewById(R.id.secondary_button);
        setUpWebView();
        setUpBack();
        watchNetwork();

        Computers.Computer shared = linkFrom(getIntent());
        if (shared != null) {
            open(computers.save(shared));
        } else if (computers.current() != null) {
            open(computers.current());
        } else {
            showPanel(Panel.ADD);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Computers.Computer shared = linkFrom(intent);
        if (shared != null) open(computers.save(shared));
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (shown == Panel.UNREACHABLE) reconnect();
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        handler.removeCallbacks(retry);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retry);
        if (networkCallback != null) {
            getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        }
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The clipboard can only be read while focused; a copied link fills itself in.
        if (hasFocus && linkInput.getVisibility() == View.VISIBLE && linkInput.length() == 0) {
            ClipData clip = getSystemService(ClipboardManager.class).getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).coerceToText(this);
                if (Computers.parseLink(text.toString()) != null) linkInput.setText(text);
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || pendingFiles == null) return;
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFiles = null;
    }

    private void open(Computers.Computer computer) {
        current = computer;
        computers.select(computer);
        showPanel(Panel.NONE);
        web.clearHistory();
        web.loadUrl(computer.connectUrl());
    }

    private void reconnect() {
        if (current == null) return;
        showPanel(Panel.NONE);
        web.loadUrl(current.connectUrl());
    }

    private void setUpWebView() {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " EmdashAndroid/" + version());
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        if (current != null && sameOrigin(request.getUrl(), current.baseUrl)) {
                            return false;
                        }
                        // Links out of Emdash (docs, PRs, issues) open in the phone's browser.
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                        } catch (ActivityNotFoundException ignored) {
                            // Nothing can open it; stay on the page.
                        }
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (current != null && current.name == null && shown == Panel.NONE) {
                            fetchName(current);
                        }
                    }

                    @Override
                    public void onReceivedError(
                            WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame()) showPanel(Panel.UNREACHABLE);
                    }

                    @Override
                    public void onReceivedHttpError(
                            WebView view, WebResourceRequest request, WebResourceResponse response) {
                        if (request.isForMainFrame() && response.getStatusCode() == 401) {
                            showPanel(Panel.SIGNED_OUT);
                        }
                    }
                });
        web.setWebChromeClient(
                new WebChromeClient() {
                    @Override
                    public boolean onShowFileChooser(
                            WebView view,
                            ValueCallback<Uri[]> callback,
                            FileChooserParams params) {
                        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                        pendingFiles = callback;
                        try {
                            startActivityForResult(params.createIntent(), FILE_CHOOSER);
                        } catch (ActivityNotFoundException e) {
                            pendingFiles = null;
                            return false;
                        }
                        return true;
                    }
                });
    }

    /** The computer's own name, from its `/info`, to tell computers apart in the list. */
    private void fetchName(Computers.Computer computer) {
        new Thread(
                        () -> {
                            String name = null;
                            try {
                                HttpURLConnection connection =
                                        (HttpURLConnection) new URL(computer.baseUrl + "/info")
                                                .openConnection();
                                connection.setConnectTimeout(10_000);
                                connection.setReadTimeout(10_000);
                                connection.setRequestProperty(
                                        "Cookie", "emdash_remote=" + computer.token);
                                if (connection.getResponseCode() == 200) {
                                    name = new JSONObject(read(connection.getInputStream()))
                                            .optString("name", null);
                                }
                                connection.disconnect();
                            } catch (Exception ignored) {
                                // Unnamed for now; it is asked again next time.
                            }
                            if (name == null || name.isEmpty()) return;
                            Computers.Computer named =
                                    new Computers.Computer(computer.baseUrl, computer.token, name);
                            runOnUiThread(
                                    () -> {
                                        Computers.Computer saved = computers.save(named);
                                        if (current != null
                                                && current.baseUrl.equals(saved.baseUrl)) {
                                            current = saved;
                                        }
                                    });
                        })
                .start();
    }

    private void showPanel(Panel kind) {
        shown = kind;
        handler.removeCallbacks(retry);
        if (kind == Panel.UNREACHABLE) handler.postDelayed(retry, RETRY_MS);
        if (kind == Panel.NONE) {
            panel.setVisibility(View.GONE);
            return;
        }
        String name = current != null ? current.label() : "";
        panel.setVisibility(View.VISIBLE);
        boolean needsLink = kind == Panel.ADD || kind == Panel.SIGNED_OUT;
        linkInput.setVisibility(needsLink ? View.VISIBLE : View.GONE);
        linkInput.setError(null);
        if (needsLink) linkInput.setText("");

        switch (kind) {
            case ADD:
                panelTitle.setText(R.string.add_title);
                panelMessage.setText(R.string.add_message);
                break;
            case UNREACHABLE:
                panelTitle.setText(getString(R.string.unreachable_title, name));
                panelMessage.setText(R.string.unreachable_message);
                break;
            case SIGNED_OUT:
                panelTitle.setText(getString(R.string.signed_out_title, name));
                panelMessage.setText(R.string.signed_out_message);
                break;
            default:
                break;
        }
        if (kind == Panel.UNREACHABLE) {
            primaryButton.setText(R.string.retry);
            primaryButton.setOnClickListener(v -> reconnect());
        } else {
            primaryButton.setText(R.string.connect);
            primaryButton.setOnClickListener(v -> connectFromInput());
        }
        boolean hasComputers = !computers.all().isEmpty();
        secondaryButton.setVisibility(hasComputers ? View.VISIBLE : View.GONE);
        secondaryButton.setText(R.string.computers);
        secondaryButton.setOnClickListener(v -> showComputers());
    }

    private void connectFromInput() {
        Computers.Computer computer = Computers.parseLink(linkInput.getText().toString());
        if (computer == null) {
            linkInput.setError(getString(R.string.invalid_link));
            return;
        }
        open(computers.save(computer));
    }

    private void showComputers() {
        List<Computers.Computer> list = computers.all();
        String[] items = new String[list.size() + (current != null ? 3 : 1)];
        for (int i = 0; i < list.size(); i++) {
            Computers.Computer computer = list.get(i);
            boolean isCurrent = current != null && computer.baseUrl.equals(current.baseUrl);
            items[i] = (isCurrent ? "✓  " : "     ") + computer.label();
        }
        int add = list.size();
        items[add] = getString(R.string.add_computer);
        if (current != null) {
            items[add + 1] = getString(R.string.reload);
            items[add + 2] = getString(R.string.remove_computer, current.label());
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.computers)
                .setItems(
                        items,
                        (dialog, which) -> {
                            if (which < add) {
                                open(list.get(which));
                            } else if (which == add) {
                                showPanel(Panel.ADD);
                            } else if (which == add + 1) {
                                reconnect();
                            } else {
                                confirmRemove(current);
                            }
                        })
                .setNegativeButton(R.string.exit, (dialog, which) -> finish())
                .show();
    }

    private void confirmRemove(Computers.Computer computer) {
        new AlertDialog.Builder(this)
                .setMessage(getString(R.string.remove_confirm, computer.label()))
                .setPositiveButton(
                        R.string.remove,
                        (dialog, which) -> {
                            computers.remove(computer);
                            Computers.Computer next = computers.current();
                            if (next != null) {
                                open(next);
                            } else {
                                current = null;
                                web.loadUrl("about:blank");
                                showPanel(Panel.ADD);
                            }
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void setUpBack() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher()
                    .registerOnBackInvokedCallback(
                            OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        back();
    }

    private void back() {
        if (shown == Panel.ADD && current != null) {
            showPanel(Panel.NONE);
        } else if (shown == Panel.NONE && web.canGoBack()) {
            web.goBack();
        } else if (computers.all().isEmpty()) {
            finish();
        } else {
            showComputers();
        }
    }

    /** Back on the network (Wi-Fi ↔ mobile data, VPN up): try an unreachable computer again. */
    private void watchNetwork() {
        networkCallback =
                new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        runOnUiThread(
                                () -> {
                                    if (shown == Panel.UNREACHABLE) reconnect();
                                });
                    }
                };
        getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);
    }

    /** Lays the page out between the status bar, the navigation bar and the keyboard. */
    @SuppressWarnings("deprecation")
    private void drawBehindSystemBars() {
        View root = findViewById(R.id.root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener(
                    (view, insets) -> {
                        Insets bars =
                                insets.getInsets(
                                        WindowInsets.Type.systemBars()
                                                | WindowInsets.Type.displayCutout()
                                                | WindowInsets.Type.ime());
                        view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                        return WindowInsets.CONSUMED;
                    });
        } else {
            root.setFitsSystemWindows(true);
        }
    }

    private Computers.Computer linkFrom(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            return Computers.parseLink(intent.getData().toString());
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            return Computers.parseLink(intent.getStringExtra(Intent.EXTRA_TEXT));
        }
        return null;
    }

    private static boolean sameOrigin(Uri url, String baseUrl) {
        Uri base = Uri.parse(baseUrl);
        return base.getScheme().equals(url.getScheme())
                && base.getAuthority().equals(url.getAuthority());
    }

    private String version() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private static String read(InputStream stream) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
        stream.close();
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
