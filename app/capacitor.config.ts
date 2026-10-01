import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.rudeen.pilates',
  appName: 'Rudeen Pilates',
  // Bundled assets, NOT server.url: Apple rejects thin wrappers that merely
  // load a website (Review Guideline 4.2). Trade-off: shipping a change to the
  // store app needs a submission — the web URL stays the fast-moving surface
  // and the admin dashboard should keep living there.
  webDir: 'dist',
  ios: {
    // the app pads itself with env(safe-area-inset-*); letting WKWebView also
    // inset would double the gap under the notch
    contentInset: 'never',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      // show the banner even while the app is in the foreground
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
}

export default config
