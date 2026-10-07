package com.emdash.remote;

import android.net.Uri;
import android.webkit.CookieManager;
import java.net.HttpURLConnection;

/**
 * Cloudflare Access in front of a computer (an email code before the page): its sign-in
 * pages, which the app's pages may visit, and its cookie, which the app's own requests
 * (pairing, the list's status checks) carry once a page has signed in.
 */
final class CloudflareAccess {
    private static final String COOKIE = "CF_Authorization";
    /** Emdash's own sign-in cookie, which each request names itself. */
    private static final String EMDASH_COOKIE = "emdash_remote";

    private CloudflareAccess() {}

    /** Access's sign-in pages: the team's own domain, and `/cdn-cgi/access/` on the computer's. */
    static boolean isSignInPage(Uri url) {
        String host = url.getHost();
        String path = url.getPath();
        return (host != null && host.endsWith(".cloudflareaccess.com"))
                || (path != null && path.startsWith("/cdn-cgi/access/"));
    }

    /**
     * Whether Access turned away a request the app made itself (with redirects not
     * followed): it sends it to its sign-in page, or answers 403. Emdash answers neither to
     * the requests the app makes.
     */
    static boolean blocked(HttpURLConnection connection, int code) {
        if (code == 403) return true;
        if (code < 300 || code >= 400) return false;
        String location = connection.getHeaderField("Location");
        return location != null && isSignInPage(Uri.parse(location));
    }

    /** Whether a page has signed in to Access at this computer. */
    static boolean signedIn(String baseUrl) {
        String cookies = CookieManager.getInstance().getCookie(baseUrl);
        return cookies != null && cookies.contains(COOKIE + "=");
    }

    /**
     * The Cookie header for the app's own request to a computer: the pages' cookies for it
     * (Access's among them), and Emdash's sign-in as the given token when there is one.
     */
    static String cookies(String baseUrl, String token) {
        StringBuilder header = new StringBuilder();
        String saved = CookieManager.getInstance().getCookie(baseUrl);
        if (saved != null) {
            for (String cookie : saved.split(";\\s*")) {
                if (cookie.isEmpty() || cookie.startsWith(EMDASH_COOKIE + "=")) continue;
                if (header.length() > 0) header.append("; ");
                header.append(cookie);
            }
        }
        if (token != null) {
            if (header.length() > 0) header.append("; ");
            header.append(EMDASH_COOKIE).append('=').append(token);
        }
        return header.toString();
    }
}
