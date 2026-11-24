import SwiftUI
import UserNotifications

/// App FitSup per Apple Watch: segue l'allenamento aperto in Oggi sull'iPhone.
/// Un tocco su «Serie finita», le ripetizioni con + / − o la Digital Crown, poi il recupero con vibrazione.
@main
struct FitSupWatchApp: App {
    @WKApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
        }
    }
}

final class AppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        c.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Con l'app aperta la vibrazione la fa già WatchModel: niente banner doppio.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }
}
