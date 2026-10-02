package com.emdash.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Emdash on a phone. A list of the user's computers, each opening its Emdash page full
 * screen (a {@link Session} kept loaded, so switching back picks up where it was). A small
 * floating button on the page, or Back on its first screen, returns to the list.
 */
public class MainActivity extends Activity implements Session.Listener {
    private static final int FILE_CHOOSER = 1;
    private static final long RETRY_MS = 10_000;
    private static final long PROBE_MS = 10_000;

    /** What a computer's card says about it, from a quick request to its `/info`. */
    private enum Reachability {
        CHECKING,
        ONLINE,
        OFFLINE,
        SIGNED_OUT
    }

    private Computers computers;
    private FileBridge files;
    private SharedPreferences prefs;
    private final Map<String, Session> sessions = new HashMap<>();
    private final Map<String, Reachability> reachability = new HashMap<>();
    private Session current;
    /** Adding a computer (not a session's own error) is what the panel shows. */
    private boolean adding;

    private FrameLayout webContainer;
    private View devices;
    private LinearLayout deviceCards;
    private View panel;
    private TextView panelTitle;
    private TextView panelMessage;
    private EditText linkInput;
    private Button primaryButton;
    private Button secondaryButton;
    private View bubble;

    private ValueCallback<Uri[]> pendingFiles;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService probes = Executors.newCachedThreadPool();
    private boolean resumed;

    /** While the open computer can't be reached and the app is open, it is tried again. */
    private final Runnable retry =
            () -> {
                if (resumed && current != null && current.status == Session.Status.UNREACHABLE) {
                    current.connect();
                    render();
                }
            };

    /** While the list shows, each computer's state is checked again now and then. */
    private final Runnable probeAgain =
            () -> {
                if (resumed && devices.getVisibility() == View.VISIBLE) probeAll();
            };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        drawBehindSystemBars();
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        computers = new Computers(this);
        files = new FileBridge(this);
        prefs = getSharedPreferences("ui", MODE_PRIVATE);
        webContainer = findViewById(R.id.web_container);
        devices = findViewById(R.id.devices);
        deviceCards = findViewById(R.id.device_cards);
        panel = findViewById(R.id.panel);
        panelTitle = findViewById(R.id.panel_title);
        panelMessage = findViewById(R.id.panel_message);
        linkInput = findViewById(R.id.link_input);
        primaryButton = findViewById(R.id.primary_button);
        secondaryButton = findViewById(R.id.secondary_button);
        bubble = findViewById(R.id.bubble);
        findViewById(R.id.add_device).setOnClickListener(v -> showAdd());
        setUpBubble();
        setUpBack();
        watchNetwork();

