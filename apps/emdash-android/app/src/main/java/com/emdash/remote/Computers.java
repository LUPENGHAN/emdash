package com.emdash.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The computers this phone signs in to, each with the token from its connect link. Kept in
 * the app's private storage, which the system never clears on its own (unlike a browser's
 * cookies), so a computer stays signed in until its link is replaced in Emdash.
 */
final class Computers {
    static final class Computer {
        /** The address it was added with, which also names it among the saved ones. */
        final String baseUrl;
        final String token;
        final String name;
        /** Its other addresses (EasyTier, a tunnel…): one sign-in serves them all. */
        final List<String> alternates;

        Computer(String baseUrl, String token, String name) {
            this(baseUrl, token, name, Collections.emptyList());
        }

        Computer(String baseUrl, String token, String name, List<String> alternates) {
            this.baseUrl = baseUrl;
            this.token = token;
            this.name = name;
            this.alternates = Collections.unmodifiableList(new ArrayList<>(alternates));
        }

        /** Every address, the ones reached directly (LAN, EasyTier) before tunnels. */
        List<String> addresses() {
            List<String> direct = new ArrayList<>();
            List<String> tunnels = new ArrayList<>();
            List<String> all = new ArrayList<>();
            all.add(baseUrl);
            all.addAll(alternates);
            for (String address : all) (isDirect(address) ? direct : tunnels).add(address);
            direct.addAll(tunnels);
            return direct;
        }

        boolean hasAddress(String address) {
            return baseUrl.equals(address) || alternates.contains(address);
        }

        /**
         * Signs in at one of its addresses (the server trades the token for its cookie)
         * and opens Emdash. The install's id and the phone's name keep one entry in the
         * computer's device list.
         */
        String connectUrl(String address) {
            return address
                    + "/connect?token="
                    + Uri.encode(token)
                    + "&client="
                    + Uri.encode(clientId)
                    + "&name="
                    + Uri.encode(deviceName);
        }

        String label() {
            return name != null && !name.isEmpty() ? name : Uri.parse(baseUrl).getAuthority();
        }
    }

    /** This app install, and the phone's name, as computers list it among their devices. */
    static String clientId = "";
    static String deviceName = "Android";

    /**
     * Whether an address reaches the computer directly (an IP, a name on the LAN, a
     * port) rather than through a tunnel's HTTPS host name, which is slower.
     */
    static boolean isDirect(String address) {
        Uri uri = Uri.parse(address);
        return "http".equals(uri.getScheme()) || uri.getPort() != -1;
    }

    /** Remote access's default port, for an address typed without one. */
    static final int DEFAULT_PORT = 7788;

    private static final String KEY_LIST = "computers";
    private static final String KEY_CURRENT = "current";

    private final SharedPreferences prefs;

    Computers(Context context) {
        prefs = context.getSharedPreferences("computers", Context.MODE_PRIVATE);
    }

    /**
     * A computer from an Emdash connect link, `http(s)://host:port/connect?token=…`, found
     * anywhere in the text (a shared message often wraps it in other words). Null if none.
     */
    static Computer parseLink(String text) {
        if (text == null) return null;
        for (String word : halfWidth(text).trim().split("\\s+")) {
            Uri uri = Uri.parse(word);
            String scheme = uri.getScheme();
            if (!"http".equals(scheme) && !"https".equals(scheme)) continue;
            if (uri.getAuthority() == null || !"/connect".equals(uri.getPath())) continue;
            String token = uri.getQueryParameter("token");
            if (token == null || token.isEmpty()) continue;
            return new Computer(scheme + "://" + uri.getAuthority(), token, null);
        }
        return null;
    }

    /**
     * A computer's address as typed ("10.126.126.3", "mac.lan:7788", "https://emdash.example.com"):
     * its base URL, plain HTTP and port 7788 unless given. Null if it is not an address.
     */
    static String parseAddress(String text) {
        if (text == null) return null;
        String trimmed = halfWidth(text).trim();
        if (trimmed.isEmpty() || trimmed.contains(" ")) return null;
        Uri uri = Uri.parse(trimmed.contains("://") ? trimmed : "http://" + trimmed);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        int port = uri.getPort();
        if (port == -1 && "http".equals(scheme)) port = DEFAULT_PORT;
        String hostPart = host.contains(":") ? "[" + host + "]" : host;
        return scheme + "://" + hostPart + (port == -1 ? "" : ":" + port);
    }

