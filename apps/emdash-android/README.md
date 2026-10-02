# Emdash for Android

Step-by-step setup (in Chinese): [FORK-GUIDE.md](../../FORK-GUIDE.md#五安卓-app).

A small app that opens Emdash's remote access (Settings → Remote access) on a phone, full
screen, without a browser.

- **Stays signed in.** The app keeps each computer's connect link in its own storage and
  signs in again on every start, so a browser clearing cookies can't sign you out. Only
  replacing the link in Emdash does.
- **Several computers.** With more than one, the app opens on a list showing whether each is
  online; tap one to open it, long-press to rename, reload or remove it. A small floating
  button on the page (drag it out of the way) or Back on Emdash's first screen returns to the
  list. Each computer's page stays loaded, so switching back picks up where it was.
- **Downloads.** Long-press a file in Emdash's file tree and choose Download: it is saved to
  the phone's Downloads folder (up to 100 MB a file).
- **Plain HTTP over a private network.** Computers are reached by address on EasyTier,
  Tailscale or the LAN, so HTTP is allowed (no certificate needed).
- **Reconnects by itself.** If a computer can't be reached, the app retries every 10 seconds
  while it is open, and again when the phone's network changes.

## Add a computer

Copy the link from Emdash → Settings → Remote access (`http://address:port/connect?token=…`)
and paste it in the app (a copied link fills in by itself), share it to the app, or tap it
in another app and choose Emdash.

## Build and install

Needs the Android SDK (`ANDROID_HOME`, or Android Studio's default location) and JDK 17+.

```bash
./build.sh            # builds Emdash.apk
./build.sh --install  # and installs it on phones connected to adb
./build.sh --serve    # and serves it, to download and install in the phone's browser
```

The APK is signed with this computer's Android debug key, so later builds install over the
earlier one; a build from another computer needs the app uninstalled first.