        Computers.Computer shared = linkFrom(getIntent());
        List<Computers.Computer> all = computers.all();
        if (shared != null) {
            open(computers.save(shared));
        } else if (all.isEmpty()) {
            showAdd();
        } else if (all.size() == 1) {
            open(all.get(0));
        } else {
            showDevices();
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
        if (current != null && current.status == Session.Status.UNREACHABLE) retry.run();
        if (devices.getVisibility() == View.VISIBLE) probeAll();
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        handler.removeCallbacks(retry);
        handler.removeCallbacks(probeAgain);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        probes.shutdownNow();
        if (networkCallback != null) {
            getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        }
        for (Session session : sessions.values()) session.destroy();
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

    // ── Screens ──────────────────────────────────────────────────────────────

    /** Opens a computer's page, loading it the first time and keeping it after. */
    private void open(Computers.Computer computer) {
        computers.select(computer);
        Session session = sessions.get(computer.baseUrl);
        if (session == null) {
            session = new Session(this, computer, " EmdashAndroid/" + version(), files, this);
            sessions.put(computer.baseUrl, session);
            // Under the floating button, which is the container's last child.
            webContainer.addView(
                    session.web,
                    0,
                    new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        } else {
            // A new link for a computer already open: sign in with it.
            boolean newToken = !session.computer.token.equals(computer.token);
            session.computer = computer;
            if (newToken || session.status == Session.Status.UNREACHABLE) session.connect();
        }
        current = session;
        adding = false;
        render();
    }

    private void showDevices() {
        current = null;
        adding = false;
        render();
        probeAll();
    }

    private void showAdd() {
        adding = true;
        render();
    }

    /** Shows what the state calls for: the add panel, the list, or a computer's page. */
    private void render() {
        handler.removeCallbacks(retry);
        handler.removeCallbacks(probeAgain);
        for (Session session : sessions.values()) {
            session.web.setVisibility(session == current ? View.VISIBLE : View.GONE);
        }
        if (adding) {
            showPanel(R.string.add_title, getString(R.string.add_message), true);
            primaryButton.setText(R.string.connect);
            primaryButton.setOnClickListener(v -> connectFromInput(null));
            devices.setVisibility(View.GONE);
            bubble.setVisibility(View.GONE);
            return;
        }
        if (current == null) {
            panel.setVisibility(View.GONE);
            devices.setVisibility(View.VISIBLE);
            bubble.setVisibility(View.GONE);
            renderDevices();
            return;
        }
        devices.setVisibility(View.GONE);
        bubble.setVisibility(View.VISIBLE);
        String name = current.computer.label();
        switch (current.status) {
            case UNREACHABLE:
                showPanel(0, getString(R.string.unreachable_message), false);
                panelTitle.setText(getString(R.string.unreachable_title, name));
                primaryButton.setText(R.string.retry);
                primaryButton.setOnClickListener(v -> retry.run());
                handler.postDelayed(retry, RETRY_MS);
                break;
            case SIGNED_OUT:
                showPanel(0, getString(R.string.signed_out_message), true);
                panelTitle.setText(getString(R.string.signed_out_title, name));
                primaryButton.setText(R.string.connect);
                Session signedOut = current;
                primaryButton.setOnClickListener(v -> connectFromInput(signedOut));
                break;
            default:
                panel.setVisibility(View.GONE);
                break;
        }
    }

    private void showPanel(int title, String message, boolean needsLink) {
        panel.setVisibility(View.VISIBLE);
        if (title != 0) panelTitle.setText(title);
        panelMessage.setText(message);
        linkInput.setVisibility(needsLink ? View.VISIBLE : View.GONE);
        linkInput.setError(null);
        if (needsLink) linkInput.setText("");
        boolean hasComputers = !computers.all().isEmpty();
        secondaryButton.setVisibility(hasComputers ? View.VISIBLE : View.GONE);
        secondaryButton.setText(R.string.computers);
        secondaryButton.setOnClickListener(v -> showDevices());
    }

    /** Adds the pasted link's computer, or gives a signed-out one its new link. */
    private void connectFromInput(Session signedOut) {
        Computers.Computer computer = Computers.parseLink(linkInput.getText().toString());
        if (computer == null) {
            linkInput.setError(getString(R.string.invalid_link));
            return;
        }
        open(computers.save(computer));
        if (signedOut != null && current != null && current.status == Session.Status.SIGNED_OUT) {
            current.connect();
            render();
        }
    }

    // ── Computer list ────────────────────────────────────────────────────────

    private void renderDevices() {
        deviceCards.removeAllViews();
        LayoutInflater inflater = getLayoutInflater();
        String lastUsed = computers.current() != null ? computers.current().baseUrl : null;
        for (Computers.Computer computer : computers.all()) {
            View card = inflater.inflate(R.layout.device_card, deviceCards, false);
            ((TextView) card.findViewById(R.id.device_name)).setText(computer.label());
            Reachability state = reachability.getOrDefault(computer.baseUrl, Reachability.CHECKING);
            String address = Uri.parse(computer.baseUrl).getAuthority();
            String detail = getString(statusText(state)) + " · " + address;
            if (sessions.containsKey(computer.baseUrl)) detail += " · " + getString(R.string.status_open);
            ((TextView) card.findViewById(R.id.device_detail)).setText(detail);
            GradientDrawable dot = new GradientDrawable();
            dot.setShape(GradientDrawable.OVAL);
            dot.setColor(getColor(statusColor(state)));
            card.findViewById(R.id.device_dot).setBackground(dot);
            card.setSelected(computer.baseUrl.equals(lastUsed));
            card.setOnClickListener(v -> open(computer));
            card.setOnLongClickListener(
                    v -> {
                        showDeviceMenu(computer);
                        return true;
                    });
            deviceCards.addView(card);
        }
    }

    private static int statusText(Reachability state) {
        switch (state) {
            case ONLINE:
                return R.string.status_online;
            case OFFLINE:
                return R.string.status_offline;
            case SIGNED_OUT:
                return R.string.status_signed_out;
            default:
                return R.string.status_checking;
        }
    }

    private static int statusColor(Reachability state) {
        switch (state) {
            case ONLINE:
                return R.color.online;
            case OFFLINE:
                return R.color.offline;
            case SIGNED_OUT:
                return R.color.warning;
            default:
                return R.color.muted;
        }
    }

    private void showDeviceMenu(Computers.Computer computer) {
        String[] items = {
            getString(R.string.rename),
            getString(R.string.reload),
            getString(R.string.remove_computer, computer.label())
        };
        new AlertDialog.Builder(this)
                .setTitle(computer.label())
                .setItems(
                        items,
                        (dialog, which) -> {
                            if (which == 0) {
                                showRename(computer);
                            } else if (which == 1) {
                                Session session = sessions.get(computer.baseUrl);
                                if (session != null) session.connect();
                                open(computer);
                            } else {
                                confirmRemove(computer);
                            }
                        })
                .show();
    }

    private void showRename(Computers.Computer computer) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setText(computer.name);
        input.setSelectAllOnFocus(true);
        int padding = dp(20);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(padding, dp(8), padding, 0);
        frame.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(R.string.rename)
                .setView(frame)
                .setPositiveButton(
                        android.R.string.ok,
                        (dialog, which) -> {
                            Computers.Computer renamed =
                                    computers.rename(computer, input.getText().toString());
                            Session session = sessions.get(computer.baseUrl);
                            if (session != null) session.computer = renamed;
                            if (renamed.name == null) probe(renamed);
                            renderDevices();
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void confirmRemove(Computers.Computer computer) {
        new AlertDialog.Builder(this)
                .setMessage(getString(R.string.remove_confirm, computer.label()))
                .setPositiveButton(
                        R.string.remove,
                        (dialog, which) -> {
                            computers.remove(computer);
                            reachability.remove(computer.baseUrl);
                            Session session = sessions.remove(computer.baseUrl);
                            if (session != null) {
                                webContainer.removeView(session.web);
                                session.destroy();
                            }
                            if (computers.all().isEmpty()) showAdd();
                            else showDevices();
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void probeAll() {
        for (Computers.Computer computer : computers.all()) probe(computer);
        handler.removeCallbacks(probeAgain);
        handler.postDelayed(probeAgain, PROBE_MS);
    }

    /** Asks a computer's `/info` whether it is up and the link still works; names it too. */
    private void probe(Computers.Computer computer) {
        probes.execute(
                () -> {
                    Reachability state;
                    String name = null;
                    try {
                        HttpURLConnection connection =
                                (HttpURLConnection) new URL(computer.baseUrl + "/info").openConnection();
                        connection.setConnectTimeout(4_000);
                        connection.setReadTimeout(4_000);
                        connection.setRequestProperty("Cookie", "emdash_remote=" + computer.token);
                        int code = connection.getResponseCode();
                        if (code == 200) {
                            state = Reachability.ONLINE;
                            name = new JSONObject(read(connection.getInputStream())).optString("name", null);
                        } else {
                            state = code == 401 ? Reachability.SIGNED_OUT : Reachability.OFFLINE;
                        }
                        connection.disconnect();
                    } catch (Exception e) {
                        state = Reachability.OFFLINE;
                    }
                    Reachability result = state;
                    String reported = name;
                    runOnUiThread(() -> onProbed(computer, result, reported));
                });
    }

    private void onProbed(Computers.Computer computer, Reachability state, String name) {
        if (isDestroyed()) return;
        reachability.put(computer.baseUrl, state);
        // A computer keeps the name the user gave it; otherwise it takes its own.
        Computers.Computer saved = null;
        for (Computers.Computer known : computers.all()) {
            if (known.baseUrl.equals(computer.baseUrl)) saved = known;
        }
        if (saved != null && saved.name == null && name != null && !name.isEmpty()) {
            saved = computers.save(new Computers.Computer(saved.baseUrl, saved.token, name));
            Session session = sessions.get(saved.baseUrl);
            if (session != null) session.computer = saved;
        }
        if (devices.getVisibility() == View.VISIBLE) renderDevices();
    }

    // ── Session events ───────────────────────────────────────────────────────

    @Override
    public void onStatusChanged(Session session) {
        if (session.status == Session.Status.READY && session.computer.name == null) {
            probe(session.computer);
        }
        if (session == current) render();
    }

    @Override
    public void onExternalLink(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException ignored) {
            // Nothing can open it; stay on the page.
        }
    }

    @Override
    public boolean onFileChooser(
            ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
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

    // ── Floating button ──────────────────────────────────────────────────────

    /**
     * A small button over the page that returns to the list. It can be dragged out of the
     * way; it settles on the nearer side, and keeps its place.
     */
    private void setUpBubble() {
        int touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        bubble.post(this::placeBubble);
        bubble.setOnTouchListener(
                new View.OnTouchListener() {
                    private float downX;
                    private float downY;
                    private float startX;
                    private float startY;
                    private boolean dragging;

                    @Override
                    public boolean onTouch(View view, MotionEvent event) {
                        switch (event.getActionMasked()) {
                            case MotionEvent.ACTION_DOWN:
                                downX = event.getRawX();
                                downY = event.getRawY();
                                startX = view.getX();
                                startY = view.getY();
                                dragging = false;
                                return true;
                            case MotionEvent.ACTION_MOVE:
                                float dx = event.getRawX() - downX;
                                float dy = event.getRawY() - downY;
                                if (!dragging && Math.hypot(dx, dy) > touchSlop) dragging = true;
                                if (dragging) {
                                    view.setX(clamp(startX + dx, 0, maxBubbleX()));
                                    view.setY(clamp(startY + dy, 0, maxBubbleY()));
                                }
                                return true;
                            case MotionEvent.ACTION_UP:
                                if (dragging) settleBubble();
                                else showDevices();
                                return true;
                            default:
                                return false;
                        }
                    }
                });
        // It sits on the screen's edge, where a swipe is the system's Back: keep its drags.
        if (Build.VERSION.SDK_INT >= 29) {
            bubble.addOnLayoutChangeListener(
                    (view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) ->
                            view.setSystemGestureExclusionRects(
                                    List.of(new Rect(0, 0, right - left, bottom - top))));
        }
        webContainer.addOnLayoutChangeListener(
                (view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
                    if (bottom - top != oldBottom - oldTop || right - left != oldRight - oldLeft) {
                        placeBubble();
                    }
                });
    }

    private void placeBubble() {
        boolean left = prefs.getBoolean("bubble_left", false);
        float share = prefs.getFloat("bubble_y", 0.3f);
        styleBubble(left);
        bubble.setX(left ? 0 : maxBubbleX());
        bubble.setY(clamp(share * maxBubbleY(), 0, maxBubbleY()));
    }

    /** A tab flush with the edge it sits on: rounded on the inner side only. */
    private void styleBubble(boolean left) {
        float r = dp(12);
        GradientDrawable tab = new GradientDrawable();
        tab.setColor(getColor(R.color.bubble));
        tab.setStroke(dp(1), getColor(R.color.border));
        tab.setCornerRadii(
                left
                        ? new float[] {0, 0, r, r, r, r, 0, 0}
                        : new float[] {r, r, 0, 0, 0, 0, r, r});
        bubble.setBackground(tab);
    }

    private void settleBubble() {
        boolean left =
                bubble.getX() + bubble.getLayoutParams().width / 2f < webContainer.getWidth() / 2f;
        float share = maxBubbleY() > 0 ? bubble.getY() / maxBubbleY() : 0.3f;
        prefs.edit().putBoolean("bubble_left", left).putFloat("bubble_y", share).apply();
        styleBubble(left);
        bubble.animate().x(left ? 0 : maxBubbleX()).setDuration(150).start();
    }

    // Its own size, not getWidth(): it measures 0 while hidden, which is when it is placed.
    private float maxBubbleX() {
        return Math.max(0, webContainer.getWidth() - bubble.getLayoutParams().width);
    }

    private float maxBubbleY() {
        return Math.max(0, webContainer.getHeight() - bubble.getLayoutParams().height);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    private int dp(int value) {
        return (int)
                TypedValue.applyDimension(
                        TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    // ── Back, network, insets ────────────────────────────────────────────────

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
        if (adding && !computers.all().isEmpty()) {
            if (current != null) open(current.computer);
            else showDevices();
        } else if (current != null
                && current.status == Session.Status.READY
                && current.web.canGoBack()) {
            current.web.goBack();
        } else if (current != null) {
            showDevices();
        } else {
            // Out of the way, with every computer's page still loaded for next time.
            moveTaskToBack(true);
        }
    }

    /** Back on the network (Wi-Fi ↔ mobile data, VPN up): reconnect, and check the list. */
    private void watchNetwork() {
        networkCallback =
                new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        runOnUiThread(
                                () -> {
                                    if (isDestroyed()) return;
                                    retry.run();
                                    if (devices.getVisibility() == View.VISIBLE) probeAll();
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
