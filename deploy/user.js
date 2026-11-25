// Firefox prefs for the dashboard kiosk profile (copied in at every start).
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("full-screen-api.warning.timeout", 0);
// Muted autoplay is allowed anyway; this also lets the unmute click keep playing.
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
// Hardware video decode where the driver allows it.
user_pref("media.ffmpeg.vaapi.enabled", true);
user_pref("media.hardware-video-decoding.force-enabled", true);
// Windowed mode (panel stays visible): userChrome.css hides the browser UI, no client-side titlebar.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.tabs.inTitlebar", 0);
user_pref("sidebar.revamp", false);
user_pref("sidebar.verticalTabs", false);
