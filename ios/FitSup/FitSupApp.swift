import SwiftUI
import UserNotifications

/// App FitSup per iPhone: mostra il sito FitSup (sempre aggiornato) e aggiunge le notifiche di iOS.
/// Il sito parla con l'app tramite `window.webkit.messageHandlers.fitsup`.
@main
struct FitSupApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            WebAppView(url: AppConfig.siteURL)
                .ignoresSafeArea()
                .background(Color(red: 0.06, green: 0.08, blue: 0.09))
        }
    }
}

enum AppConfig {
    /// Indirizzo del sito FitSup su Cloudflare Pages.
    static let siteURL = URL(string: "https://fitme-2e0.pages.dev/")!
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Mostra il promemoria anche se l'app è aperta in primo piano.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
