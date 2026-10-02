package com.emdash.remote;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Saves files the Emdash page downloads (a project's files, from the computer) into the
 * phone's Downloads folder: a WebView does no downloads of its own. The page sends a file
 * in base64 chunks (see download-file.ts) as `window.EmdashAndroidFiles`.
 */
final class FileBridge {
    private static final class Pending {
        final OutputStream out;
        /** The Downloads entry (Android 10+), or the file (older). */
        final Uri uri;
        final File file;
        final String name;

        Pending(OutputStream out, Uri uri, File file, String name) {
            this.out = out;
            this.uri = uri;
            this.file = file;
            this.name = name;
        }
    }

    private final Context context;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    FileBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public String beginFile(String name, String mimeType) throws IOException {
        String safeName = safeName(name);
        String id = UUID.randomUUID().toString();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver resolver = context.getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Downloads is not available");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) throw new IOException("Downloads is not writable");
            pending.put(id, new Pending(out, uri, null, safeName));
        } else {
            // Before Android 10 the shared Downloads folder needs a permission; the app's
            // own Downloads folder (Android/data/…/files/Download) does not.
            File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) throw new IOException("Downloads is not available");
            File file = uniqueFile(dir, safeName);
            pending.put(id, new Pending(new FileOutputStream(file), null, file, file.getName()));
        }
        return id;
    }

    @JavascriptInterface
    public void appendFile(String id, String base64) throws IOException {
        Pending file = pending.get(id);
        if (file == null) throw new IOException("No such download");
        file.out.write(Base64.decode(base64, Base64.DEFAULT));
    }

    /** Finishes the file; returns where it is, as the user would find it. */
    @JavascriptInterface
    public String endFile(String id) throws IOException {
        Pending file = pending.remove(id);
        if (file == null) throw new IOException("No such download");
        file.out.close();
        if (file.uri == null) return file.file.getAbsolutePath();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        ContentResolver resolver = context.getContentResolver();
        resolver.update(file.uri, values, null, null);
        // Downloads renames a file whose name is taken ("notes (1).md").
        String saved = file.name;
        try (Cursor cursor =
                resolver.query(
                        file.uri, new String[] {MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) saved = cursor.getString(0);
        }
        return Environment.DIRECTORY_DOWNLOADS + "/" + saved;
    }

    @JavascriptInterface
    public void abortFile(String id) {
        Pending file = pending.remove(id);
        if (file == null) return;
        try {
            file.out.close();
        } catch (IOException ignored) {
            // Removed below anyway.
        }
        if (file.uri != null) context.getContentResolver().delete(file.uri, null, null);
        else file.file.delete();
    }

    /** A file name, never a path, and not empty. */
    static String safeName(String name) {
        String base = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (base.isEmpty() || base.equals(".") || base.equals("..")) return "download";
        return base;
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; file.exists(); n++) file = new File(dir, stem + " (" + n + ")" + ext);
        return file;
    }
}
