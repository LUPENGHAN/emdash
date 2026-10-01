package com.emdash.remote;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.Uri;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * One computer's Emdash page, kept loaded while the app runs so switching back to it
 * picks up where it was. Signs in with the saved connect link on its first load and on
 * every reconnect.
 */
final class Session {
    enum Status {
        LOADING,
        READY,
        UNREACHABLE,
        SIGNED_OUT
    }

    interface Listener {
        void onStatusChanged(Session session);

        /** A link out of Emdash (docs, PRs, issues), for the phone's browser. */
        void onExternalLink(Uri url);

        boolean onFileChooser(
                ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params);
    }

    /** How long Emdash may take to start before the page counts as stuck. */
    private static final long BOOT_TIMEOUT_MS = 30_000;
    private static final long BOOT_CHECK_MS = 1_000;
    /** True once Emdash's boot splash is gone (`index.html`'s `#boot-splash`). */
    private static final String BOOTED_JS =
            "(function(){var s=document.getElementById('boot-splash');"
                    + "return !s||s.classList.contains('boot-splash-done');})()";

    Computers.Computer computer;
    final WebView web;
    Status status = Status.LOADING;
    /** Emdash started on the page; until then a failed script leaves it stuck. */
    private boolean booted;
    private long loadedAt;
    private final Listener listener;

    @SuppressLint("SetJavaScriptEnabled")
    Session(Context context, Computers.Computer computer, String userAgentSuffix, Listener listener) {
        this.computer = computer;
        this.listener = listener;
        web = new WebView(context);
        web.setVisibility(View.GONE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + userAgentSuffix);

        web.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        if (sameOrigin(request.getUrl(), Session.this.computer.baseUrl)) return false;
                        listener.onExternalLink(request.getUrl());
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (status != Status.LOADING) return;
                        setStatus(Status.READY, listener);
                        loadedAt = System.currentTimeMillis();
                        web.postDelayed(Session.this::checkBoot, BOOT_CHECK_MS);
                    }

                    @Override
                    public void onReceivedError(
                            WebView view, WebResourceRequest request, WebResourceError error) {
                        // A script that fails while Emdash starts (the connection dropped
                        // mid-load) leaves it on its splash for good: count it unreachable.
                        boolean ownAsset =
                                sameOrigin(request.getUrl(), Session.this.computer.baseUrl);
                        if (request.isForMainFrame() || (ownAsset && !booted)) {
                            setStatus(Status.UNREACHABLE, listener);
                        }
                    }

                    @Override
                    public void onReceivedHttpError(
                            WebView view, WebResourceRequest request, WebResourceResponse response) {
                        if (request.isForMainFrame() && response.getStatusCode() == 401) {
                            setStatus(Status.SIGNED_OUT, listener);
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
                        return listener.onFileChooser(callback, params);
                    }
                });
        connect();
    }

    /** Signs in again with the computer's link and loads Emdash. */
    void connect() {
        status = Status.LOADING;
        booted = false;
        web.clearHistory();
        web.loadUrl(computer.connectUrl());
    }

    /** Watches the page until Emdash has started, or calls it stuck. */
    private void checkBoot() {
        if (status != Status.READY || booted) return;
        web.evaluateJavascript(
                BOOTED_JS,
                value -> {
                    if (status != Status.READY || booted) return;
                    if ("true".equals(value)) {
                        booted = true;
                    } else if (System.currentTimeMillis() - loadedAt > BOOT_TIMEOUT_MS) {
                        setStatus(Status.UNREACHABLE, listener);
                    } else {
                        web.postDelayed(this::checkBoot, BOOT_CHECK_MS);
                    }
                });
    }

    void destroy() {
        web.stopLoading();
        web.destroy();
    }

    private void setStatus(Status next, Listener listener) {
        if (next == Status.UNREACHABLE) web.stopLoading();
        if (status == next) return;
        status = next;
        listener.onStatusChanged(this);
    }

    static boolean sameOrigin(Uri url, String baseUrl) {
        Uri base = Uri.parse(baseUrl);
        return base.getScheme().equals(url.getScheme())
                && base.getAuthority().equals(url.getAuthority());
    }
}
