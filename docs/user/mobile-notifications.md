# Mobile notifications

Get push alerts, Live Activities, and home-screen widgets on iOS and Android when agents finish, fail, or need your approval or input.

## Prerequisites

- Sign in to **T3 Connect** on both your phone and host machine (direct/Tailscale connections alone do not deliver background push notifications, except in a [self-built iOS app](#self-built-ios-app)).
- Enable **Publish agent activity** in **Settings → Sharing & access** on the host.
- Enable **Device Notifications** in **Settings → Notifications** on mobile (Android requires Android 7.0+ and Google Play services).

## Live updates and widgets

- **Live progress**: Enable **Live Activity Updates** (iOS), **Agent Live Updates** (Android 16+, check **Live Update Settings** if missing), or **Ongoing Agent Activity** (older Android). Finished results stay visible for up to 15 minutes.
- **Silent live updates (Android 8+)**: Keep **Ongoing agent activity** on and disable **Agent alerts** in Android system notification settings.
- **iOS widget**: Add the **Agent Activity** widget to your Home Screen or Lock Screen (refreshes when you open T3; marks unfinished work stale after 10 minutes).

## Notes

- Ordinary alerts are muted while the mobile app is in the foreground, though viewing a thread on another device does not silence your phone.
- Force-stopping T3 Code in Android system Settings pauses push delivery until you reopen the app.

## Self-built iOS app

An iOS app you build under your own Apple Developer team receives alerts straight from your environments, without T3 Connect. Live Activity updates are not available in this app.

1. In your Apple Developer account, create a key with **Apple Push Notifications service (APNs)** enabled and download its `.p8` file. Note the key ID and your team ID.
2. On each environment that should send alerts, install the key:

   ```bash
   t3 push key set --key-file <file> --key-id <id> --team-id <team>
   ```

3. In the app, turn on **Device Notifications** in **Settings → Notifications**. Each connected environment shows **Ready** once it can send alerts to this device.

An environment shows **Server has no APNs key** until step 2 is done on it. Turning the switch off, or removing a connected environment from the app, stops its alerts.

Under **Alerts**, choose which kinds this device receives: **Finished**, **Failed**, **Needs approval** and **Needs input**. Each device keeps its own choice.

To change alerts for one thread on every device, touch and hold the thread in the list and choose **More → Notifications**. **All** follows each device's alert choices, **Needs me** sends only approvals and input requests, and **Off** sends nothing for that thread. `t3 push status` on the environment lists each device's alert kinds and the threads not set to **All**.