    /**
     * Text as an address needs it: a Chinese keyboard types "１０。０。２：７７８８" for
     * "10.0.2:7788" (full-width digits, colon and the ideographic full stop).
     */
    static String halfWidth(String text) {
        return java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC)
                .replace('。', '.')
                .replace('｡', '.');
    }

    /**
     * Where a typed address may be served, in the order to try: as given when it names
     * the scheme or port; an IP address on remote access's port; a host name over HTTPS
     * first (a tunnel such as emdash.example.com), then on remote access's port (mac.lan).
     */
    static List<String> addressCandidates(String text) {
        List<String> found = new ArrayList<>();
        String base = parseAddress(text);
        if (base == null) return found;
        String trimmed = halfWidth(text).trim();
        Uri uri = Uri.parse(base);
        boolean named = trimmed.contains("://") || Uri.parse("http://" + trimmed).getPort() != -1;
        boolean ip = uri.getHost().matches("[0-9.]+") || uri.getHost().contains(":");
        if (!named && !ip) found.add("https://" + uri.getHost());
        found.add(base);
        return found;
    }

    List<Computer> all() {
        List<Computer> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(KEY_LIST, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                List<String> alternates = new ArrayList<>();
                JSONArray more = item.optJSONArray("alternates");
                for (int j = 0; more != null && j < more.length(); j++) {
                    alternates.add(more.getString(j));
                }
                list.add(
                        new Computer(
                                item.getString("baseUrl"),
                                item.getString("token"),
                                item.optString("name", null),
                                alternates));
            }
        } catch (JSONException ignored) {
            // Unreadable: start over, as if nothing were saved.
        }
        return list;
    }

    Computer current() {
        List<Computer> list = all();
        String baseUrl = prefs.getString(KEY_CURRENT, null);
        for (Computer computer : list) {
            if (computer.baseUrl.equals(baseUrl)) return computer;
        }
        return list.isEmpty() ? null : list.get(0);
    }

    void select(Computer computer) {
        prefs.edit().putString(KEY_CURRENT, computer.baseUrl).apply();
    }

    /** Adds the computer, or gives a saved one at the same address its new token. */
    Computer save(Computer computer) {
        List<Computer> list = all();
        String name = computer.name;
        for (int i = 0; i < list.size(); i++) {
            Computer saved = list.get(i);
            if (!saved.baseUrl.equals(computer.baseUrl)) continue;
            if (name == null) name = saved.name;
            List<String> alternates = new ArrayList<>(saved.alternates);
            for (String address : computer.alternates) {
                if (!alternates.contains(address)) alternates.add(address);
            }
            Computer updated = new Computer(computer.baseUrl, computer.token, name, alternates);
            list.set(i, updated);
            write(list);
            return updated;
        }
        list.add(computer);
        write(list);
        return computer;
    }

    /** Names a computer as the user likes; an empty name goes back to its own. */
    Computer rename(Computer computer, String name) {
        List<Computer> list = all();
        String trimmed = name.trim();
        for (int i = 0; i < list.size(); i++) {
            if (!list.get(i).baseUrl.equals(computer.baseUrl)) continue;
            Computer saved = list.get(i);
            Computer renamed =
                    new Computer(
                            computer.baseUrl,
                            saved.token,
                            trimmed.isEmpty() ? null : trimmed,
                            saved.alternates);
            list.set(i, renamed);
            write(list);
            return renamed;
        }
        return computer;
    }

    /**
     * Gives a computer another address, and the token it now signs in with (signing in
     * again at the new address replaced the old one).
     */
    Computer addAddress(Computer computer, String address, String token) {
        for (Computer saved : all()) {
            if (!saved.baseUrl.equals(computer.baseUrl)) continue;
            List<String> alternates = new ArrayList<>(saved.alternates);
            if (!saved.hasAddress(address)) alternates.add(address);
            return save(new Computer(saved.baseUrl, token, saved.name, alternates));
        }
        return computer;
    }

    /** Drops one of a computer's other addresses (not the one it was added with). */
    Computer removeAddress(Computer computer, String address) {
        List<Computer> list = all();
        for (int i = 0; i < list.size(); i++) {
            Computer saved = list.get(i);
            if (!saved.baseUrl.equals(computer.baseUrl)) continue;
            List<String> alternates = new ArrayList<>(saved.alternates);
            alternates.remove(address);
            Computer updated = new Computer(saved.baseUrl, saved.token, saved.name, alternates);
            list.set(i, updated);
            write(list);
            return updated;
        }
        return computer;
    }

    void remove(Computer computer) {
        List<Computer> list = all();
        list.removeIf(saved -> saved.baseUrl.equals(computer.baseUrl));
        write(list);
    }

    private void write(List<Computer> list) {
        JSONArray array = new JSONArray();
        try {
            for (Computer computer : list) {
                JSONObject item = new JSONObject();
                item.put("baseUrl", computer.baseUrl);
                item.put("token", computer.token);
                if (computer.name != null) item.put("name", computer.name);
                if (!computer.alternates.isEmpty()) {
                    item.put("alternates", new JSONArray(computer.alternates));
                }
                array.put(item);
            }
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        prefs.edit().putString(KEY_LIST, array.toString()).apply();
    }
}
