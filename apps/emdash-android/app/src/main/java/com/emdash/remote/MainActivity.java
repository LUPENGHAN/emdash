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
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
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
    private static final String KEY_ACCESS_KEY = "access_key";
    private static final String KEY_INSTALL_ID = "install_id";

    /** What a computer's card says about it, from a quick request to its `/info`. */
    private enum Reachability {
        CHECKING,
        ONLINE,
        OFFLINE,
        SIGNED_OUT,
        /** Cloudflare Access is in front of it, and wants its email code first. */
        VERIFY
    }

    private Computers computers;
    private FileBridge files;
    private SharedPreferences prefs;
    private final Map<String, Session> sessions = new HashMap<>();
    private final Map<String, Reachability> reachability = new HashMap<>();
    /** The address each computer was last reached at, by the address it was added with. */
    private final Map<String, String> activeAddress = new HashMap<>();
    private Session current;
    /** Adding a computer (not a session's own error) is what the panel shows. */
    private boolean adding;
    /** Cloudflare Access's sign-in, shown before signing in at a computer behind it. */
    private WebView verifier;
    /** Back from Access's sign-in: the panel keeps what was typed. */
    private boolean keepInputs;
    /** Signed in at Access just now: turned away again, it won't be asked once more. */
    private boolean accessVerified;

    private FrameLayout webContainer;
    private View devices;
    private LinearLayout deviceCards;
    private View panel;
    private TextView panelTitle;
    private TextView panelMessage;
    private EditText linkInput;
    private EditText keyInput;
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
        keyInput = findViewById(R.id.key_input);
        // A password field's hint would otherwise show in a monospace font.
        keyInput.setTypeface(android.graphics.Typeface.DEFAULT);
        Computers.clientId = installId();
        Computers.deviceName = deviceName();
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
        closeVerifier();
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
            String address =
                    activeAddress.getOrDefault(computer.baseUrl, computer.addresses().get(0));
            session =
                    new Session(
                            this, computer, address, " EmdashAndroid/" + version(), files, this);
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
        rechoose(session, false);
    }

    /**
     * For a computer with several addresses, moves its page to the nearest one that
     * answers, if that is not where it is. A page that is up stays put unless the
     * network changed (`evenIfReady`), when a nearer address may have come in reach.
     */
    private void rechoose(Session session, boolean evenIfReady) {
        if (session.computer.addresses().size() < 2) return;
        Computers.Computer computer = session.computer;
        probes.execute(
                () -> {
                    Choice choice = choose(computer);
                    runOnUiThread(
                            () -> {
                                if (isDestroyed() || choice.address == null) return;
                                activeAddress.put(computer.baseUrl, choice.address);
                                if (choice.address.equals(session.address)) return;
                                if (!evenIfReady && session.status == Session.Status.READY) return;
                                session.switchTo(choice.address);
                                if (session == current) render();
                            });
                });
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
            session.web.setVisibility(
                    session == current && verifier == null ? View.VISIBLE : View.GONE);
        }
        if (verifier != null) {
            panel.setVisibility(View.GONE);
            devices.setVisibility(View.GONE);
            bubble.setVisibility(View.GONE);
            return;
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
        boolean fresh = needsLink && !keepInputs;
        if (fresh) linkInput.setText("");
        keyInput.setVisibility(needsLink ? View.VISIBLE : View.GONE);
        keyInput.setError(null);
        // The key used before: adding another computer then takes only its address.
        if (fresh) keyInput.setText(prefs.getString(KEY_ACCESS_KEY, ""));
        primaryButton.setEnabled(true);
        boolean hasComputers = !computers.all().isEmpty();
        secondaryButton.setVisibility(hasComputers ? View.VISIBLE : View.GONE);
        secondaryButton.setText(R.string.computers);
        secondaryButton.setOnClickListener(v -> showDevices());
    }

    /**
     * Adds the pasted link's computer, or signs in at a typed address with the access key;
     * for a signed-out computer, a new link or the key (its address is known) signs it in.
     */
    private void connectFromInput(Session signedOut) {
        accessVerified = false;
        String text = linkInput.getText().toString().trim();
        Computers.Computer link = Computers.parseLink(text);
        if (link != null) {
            open(computers.save(link));
            if (signedOut != null && current != null && current.status == Session.Status.SIGNED_OUT) {
                current.connect();
                render();
            }
            return;
        }
        List<String> candidates =
                text.isEmpty() && signedOut != null
                        ? java.util.Collections.singletonList(signedOut.computer.baseUrl)
                        : Computers.addressCandidates(text);
        if (candidates.isEmpty()) {
            linkInput.setError(getString(R.string.invalid_link));
            return;
        }
        String key = keyInput.getText().toString();
        if (key.isEmpty()) {
            keyInput.setError(getString(R.string.key_needed));
            return;
        }
        startPair(candidates, key);
    }

    /** Signs in with the key at the first of the addresses that answers at all. */
    private void startPair(List<String> candidates, String key) {
        primaryButton.setEnabled(false);
        probes.execute(
                () -> {
                    // The first address that answers at all is the computer.
                    String baseUrl = candidates.get(0);
                    PairResult result = null;
                    for (String candidate : candidates) {
                        baseUrl = candidate;
                        result = pair(candidate, key);
                        if (result.status != 0) break;
                    }
                    String answered = baseUrl;
                    PairResult outcome = result;
                    Computers.Computer same =
                            outcome.status == 200 && outcome.token != null
                                    ? sameComputer(answered, outcome.token)
                                    : null;
                    runOnUiThread(() -> onPaired(answered, key, outcome, same));
                });
    }

    /**
     * The saved computer a new sign-in at this address belongs to, if any: one with this
     * address, or one the new token also signs in at (it is the same computer, reached
     * another way, and signing in again replaced the token it had). Off the main thread.
     */
    private Computers.Computer sameComputer(String address, String token) {
        List<Computers.Computer> saved = computers.all();
        for (Computers.Computer computer : saved) {
            if (computer.hasAddress(address)) return computer;
        }
        for (Computers.Computer computer : saved) {
            for (String other : computer.addresses()) {
                if (probeAddress(other, token).state == Reachability.ONLINE) return computer;
            }
        }
        return null;
    }

    /** What a computer answered an access key with. */
    private static final class PairResult {
        /** In place of an HTTP status: Cloudflare Access turned the request away. */
        static final int ACCESS = -1;

        int status;
        String token;
        String name;
        int remaining;
        int retryAfterSeconds;
    }

    /** Signs this phone in at a computer with the access key (`POST /pair`). */
    private PairResult pair(String baseUrl, String key) {
        PairResult result = new PairResult();
        try {
            HttpURLConnection connection =
                    (HttpURLConnection) new URL(baseUrl + "/pair").openConnection();
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(15_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Cookie", CloudflareAccess.cookies(baseUrl, null));
            JSONObject body = new JSONObject();
            body.put("key", key);
            body.put("client", Computers.clientId);
            body.put("name", Computers.deviceName);
            connection.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
            result.status = connection.getResponseCode();
            if (CloudflareAccess.blocked(connection, result.status)) {
                result.status = PairResult.ACCESS;
                connection.disconnect();
                return result;
            }
            InputStream stream =
                    result.status < 400 ? connection.getInputStream() : connection.getErrorStream();
            JSONObject answer = stream == null ? new JSONObject() : new JSONObject(read(stream));
            result.token = answer.optString("token", null);
            result.name = answer.optString("name", null);
            result.remaining = answer.optInt("remaining", 0);
            result.retryAfterSeconds = answer.optInt("retryAfter", 0);
            connection.disconnect();
        } catch (Exception e) {
            result.status = 0;
        }
        return result;
    }

    private void onPaired(
            String baseUrl, String key, PairResult result, Computers.Computer same) {
        if (isDestroyed()) return;
        primaryButton.setEnabled(true);
        if (result.status == 200 && result.token != null && same != null) {
            prefs.edit().putString(KEY_ACCESS_KEY, key).apply();
            if (!same.hasAddress(baseUrl)) {
                Toast.makeText(
                                this,
                                getString(R.string.address_merged, same.label()),
                                Toast.LENGTH_LONG)
                        .show();
            }
            activeAddress.put(same.baseUrl, baseUrl);
            open(computers.addAddress(same, baseUrl, result.token));
            return;
        }
        if (result.status == 200 && result.token != null) {
            prefs.edit().putString(KEY_ACCESS_KEY, key).apply();
            // A name the user gave this computer stays; a new one takes the computer's own.
            String name = result.name;
            for (Computers.Computer known : computers.all()) {
                if (known.baseUrl.equals(baseUrl) && known.name != null) name = known.name;
            }
            open(computers.save(new Computers.Computer(baseUrl, result.token, name)));
            return;
        }
        switch (result.status) {
            case PairResult.ACCESS:
                if (accessVerified) {
                    linkInput.setError(getString(R.string.access_blocked));
                    break;
                }
                verifyAccess(
                        baseUrl,
                        () -> {
                            accessVerified = true;
                            startPair(List.of(baseUrl), key);
                        });
                break;
            case 401:
                keyInput.setError(getString(R.string.key_wrong, result.remaining));
                break;
            case 429:
                keyInput.setError(
                        getString(
                                R.string.key_locked,
                                Math.max(1, (result.retryAfterSeconds + 59) / 60)));
                break;
            case 404:
                linkInput.setError(getString(R.string.key_off));
                break;
            default:
                linkInput.setError(
                        getString(R.string.pair_unreachable, Uri.parse(baseUrl).getAuthority()));
                break;
        }
    }

    /**
     * Shows Cloudflare Access's sign-in for a computer behind it (an email code), then goes
     * on once the page is back on the computer's own, signed in. Back gives up.
     */
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private void verifyAccess(String baseUrl, Runnable then) {
        closeVerifier();
        Toast.makeText(this, R.string.access_needed, Toast.LENGTH_LONG).show();
        WebView web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        // Only signing in happens here: Access, and the sign-in it offers.
                        return false;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        Uri page = Uri.parse(url);
                        if (view != verifier || CloudflareAccess.isSignInPage(page)) return;
                        if (!Session.sameOrigin(page, baseUrl) || !CloudflareAccess.signedIn(baseUrl)) {
                            return;
                        }
                        CookieManager.getInstance().flush();
                        closeVerifier();
                        then.run();
                    }
                });
        verifier = web;
        webContainer.addView(
                web,
                0,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        render();
        web.loadUrl(baseUrl + "/");
    }

    /** Closes Access's sign-in, back to the screen under it as it was left. */
    private void closeVerifier() {
        if (verifier == null) return;
        WebView web = verifier;
        verifier = null;
        webContainer.removeView(web);
        web.destroy();
        if (isDestroyed() || isFinishing()) return;
        keepInputs = true;
        render();
        keepInputs = false;
        primaryButton.setEnabled(true);
    }

    /** This app install's id, made once: one entry in each computer's device list. */
    private String installId() {
        String id = prefs.getString(KEY_INSTALL_ID, null);
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
            prefs.edit().putString(KEY_INSTALL_ID, id).apply();
        }
        return id;
    }

    /** "Google Pixel 9", as computers list this phone. */
    private static String deviceName() {
        String model = Build.MODEL == null ? "" : Build.MODEL;
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        if (maker.isEmpty() || model.toLowerCase().startsWith(maker.toLowerCase())) {
            return model.isEmpty() ? "Android" : model;
        }
        return Character.toUpperCase(maker.charAt(0)) + maker.substring(1) + " " + model;
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
            String address =
                    Uri.parse(activeAddress.getOrDefault(computer.baseUrl, computer.baseUrl))
                            .getAuthority();
            String detail = getString(statusText(state)) + " · " + address;
            int more = computer.addresses().size() - 1;
            if (more > 0) detail += " " + getString(R.string.address_more, more);
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
            case VERIFY:
                return R.string.status_verify;
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
            case VERIFY:
                return R.color.warning;
            default:
                return R.color.muted;
        }
    }

    private void showDeviceMenu(Computers.Computer computer) {
        String[] items = {
            getString(R.string.rename),
            getString(R.string.addresses),
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
                                showAddresses(computer);
                            } else if (which == 2) {
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

    /**
     * A computer's addresses, the one in use marked: tap another to remove it, or add
     * one (where the app reaches it from elsewhere, or a faster way at home).
     */
    private void showAddresses(Computers.Computer computer) {
        Computers.Computer saved = find(computer.baseUrl);
        if (saved == null) return;
        List<String> addresses = saved.addresses();
        String inUse = activeAddress.getOrDefault(saved.baseUrl, saved.baseUrl);
        String[] items = new String[addresses.size()];
        for (int i = 0; i < items.length; i++) {
            String address = addresses.get(i);
            items[i] = Uri.parse(address).getAuthority();
            if (address.startsWith("https://")) items[i] = "https://" + items[i];
            if (address.equals(inUse)) items[i] += " · " + getString(R.string.address_in_use);
        }
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.addresses_of, saved.label()))
                .setItems(
                        items,
                        (dialog, which) -> {
                            String address = addresses.get(which);
                            if (!address.equals(saved.baseUrl)) confirmRemoveAddress(saved, address);
                        })
                .setPositiveButton(R.string.add_address, (dialog, which) -> showAddAddress(saved))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void confirmRemoveAddress(Computers.Computer computer, String address) {
        new AlertDialog.Builder(this)
                .setMessage(getString(R.string.remove_address, Uri.parse(address).getAuthority()))
                .setPositiveButton(
                        R.string.remove,
                        (dialog, which) -> {
                            Computers.Computer updated = computers.removeAddress(computer, address);
                            Session session = sessions.get(computer.baseUrl);
                            if (session != null) {
                                session.computer = updated;
                                if (address.equals(session.address)) session.switchTo(updated.baseUrl);
                            }
                            if (address.equals(activeAddress.get(computer.baseUrl))) {
                                activeAddress.remove(computer.baseUrl);
                            }
                            renderDevices();
                            probe(updated);
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    /** Asks for another address and keeps it once the computer's sign-in works there. */
    private void showAddAddress(Computers.Computer computer) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.address_hint);
        int padding = dp(20);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(padding, dp(8), padding, 0);
        frame.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(R.string.add_address)
                .setView(frame)
                .setPositiveButton(
                        android.R.string.ok,
                        (dialog, which) -> {
                            List<String> candidates =
                                    Computers.addressCandidates(input.getText().toString());
                            if (candidates.isEmpty()) {
                                Toast.makeText(this, R.string.invalid_link, Toast.LENGTH_LONG).show();
                            } else {
                                tryAddress(computer, candidates, true);
                            }
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    /**
     * Checks the computer's sign-in at the first candidate that answers: there, it is
     * the same computer. Behind Cloudflare Access, its sign-in comes first (once).
     */
    private void tryAddress(Computers.Computer computer, List<String> candidates, boolean mayVerify) {
        probes.execute(
                () -> {
                    String address = candidates.get(0);
                    Probe probe = new Probe(Reachability.OFFLINE, null);
                    for (String candidate : candidates) {
                        address = candidate;
                        probe = probeAddress(candidate, computer.token);
                        if (probe.state != Reachability.OFFLINE) break;
                    }
                    String answered = address;
                    Reachability state = probe.state;
                    runOnUiThread(
                            () -> {
                                if (isDestroyed()) return;
                                switch (state) {
                                    case ONLINE:
                                        Computers.Computer updated =
                                                computers.addAddress(computer, answered, computer.token);
                                        Session session = sessions.get(computer.baseUrl);
                                        if (session != null) session.computer = updated;
                                        Toast.makeText(this, R.string.address_added, Toast.LENGTH_LONG)
                                                .show();
                                        renderDevices();
                                        probe(updated);
                                        break;
                                    case VERIFY:
                                        if (mayVerify) {
                                            verifyAccess(
                                                    answered,
                                                    () ->
                                                            tryAddress(
                                                                    computer,
                                                                    List.of(answered),
                                                                    false));
                                        } else {
                                            Toast.makeText(this, R.string.access_blocked, Toast.LENGTH_LONG)
                                                    .show();
                                        }
                                        break;
                                    case SIGNED_OUT:
                                        Toast.makeText(
                                                        this,
                                                        R.string.address_other_computer,
                                                        Toast.LENGTH_LONG)
                                                .show();
                                        break;
                                    default:
                                        Toast.makeText(
                                                        this,
                                                        getString(
                                                                R.string.pair_unreachable,
                                                                Uri.parse(answered).getAuthority()),
                                                        Toast.LENGTH_LONG)
                                                .show();
                                        break;
                                }
                            });
                });
    }

    private Computers.Computer find(String baseUrl) {
        for (Computers.Computer computer : computers.all()) {
            if (computer.baseUrl.equals(baseUrl)) return computer;
        }
        return null;
    }

    private void confirmRemove(Computers.Computer computer) {
        new AlertDialog.Builder(this)
                .setMessage(getString(R.string.remove_confirm, computer.label()))
                .setPositiveButton(
                        R.string.remove,
                        (dialog, which) -> {
                            computers.remove(computer);
                            reachability.remove(computer.baseUrl);
                            activeAddress.remove(computer.baseUrl);
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

    /** What one of a computer's addresses answered. */
    private static final class Probe {
        final Reachability state;
        final String name;

        Probe(Reachability state, String name) {
            this.state = state;
            this.name = name;
        }
    }

    /** The address to use for a computer, and what it answered there. */
    private static final class Choice {
        /** Null when none answered. */
        final String address;
        final Probe probe;

        Choice(String address, Probe probe) {
            this.address = address;
            this.probe = probe;
        }
    }

    /**
     * Asks one address's `/info` whether Emdash is up there and the token signs in; names
     * the computer too. Direct addresses get less time: one out of reach (EasyTier from
     * the mobile network) should not hold up the tunnel behind it. Off the main thread.
     */
    private Probe probeAddress(String address, String token) {
        try {
            HttpURLConnection connection =
                    (HttpURLConnection) new URL(address + "/info").openConnection();
            int timeout = Computers.isDirect(address) ? 2_000 : 5_000;
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Cookie", CloudflareAccess.cookies(address, token));
            int code = connection.getResponseCode();
            Probe probe;
            if (CloudflareAccess.blocked(connection, code)) {
                probe = new Probe(Reachability.VERIFY, null);
            } else if (code == 200) {
                String name = new JSONObject(read(connection.getInputStream())).optString("name", null);
                probe = new Probe(Reachability.ONLINE, name);
            } else {
                probe = new Probe(code == 401 ? Reachability.SIGNED_OUT : Reachability.OFFLINE, null);
            }
            connection.disconnect();
            return probe;
        } catch (Exception e) {
            return new Probe(Reachability.OFFLINE, null);
        }
    }

    /** The first of a computer's addresses, direct ones first, that answers. Off the main thread. */
    private Choice choose(Computers.Computer computer) {
        for (String address : computer.addresses()) {
            Probe probe = probeAddress(address, computer.token);
            if (probe.state != Reachability.OFFLINE) return new Choice(address, probe);
        }
        return new Choice(null, new Probe(Reachability.OFFLINE, null));
    }

    /** Checks how a computer can be reached, and at which address; names it too. */
    private void probe(Computers.Computer computer) {
        probes.execute(
                () -> {
                    Choice choice = choose(computer);
                    runOnUiThread(
                            () -> {
                                if (choice.address != null && !isDestroyed()) {
                                    activeAddress.put(computer.baseUrl, choice.address);
                                }
                                onProbed(computer, choice.probe.state, choice.probe.name);
                            });
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
        // Out of reach where it is: another of its addresses may answer.
        if (session.status == Session.Status.UNREACHABLE) rechoose(session, false);
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
        if (verifier != null) {
            closeVerifier();
        } else if (adding && !computers.all().isEmpty()) {
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
                                    // A nearer address may be in reach now, or the one in use not.
                                    if (current != null) rechoose(current, true);
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
