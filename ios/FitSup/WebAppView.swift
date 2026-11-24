import SwiftUI
import WebKit
import UserNotifications
import ActivityKit

/// Il sito FitSup dentro una WKWebView, con i dati salvati sul telefono (localStorage persistente).
struct WebAppView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Bridge { Bridge() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "fitsup")

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.06, green: 0.08, blue: 0.09, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true } // ispezionabile da Safari sul Mac
        #endif
        WatchLink.shared.web = web
        WatchLink.shared.start()
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Riceve i messaggi dal sito e programma le notifiche di iOS.
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private let center = UNUserNotificationCenter.current()
    private let prefix = "fitsup.train."
    fileprivate var lastDownload: URL?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "schedule" {
            let enabled = body["enabled"] as? Bool ?? false
            let items = body["items"] as? [[String: Any]] ?? []
            Task { await schedule(enabled: enabled, items: items) }
        }
        if type == "rest", let secs = body["seconds"] as? Double, secs > 0 {
            let title = body["title"] as? String ?? "Recupero finito"
            let text = body["body"] as? String ?? "Vai con la prossima serie."
            Task { await scheduleRest(seconds: secs, title: title, body: text) }
            let name = body["exercise"] as? String ?? ""
            Task { await startRestActivity(seconds: secs, title: name.isEmpty ? "Prossima serie" : name) }
        }
        if type == "watch", let state = body["state"],
           let data = try? JSONSerialization.data(withJSONObject: state),
           let json = String(data: data, encoding: .utf8) {
            WatchLink.shared.send(stateJSON: json)
        }
        if type == "restCancel" {
            center.removePendingNotificationRequests(withIdentifiers: [restId])
            Task { await endRestActivities() }
        }
    }

    private let restId = "fitsup.rest"

    /// Fine del recupero: una notifica con suono all'ora esatta, anche con l'app chiusa o lo schermo bloccato.
    private func scheduleRest(seconds: Double, title: String, body: String) async {
        center.removePendingNotificationRequests(withIdentifiers: [restId])
        // Con l'app dell'orologio aperta vibra già il polso: niente seconda notifica.
        if WatchLink.shared.watchIsActive { return }
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        try? await center.add(UNNotificationRequest(identifier: restId, content: content, trigger: trigger))
    }

    /// Live Activity: conto alla rovescia sulla schermata di blocco e nella Dynamic Island.
    private func startRestActivity(seconds: Double, title: String) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let end = Date().addingTimeInterval(seconds)
        let state = RestAttributes.ContentState(end: end, title: title)
        let content = ActivityContent(state: state, staleDate: end.addingTimeInterval(60))
        if let current = Activity<RestAttributes>.activities.first {
            await current.update(content)
            for other in Activity<RestAttributes>.activities.dropFirst() { await other.end(nil, dismissalPolicy: .immediate) }
        } else {
            _ = try? Activity.request(attributes: RestAttributes(name: "FitSup"), content: content)
        }
    }

    private func endRestActivities() async {
        for a in Activity<RestAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
    }

    /// Un promemoria settimanale per ogni giorno di allenamento con orario.
    /// weekday: 1 = domenica … 7 = sabato (come Calendar di Apple).
    private func schedule(enabled: Bool, items: [[String: Any]]) async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(prefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        guard enabled, !items.isEmpty else { return }

        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return }

        for (i, item) in items.enumerated() {
            guard let weekday = item["weekday"] as? Int,
                  let hour = item["hour"] as? Int,
                  let minute = item["minute"] as? Int else { continue }
            let content = UNMutableNotificationContent()
            content.title = item["title"] as? String ?? "FitSup"
            content.body = item["body"] as? String ?? "È l'ora dell'allenamento."
            content.sound = .default
            var date = DateComponents()
            date.weekday = weekday
            date.hour = hour
            date.minute = minute
            let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: true)
            try? await center.add(UNNotificationRequest(identifier: "\(prefix)\(i)", content: content, trigger: trigger))
        }
    }

    // Link esterni (WhatsApp, YouTube, calendario) si aprono fuori dall'app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }   // esporta scheda, calendario .ics
        guard let url = action.request.url else { return .allow }
        let host = AppConfig.siteURL.host
        if url.scheme == "http" || url.scheme == "https" {
            if url.host == host || action.targetFrame?.isMainFrame == false { return .allow }
            if action.navigationType == .linkActivated || action.targetFrame == nil {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }
        if url.scheme == "blob" || url.scheme == "data" || url.scheme == "about" { return .allow }
        await UIApplication.shared.open(url)
        return .cancel
    }

    // File scaricati dal sito (CSV, file FitSup, calendario): si salvano e si apre «Condividi».
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    // window.open (per esempio WhatsApp) apre l'app esterna.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }
}

extension Bridge: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename)
        lastDownload = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = lastDownload else { return }
        DispatchQueue.main.async {
            let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            let root = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
            share.popoverPresentationController?.sourceView = root?.view
            root?.present(share, animated: true)
        }
    }
}
